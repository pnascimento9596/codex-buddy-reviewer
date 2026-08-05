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
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
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

test('working-tree capture fails closed with a named error when git check-attr --source is unsupported', {
  // PATH-level git stubs are unreliable under Windows PATHEXT / Git-for-Windows
  // layout; the production failure path is still exercised on POSIX CI and by the
  // direct source-pin below.
  skip: process.platform === 'win32'
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-buddy-git-source-'));
  temporaryPaths.push(root);
  gitInit(root);
  await writeFile(path.join(root, 'tracked.txt'), 'dirty worktree\n');

  const wrap = path.join(root, 'bin');
  mkdirSync(wrap);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(realGit);
  const stubJs = path.join(wrap, 'git-stub.mjs');
  writeFileSync(stubJs, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.some((arg) => arg === '--source' || arg.startsWith('--source='))) {
  process.stderr.write("error: unknown option \`source'\\n");
  process.exit(129);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit', env: process.env });
process.exit(result.status === null ? 1 : result.status);
`);
  const stub = path.join(wrap, 'git');
  writeFileSync(stub, `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubJs)} "$@"\n`);
  chmodSync(stub, 0o755);

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

test('filter-free-git source maps unknown-option failures to git_version_unsupported', async () => {
  // Direct contract pin: the production catch must recognize Git's unknown-option
  // wording and surface the named privacy-preserving failure code.
  const source = await (await import('node:fs/promises')).readFile(
    new URL('../src/filter-free-git.mjs', import.meta.url),
    'utf8'
  );
  assert.match(source, /failureCode = 'git_version_unsupported'/);
  assert.match(source, /unknown option.*source/);
  assert.match(source, /Git 2\.40\+/);
  // Must not silently swallow historical --source failures.
  assert.doesNotMatch(source, /Older Git: omit the historical attribute source/);
});

test('working-tree capture still merges historical --source attributes when Git supports them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-git-source-ok-'));
  temporaryPaths.push(root);
  gitInit(root);
  await writeFile(path.join(root, 'tracked.txt'), 'dirty worktree\n');
  const inventory = await filterSafeWorkingInventory(root);
  assert.equal(inventory.activeCleanFilters.has('tracked.txt'), true);
});
