#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { resolveExternalExecutable } from '../src/executable.mjs';
import { buildPublicPlugin } from './lib/public-release.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-public-check-'));
const sourceSnapshot = path.join(temporaryRoot, 'source');
const artifact = path.join(temporaryRoot, 'artifact');
const codexHome = path.join(temporaryRoot, 'codex-home');
const dataDir = path.join(temporaryRoot, 'data');

async function execResolvedFile(command, args, options = {}) {
  const resolved = await resolveExternalExecutable(command, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env
  });
  return execFileAsync(resolved, args, options);
}

async function run(relative, args) {
  return execFileAsync(process.execPath, [path.join(artifact, relative), ...args], {
    cwd: artifact,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
}

async function runTrustedSource(relative, args) {
  return execFileAsync(process.execPath, [path.join(sourceSnapshot, relative), ...args], {
    cwd: sourceSnapshot,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
}

async function prepareCleanSourceSnapshot() {
  await cp(projectRoot, sourceSnapshot, {
    recursive: true,
    filter: (candidate) => {
      const relative = path.relative(projectRoot, candidate);
      if (!relative) return true;
      return !new Set(['.git', 'node_modules', 'prompt-exports']).has(relative.split(path.sep)[0]);
    }
  });
  await execResolvedFile('git', ['init', '--quiet'], { cwd: sourceSnapshot, windowsHide: true });
  await execResolvedFile('git', ['add', '--all', '--force'], { cwd: sourceSnapshot, windowsHide: true });
  await execResolvedFile('git', [
    '-c', 'user.name=Buddy Boundary Check',
    '-c', 'user.email=buddy-boundary-check@example.invalid',
    'commit', '--quiet', '--message', 'isolated public boundary snapshot'
  ], {
    cwd: sourceSnapshot,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
    },
    windowsHide: true
  });
}

try {
  // Development validation may run while the real checkout is intentionally
  // dirty. Build from a temporary committed snapshot so the artifact still has
  // honest commit provenance without weakening the release builder.
  await prepareCleanSourceSnapshot();
  const result = await buildPublicPlugin({ output: artifact, sourceRoot: sourceSnapshot });
  await runTrustedSource('scripts/verify-public-plugin.mjs', [
    '--input', artifact,
    '--policy-root', sourceSnapshot,
    '--json'
  ]);
  await run('scripts/buddy-review.mjs', ['pet', 'list', '--json']);
  await run('scripts/validate-pet-atlases.mjs', ['--json']);
  await run('scripts/buddy-eval.mjs', ['validate', '--json']);
  await run('scripts/buddy-review.mjs', ['--help']);
  const catalog = JSON.parse(await readFile(path.join(artifact, 'assets', 'pets', 'catalog.json'), 'utf8'));
  for (const entry of catalog.pets) {
    await run('scripts/buddy-review.mjs', [
      'pet', 'install', entry.id,
      '--codex-home', codexHome,
      '--data-dir', dataDir,
      '--json'
    ]);
  }
  process.stdout.write(`Public release boundary verified from an isolated clean snapshot (${result.file_count} files).\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
