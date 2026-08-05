import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { filterSafeWorkingInventory } from '../src/filter-free-git.mjs';

const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

function gitInit(root) {
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  };
  run(['init', '--quiet']);
  run(['config', 'user.email', 'buddy-filter-test@example.invalid']);
  run(['config', 'user.name', 'Buddy Filter Test']);
  writeFileSync(path.join(root, 'tracked.txt'), 'baseline\n');
  writeFileSync(path.join(root, '.gitattributes'), '*.txt filter=ident\n');
  run(['add', '--', 'tracked.txt', '.gitattributes']);
  run(['commit', '--quiet', '-m', 'baseline']);
}

test('working-tree capture fails closed with a named error when git check-attr --source is unsupported', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-buddy-git-source-'));
  temporaryPaths.push(root);
  gitInit(root);
  await writeFile(path.join(root, 'tracked.txt'), 'dirty worktree\n');

  const wrap = path.join(root, 'bin');
  mkdirSync(wrap);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(realGit);
  writeFileSync(path.join(wrap, 'git'), `#!/bin/bash
for arg in "$@"; do
  if [[ "$arg" == --source=* || "$arg" == --source ]]; then
    echo "error: unknown option \\\`source'" >&2
    exit 129
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`);
  chmodSync(path.join(wrap, 'git'), 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${wrap}${path.delimiter}${previousPath}`;
  try {
    await assert.rejects(
      filterSafeWorkingInventory(root),
      (error) => error?.failureCode === 'git_version_unsupported'
        && /Git 2\.40\+/.test(error.message)
        && /check-attr --source/.test(error.message)
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test('working-tree capture still merges historical --source attributes when Git supports them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-git-source-ok-'));
  temporaryPaths.push(root);
  gitInit(root);
  await writeFile(path.join(root, 'tracked.txt'), 'dirty worktree\n');
  const inventory = await filterSafeWorkingInventory(root);
  assert.equal(inventory.activeCleanFilters.has('tracked.txt'), true);
});
