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

function installSourceRejectingGit(root) {
  const wrap = path.join(root, 'bin');
  mkdirSync(wrap);
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32'
  });
  const realGit = which.stdout.trim().split(/\r?\n/).find(Boolean);
  assert.ok(realGit, 'system git must be discoverable');

  // Cross-platform stub: Node wrapper rejects --source* and otherwise proxies real git.
  const stubJs = path.join(wrap, 'git-stub.mjs');
  writeFileSync(stubJs, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.some((arg) => arg === '--source' || arg.startsWith('--source='))) {
  process.stderr.write("error: unknown option \`source'\\n");
  process.exit(129);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  stdio: 'inherit',
  windowsHide: true,
  env: process.env
});
process.exit(result.status === null ? 1 : result.status);
`);

  if (process.platform === 'win32') {
    // Windows looks up git.cmd / git.exe on PATH, not extensionless scripts.
    writeFileSync(path.join(wrap, 'git.cmd'), `@echo off\r\nnode "${stubJs}" %*\r\n`);
  } else {
    const stub = path.join(wrap, 'git');
    writeFileSync(stub, `#!/usr/bin/env node\nimport(${JSON.stringify(stubJs)}).catch((error) => {\n  console.error(error);\n  process.exit(1);\n});\n`);
    // Simpler: exec the stub js via node shebang-less launcher
    writeFileSync(stub, `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubJs)} "$@"\n`);
    chmodSync(stub, 0o755);
  }
  return wrap;
}

test('working-tree capture fails closed with a named error when git check-attr --source is unsupported', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-buddy-git-source-'));
  temporaryPaths.push(root);
  gitInit(root);
  await writeFile(path.join(root, 'tracked.txt'), 'dirty worktree\n');
  const wrap = installSourceRejectingGit(root);

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
