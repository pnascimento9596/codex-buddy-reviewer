import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CaptureBudget, CaptureBudgetError, captureFailureCode } from '../src/capture-budget.mjs';
import { collectEvidence } from '../src/evidence.mjs';
import { runProcess } from '../src/process.mjs';
import { captureTurnSnapshot } from '../src/turn-snapshot.mjs';

test('capture budgets account cumulatively with privacy-safe failure codes', () => {
  const budget = new CaptureBudget({
    deadlineMs: 10_000,
    maxPaths: 2,
    maxFileBytes: 4,
    maxGitBytes: 4,
    maxGitInputBytes: 4,
    maxObjectBytes: 4,
    maxGitOperations: 2
  });
  budget.chargePaths(1);
  budget.chargePaths(1);
  assert.throws(() => budget.chargePaths(1), (error) => {
    assert.equal(error instanceof CaptureBudgetError, true);
    assert.equal(error.code, 'capture_path_limit_exceeded');
    assert.equal(error.message, 'capture_path_limit_exceeded');
    return true;
  });
});

test('capture deadlines use an injected monotonic start and expose no repository data', () => {
  const budget = new CaptureBudget({ deadlineMs: 5, startedAt: -100 });
  assert.throws(() => budget.remainingMs(), (error) => {
    assert.equal(captureFailureCode(error), 'capture_deadline_exceeded');
    assert.doesNotMatch(error.message, /path|secret|repository/i);
    return true;
  });
});

test('capture budget snapshots contain only bounded numeric counters', () => {
  const budget = new CaptureBudget({ deadlineMs: 10_000 });
  budget.chargeGitOperation();
  budget.chargeGitBytes(12);
  assert.deepEqual(Object.keys(budget.snapshot()).sort(), [
    'elapsed_ms', 'fileBytes', 'gitBytes', 'gitInputBytes', 'gitOperations', 'objectBytes', 'paths'
  ].sort());
});

test('stable turn capture charges both passes and removes newly-created private state on failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'buddy-budget-repo-'));
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), 'buddy-budget-state-'));
  const workDir = path.join(privateRoot, 'snapshot');
  try {
    await runProcess('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await runProcess('git', ['config', 'user.name', 'Buddy Test'], { cwd: root });
    await runProcess('git', ['config', 'user.email', 'buddy@example.invalid'], { cwd: root });
    await writeFile(path.join(root, 'base.js'), 'export const base = true;\n');
    await runProcess('git', ['add', 'base.js'], { cwd: root });
    await runProcess('git', ['commit', '-q', '-m', 'base'], { cwd: root });
    await writeFile(path.join(root, 'new.js'), '1234567890');

    await assert.rejects(
      captureTurnSnapshot({
        root,
        workDir,
        budgetOptions: { maxFileBytes: 15 }
      }),
      (error) => captureFailureCode(error) === 'capture_file_bytes_exceeded'
    );
    await assert.rejects(access(workDir));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test('manual stable evidence capture shares the same aggregate two-pass byte budget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'buddy-budget-manual-'));
  try {
    await runProcess('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await runProcess('git', ['config', 'user.name', 'Buddy Test'], { cwd: root });
    await runProcess('git', ['config', 'user.email', 'buddy@example.invalid'], { cwd: root });
    await writeFile(path.join(root, 'base.js'), 'export const base = true;\n');
    await runProcess('git', ['add', 'base.js'], { cwd: root });
    await runProcess('git', ['commit', '-q', '-m', 'base'], { cwd: root });
    await writeFile(path.join(root, 'new.js'), '1234567890');
    await assert.rejects(
      collectEvidence({ cwd: root, budgetOptions: { maxFileBytes: 25 } }),
      (error) => captureFailureCode(error) === 'capture_file_bytes_exceeded'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
