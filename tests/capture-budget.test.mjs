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

test('capture progress re-arm is limited to eight 30-second responsive graces', () => {
  let monotonicNow = 0;
  const budget = new CaptureBudget({
    deadlineMs: 60_000,
    startedAt: 0,
    now: () => monotonicNow,
    maxPaths: 20
  });
  budget.chargePaths(1);
  monotonicNow = 60_001;
  for (let rearm = 0; rearm < 8; rearm += 1) {
    assert.doesNotThrow(() => budget.remainingMs());
    budget.chargePaths(1);
    monotonicNow += 30_001;
  }
  assert.throws(() => budget.remainingMs(), (error) => {
    assert.equal(captureFailureCode(error), 'capture_deadline_exceeded');
    return true;
  });
});

test('completed capture work can re-arm when its charge lands after the grace boundary', () => {
  let monotonicNow = 0;
  const budget = new CaptureBudget({
    deadlineMs: 60_000,
    startedAt: 0,
    now: () => monotonicNow,
    maxFileBytes: 10
  });
  budget.chargeFileBytes(1);
  monotonicNow = 60_001;
  assert.doesNotThrow(() => budget.remainingMs());

  // Model a productive read that began within the grace and completed after
  // it. The completed bytes are proof of progress and must win over the stale
  // deadline observation made when the operation reports its charge.
  monotonicNow += 30_001;
  assert.doesNotThrow(() => budget.chargeFileBytes(1));
  assert.equal(budget.snapshot().fileBytes, 2);
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

test('manual capture uses the shorter existing reviewer timeout as its deadline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'buddy-budget-review-timeout-'));
  try {
    await runProcess('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await runProcess('git', ['config', 'user.name', 'Buddy Test'], { cwd: root });
    await runProcess('git', ['config', 'user.email', 'buddy@example.invalid'], { cwd: root });
    await writeFile(path.join(root, 'base.js'), 'export const base = true;\n');
    await runProcess('git', ['add', 'base.js'], { cwd: root });
    await runProcess('git', ['commit', '-q', '-m', 'base'], { cwd: root });
    await assert.rejects(
      collectEvidence({ cwd: root, timeoutMs: 5, budgetOptions: { startedAt: -100 } }),
      (error) => captureFailureCode(error) === 'capture_deadline_exceeded'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('large branch capture completes through bounded progress beyond its initial deadline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'buddy-budget-large-branch-'));
  const changedPaths = Array.from({ length: 51 }, (_, index) => `module-${String(index).padStart(2, '0')}.js`);
  try {
    await runProcess('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await runProcess('git', ['config', 'user.name', 'Buddy Test'], { cwd: root });
    await runProcess('git', ['config', 'user.email', 'buddy@example.invalid'], { cwd: root });
    await Promise.all(changedPaths.map((repoPath, index) => writeFile(
      path.join(root, repoPath),
      `export const value${index} = ${index};\n${'// baseline evidence line\n'.repeat(35)}`
    )));
    await runProcess('git', ['add', '--', ...changedPaths], { cwd: root });
    await runProcess('git', ['commit', '-q', '-m', 'base'], { cwd: root });
    const base = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await Promise.all(changedPaths.map((repoPath, index) => writeFile(
      path.join(root, repoPath),
      `export const value${index} = ${index + 1};\n${'// changed evidence line\n'.repeat(35)}`
    )));
    await runProcess('git', ['add', '--', ...changedPaths], { cwd: root });
    await runProcess('git', ['commit', '-q', '-m', 'changed'], { cwd: root });

    let monotonicNow = 0;
    const evidence = await collectEvidence({
      cwd: root,
      scope: 'branch',
      base,
      budgetOptions: {
        deadlineMs: 180_000,
        startedAt: 0,
        now: () => {
          monotonicNow += 400;
          return monotonicNow;
        }
      }
    });

    assert.equal(evidence.changed_paths.length, changedPaths.length);
    assert.equal(evidence.incomplete_paths.length, 0);
    assert.equal(monotonicNow > 180_000, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
