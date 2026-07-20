import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectEvidence } from '../src/evidence.mjs';
import { captureTurnStart, reviewTurnStop } from '../src/lifecycle.mjs';
import { changeMode } from '../src/mode.mjs';
import { runProcess } from '../src/process.mjs';

const temporaryPaths = [];
const linuxOnly = { skip: process.platform !== 'linux' };

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function git(root, args) {
  return runProcess('git', args, { cwd: root });
}

async function makeRepository() {
  const root = await temporaryDirectory('codex-buddy-linux-path-repo-');
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Buddy Test']);
  await git(root, ['config', 'user.email', 'buddy@example.invalid']);
  await writeFile(path.join(root, 'app.js'), 'const value = 1;\n');
  await git(root, ['add', 'app.js']);
  await git(root, ['commit', '-q', '-m', 'initial']);
  return realpath(root);
}

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(target));
    else output.push(target);
  }
  return output;
}

function invalidPath(root) {
  return Buffer.concat([
    Buffer.from(`${root}${path.sep}ordinary-`),
    Buffer.from([0xff]),
    Buffer.from('.js')
  ]);
}

async function assertInvalidPathFailure(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.failureCode, 'git_path_encoding_invalid');
    return true;
  });
}

test('native Linux manual evidence rejects an ordinary invalid-byte working path', linuxOnly, async () => {
  const root = await makeRepository();
  await writeFile(invalidPath(root), 'export const unsafeName = true;\n');

  await assertInvalidPathFailure(collectEvidence({ cwd: root, scope: 'working-tree' }));
});

test('native Linux branch evidence rejects a committed invalid-byte path', linuxOnly, async () => {
  const root = await makeRepository();
  const base = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(invalidPath(root), 'export const unsafeName = true;\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'add path encoding fixture']);

  await assertInvalidPathFailure(collectEvidence({ cwd: root, scope: 'branch', base }));
});

test('native Linux automatic stop terminalizes invalid path capture with zero provider egress', linuxOnly, async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-linux-path-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-linux-path-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = {
    session_id: 'linux-path-session',
    turn_id: 'linux-path-turn',
    cwd: root
  };
  const started = await captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Exercise strict pathname capture.'
  }, { modeDataDir, runtimeDataDir });
  assert.equal(started.skipped, undefined);

  await writeFile(invalidPath(root), 'export const unsafeName = true;\n');
  let reviewCalls = 0;
  const failed = await reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Implemented the requested change.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async () => {
      reviewCalls += 1;
      throw new Error('provider callback must not run');
    }
  });

  assert.equal(reviewCalls, 0);
  assert.equal(failed.reviewKey, null);
  assert.equal(failed.receipt, null);
  assert.equal(failed.error?.failureCode, 'git_path_encoding_invalid');
  assert.match(failed.output.systemMessage, /snapshot stage/u);

  const completedFile = (await filesBelow(runtimeDataDir))
    .find((file) => file.endsWith(`${path.sep}completed.json`));
  assert.ok(completedFile);
  const terminal = JSON.parse(await readFile(completedFile, 'utf8'));
  assert.equal(terminal.terminal_status, 'snapshot_error');
  assert.equal(terminal.failure_code, 'git_path_encoding_invalid');
});

test('native Linux preserves a legitimate UTF-8 replacement-character path', linuxOnly, async () => {
  const root = await makeRepository();
  const replacementPath = 'valid-\ufffd.txt';
  await writeFile(path.join(root, replacementPath), 'valid UTF-8 filename\n');

  const working = await collectEvidence({ cwd: root, scope: 'working-tree' });
  assert.ok(working.changed_paths.includes(replacementPath));

  const base = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(root, ['add', replacementPath]);
  await git(root, ['commit', '-q', '-m', 'add valid UTF-8 path']);
  const branch = await collectEvidence({ cwd: root, scope: 'branch', base });
  assert.ok(branch.changed_paths.includes(replacementPath));
});
