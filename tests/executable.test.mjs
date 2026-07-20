import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ExecutableResolutionError,
  assertAbsoluteWindowsExecutablePath,
  resolveExternalExecutable,
  windowsExecutableCandidatePaths,
  windowsPathIsInside
} from '../src/executable.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function enoent() {
  return Object.assign(new Error('not found'), { code: 'ENOENT' });
}

function virtualWindowsFilesystem({ directories = [], files = [], aliases = {} }) {
  const identities = (items) => new Set(items.map((item) => path.win32.normalize(item).toLowerCase()));
  const directorySet = identities(directories);
  const fileSet = identities(files);
  const aliasMap = new Map(Object.entries(aliases).map(([source, target]) => [
    path.win32.normalize(source).toLowerCase(),
    path.win32.normalize(target)
  ]));
  const normalize = (item) => path.win32.normalize(item).toLowerCase();

  return {
    async realpathImpl(item) {
      const identity = normalize(item);
      const target = aliasMap.get(identity);
      if (target) return target;
      if (directorySet.has(identity) || fileSet.has(identity)) return path.win32.normalize(item);
      throw enoent();
    },
    async lstatImpl(item) {
      const identity = normalize(item);
      if (directorySet.has(identity)) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (fileSet.has(identity)) {
        return { isDirectory: () => false, isFile: () => true };
      }
      throw enoent();
    }
  };
}

test('Windows executable candidates ignore cwd, relative or UNC PATH entries, and PATHEXT', () => {
  const common = {
    PATH: '"C:\\Program Files\\Git\\cmd";.;C:\\Tools;;C:relative;\\\\server\\share\\bin;\\\\?\\UNC\\server\\share\\bin',
    PATHEXT: '.CMD;.BAT;.PS1;.EXE'
  };
  assert.deepEqual(windowsExecutableCandidatePaths('git', { env: common }), [
    'C:\\Program Files\\Git\\cmd\\git.com',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Tools\\git.com',
    'C:\\Tools\\git.exe'
  ]);
  assert.deepEqual(
    windowsExecutableCandidatePaths('git', { env: { ...common, PATHEXT: '.JS;.CMD' } }),
    windowsExecutableCandidatePaths('git', { env: common })
  );
});

test('Windows executable candidates reject searched shell shims and relative explicit paths', () => {
  const env = { Path: 'C:\\Tools' };
  assert.throws(() => windowsExecutableCandidatePaths('git.cmd', { env }), /\.exe or \.com/);
  assert.throws(() => windowsExecutableCandidatePaths('git.bat', { env }), /\.exe or \.com/);
  assert.throws(() => windowsExecutableCandidatePaths('..\\git.exe', { env }), /Relative/);
  assert.throws(() => windowsExecutableCandidatePaths('C:git.exe', { env }), /Relative/);
  assert.throws(() => windowsExecutableCandidatePaths('-git', { env }), /option prefix/);
  assert.throws(
    () => windowsExecutableCandidatePaths('git', { env: { Path: 'C:\\Tools', PATH: 'D:\\Tools' } }),
    /exactly one/
  );
});

test('absolute Windows executable validation accepts only local drive-qualified paths', () => {
  assert.equal(assertAbsoluteWindowsExecutablePath('C:\\Tools\\git.exe'), 'C:\\Tools\\git.exe');
  assert.equal(assertAbsoluteWindowsExecutablePath('\\\\?\\C:\\Tools\\tool.exe'), '\\\\?\\C:\\Tools\\tool.exe');
  assert.throws(() => assertAbsoluteWindowsExecutablePath('tool.exe'), /local drive-qualified/);
  assert.throws(() => assertAbsoluteWindowsExecutablePath('\\tool.exe'), /local drive-qualified/);
  assert.throws(() => assertAbsoluteWindowsExecutablePath('\\\\server\\share\\tool.com'), /local drive-qualified/);
  assert.throws(
    () => assertAbsoluteWindowsExecutablePath('\\\\?\\UNC\\server\\share\\tool.exe'),
    /local drive-qualified/
  );
  assert.throws(() => assertAbsoluteWindowsExecutablePath('\\\\.\\C:\\Tools\\tool.exe'), /local drive-qualified/);
  assert.throws(() => assertAbsoluteWindowsExecutablePath('C:\\Tools\\tool.cmd'), /\.exe or \.com/);
});

test('Windows containment comparison is case-insensitive and segment-aware', () => {
  assert.equal(windowsPathIsInside('C:\\Work\\Repo', 'c:\\work\\repo\\git.exe'), true);
  assert.equal(windowsPathIsInside('C:\\Work\\Repo', '\\\\?\\C:\\Work\\Repo\\git.exe'), true);
  assert.equal(
    windowsPathIsInside('\\\\server\\share\\Repo', '\\\\?\\UNC\\server\\share\\Repo\\git.exe'),
    true
  );
  assert.equal(windowsPathIsInside('C:\\Work\\Repo', 'C:\\Work\\Repository\\git.exe'), false);
  assert.equal(windowsPathIsInside('C:\\Work\\Repo', 'D:\\Tools\\git.exe'), false);
});

test('Windows resolution skips lexical and canonical repository targets before selecting PATH', async () => {
  const cwd = 'C:\\Work\\Repo';
  const trusted = 'C:\\Trusted\\git.exe';
  const filesystem = virtualWindowsFilesystem({
    directories: [cwd],
    files: ['C:\\Work\\Repo\\git.exe', trusted],
    aliases: { 'C:\\Alias\\git.com': 'C:\\Work\\Repo\\git.exe' }
  });
  const resolved = await resolveExternalExecutable('git', {
    platform: 'win32',
    cwd,
    env: { PATH: 'C:\\Work\\Repo;C:\\Alias;C:\\Trusted' },
    ...filesystem
  });
  assert.equal(resolved, trusted);
});

test('Windows resolution rejects an explicit executable inside cwd and reports missing tools as ENOENT', async () => {
  const cwd = 'C:\\Work\\Repo';
  const local = 'C:\\Work\\Repo\\git.exe';
  const filesystem = virtualWindowsFilesystem({ directories: [cwd], files: [local] });
  await assert.rejects(
    resolveExternalExecutable(local, { platform: 'win32', cwd, env: { PATH: 'C:\\Tools' }, ...filesystem }),
    (error) => error instanceof ExecutableResolutionError && error.code === 'EINVAL'
  );
  await assert.rejects(
    resolveExternalExecutable('git', { platform: 'win32', cwd, env: { PATH: 'C:\\Tools' }, ...filesystem }),
    (error) => error instanceof ExecutableResolutionError && error.code === 'ENOENT'
  );
});

test('non-Windows resolution preserves the existing command contract', async () => {
  assert.equal(await resolveExternalExecutable('git', { platform: 'linux' }), 'git');
});

test('runtime and release launch boundaries route searched Windows commands through the resolver', async () => {
  const [processSource, publicReleaseSource, boundaryCheckSource] = await Promise.all([
    readFile(path.join(repositoryRoot, 'src', 'process.mjs'), 'utf8'),
    readFile(path.join(repositoryRoot, 'scripts', 'lib', 'public-release.mjs'), 'utf8'),
    readFile(path.join(repositoryRoot, 'scripts', 'check-public-release.mjs'), 'utf8')
  ]);
  assert.match(processSource, /resolveExternalExecutable\(command,/u);
  for (const source of [publicReleaseSource, boundaryCheckSource]) {
    assert.match(source, /resolveExternalExecutable\(command,/u);
    assert.doesNotMatch(source, /execFileAsync\(\s*['"]git['"]/u);
  }
});
