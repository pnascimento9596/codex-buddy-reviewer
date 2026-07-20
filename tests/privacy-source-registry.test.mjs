import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPrivacyFragmentSalt } from '../src/privacy-fragments.mjs';
import { captureLiveGitPrivacySources } from '../src/privacy-source-registry.mjs';
import { readStableRegularFile } from '../src/stable-source-read.mjs';

const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'buddy-stable-source-'));
  temporaryPaths.push(directory);
  return directory;
}

test('stable privacy source reads distinguish optional absence and unsafe types', async () => {
  const root = await temporaryDirectory();
  assert.deepEqual(await readStableRegularFile(path.join(root, 'absent'), { optional: true }), {
    status: 'absent',
    reason: null,
    bytes: null
  });
  await writeFile(path.join(root, 'target'), 'private');
  await symlink('target', path.join(root, 'link'));
  assert.deepEqual(await readStableRegularFile(path.join(root, 'link'), { optional: true }), {
    status: 'incomplete',
    reason: 'source_type_unsupported',
    bytes: null
  });
});

test('stable privacy source reads fail closed on mid-read mutation and size overflow', async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, 'config');
  await writeFile(file, 'first-value');
  const raced = await readStableRegularFile(file, {
    afterOpen: () => writeFile(file, 'second-value-with-different-size')
  });
  assert.equal(raced.status, 'incomplete');
  assert.equal(raced.reason, 'source_changed');
  assert.deepEqual(await readStableRegularFile(file, { maxBytes: 4 }), {
    status: 'incomplete',
    reason: 'source_size_exceeded',
    bytes: null
  });
});

test('stable privacy source reads cap growth during the read', async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, 'config');
  await writeFile(file, 'tiny');
  assert.deepEqual(await readStableRegularFile(file, {
    maxBytes: 4,
    afterOpen: () => writeFile(file, 'value-that-grew-past-the-cap')
  }), {
    status: 'incomplete',
    reason: 'source_size_exceeded',
    bytes: null
  });
});

test('live Git registry requires common config but permits absent worktree config', async () => {
  const root = await temporaryDirectory();
  const common = path.join(root, 'common-config');
  const worktree = path.join(root, 'worktree-config');
  const runGit = async (_root, args) => ({
    stdout: `${args.at(-1) === 'config' ? common : worktree}\n`
  });
  const missing = await captureLiveGitPrivacySources({
    root,
    privacySalt: createPrivacyFragmentSalt(),
    runGit
  });
  assert.equal(missing.complete, false);
  assert.equal(missing.coverage.incomplete_reason, 'source_unreadable');

  await writeFile(common, '[core]\n\trepositoryformatversion = 0\n');
  const complete = await captureLiveGitPrivacySources({
    root,
    privacySalt: createPrivacyFragmentSalt(),
    runGit
  });
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.coverage.completed_source_classes, [
    'git_common_config',
    'git_worktree_config'
  ]);
});
