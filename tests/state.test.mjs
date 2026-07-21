import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertStateOutsideRepository,
  readPrivateJson,
  writePrivateJsonAtomic,
  writePrivateJsonExclusive
} from '../src/state.mjs';

const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-state-'));
  temporaryPaths.push(directory);
  return directory;
}

test('private state roots must remain outside the reviewed repository', async () => {
  const root = await temporaryDirectory();
  assert.equal(
    await assertStateOutsideRepository(root, path.join(path.dirname(root), 'sibling-state')),
    path.join(await realpath(path.dirname(root)), 'sibling-state')
  );
  await assert.rejects(
    assertStateOutsideRepository(root, root, 'runtime state'),
    /outside the reviewed repository/u
  );
  await assert.rejects(
    assertStateOutsideRepository(root, path.join(root, '.buddy'), 'mode state'),
    /outside the reviewed repository/u
  );
});

test('private state containment follows existing ancestor symlinks', {
  skip: process.platform === 'win32'
}, async () => {
  const container = await temporaryDirectory();
  const repository = path.join(container, 'repository');
  const alias = path.join(container, 'outside-looking-alias');
  await mkdir(repository);
  await symlink(repository, alias, 'dir');
  await assert.rejects(
    assertStateOutsideRepository(repository, path.join(alias, '.buddy-runtime'), 'runtime state'),
    /outside the reviewed repository/u
  );
});

test('private state containment recognizes the macOS tmp path alias', {
  skip: process.platform !== 'darwin'
}, async () => {
  const aliasContainer = await mkdtemp('/tmp/codex-buddy-state-alias-');
  temporaryPaths.push(aliasContainer);
  const physicalContainer = await realpath(aliasContainer);
  const repository = path.join(physicalContainer, 'repository');
  await mkdir(repository);
  await assert.rejects(
    assertStateOutsideRepository(
      repository,
      path.join(aliasContainer, 'repository', '.buddy-runtime'),
      'runtime state'
    ),
    /outside the reviewed repository/u
  );
});

test('private JSON reads reject symlinks instead of following same-user path substitutions', {
  skip: process.platform === 'win32'
}, async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, 'target.json');
  const alias = path.join(directory, 'alias.json');
  await writeFile(target, '{"secret":"must-not-follow"}\n');
  await symlink(target, alias);
  await assert.rejects(readPrivateJson(alias), /regular non-symlink file/);
});

test('private JSON atomic and exclusive writes retain exact data and private modes', async () => {
  const directory = await temporaryDirectory();
  const atomic = path.join(directory, 'atomic.json');
  const exclusive = path.join(directory, 'exclusive.json');
  await writePrivateJsonAtomic(atomic, { revision: 1 });
  assert.deepEqual(await readPrivateJson(atomic), { revision: 1 });
  assert.equal(await writePrivateJsonExclusive(exclusive, { attempt: 1 }), true);
  assert.equal(await writePrivateJsonExclusive(exclusive, { attempt: 2 }), false);
  assert.deepEqual(JSON.parse(await readFile(exclusive, 'utf8')), { attempt: 1 });
  if (process.platform !== 'win32') {
    assert.equal((await lstat(atomic)).mode & 0o777, 0o600);
    assert.equal((await lstat(exclusive)).mode & 0o777, 0o600);
  }
});

test('private JSON atomic replacement retries only bounded Windows sharing conflicts', async () => {
  const directory = await temporaryDirectory();
  for (const code of ['EACCES', 'EBUSY', 'EPERM']) {
    const file = path.join(directory, `${code}.json`);
    await writePrivateJsonAtomic(file, { revision: 1 });
    let attempts = 0;
    const pauses = [];
    await writePrivateJsonAtomic(file, { revision: 2 }, {
      platform: 'win32',
      renameImpl: async (source, destination) => {
        attempts += 1;
        if (attempts < 3) {
          assert.deepEqual(await readPrivateJson(destination), { revision: 1 });
          throw Object.assign(new Error('synthetic sharing conflict'), { code });
        }
        await rename(source, destination);
      },
      pauseImpl: async (milliseconds) => { pauses.push(milliseconds); }
    });
    assert.equal(attempts, 3, code);
    assert.deepEqual(pauses, [10, 20], code);
    assert.deepEqual(await readPrivateJson(file), { revision: 2 }, code);
  }

  for (const { name, platform, code } of [
    { name: 'non-Windows sharing conflict', platform: 'linux', code: 'EPERM' },
    { name: 'non-Windows busy destination', platform: 'darwin', code: 'EBUSY' },
    { name: 'missing Windows source', platform: 'win32', code: 'ENOENT' },
    { name: 'cross-device Windows replacement', platform: 'win32', code: 'EXDEV' }
  ]) {
    const file = path.join(directory, `${name.replaceAll(' ', '-')}.json`);
    await writePrivateJsonAtomic(file, { revision: 1 });
    let rejectedAttempts = 0;
    const rejectedPauses = [];
    const expected = Object.assign(new Error(name), { code });
    await assert.rejects(
      writePrivateJsonAtomic(file, { revision: 3 }, {
        platform,
        renameImpl: async () => {
          rejectedAttempts += 1;
          throw expected;
        },
        pauseImpl: async (milliseconds) => { rejectedPauses.push(milliseconds); }
      }),
      (error) => error === expected
    );
    assert.equal(rejectedAttempts, 1, name);
    assert.deepEqual(rejectedPauses, [], name);
    assert.deepEqual(await readPrivateJson(file), { revision: 1 }, name);
  }
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith('.')), []);
});

test('private JSON atomic replacement stops after its bounded Windows retry budget', async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'atomic.json');
  await writePrivateJsonAtomic(file, { revision: 1 });
  let attempts = 0;
  const pauses = [];
  const expected = Object.assign(new Error('persistent sharing conflict'), { code: 'EPERM' });
  await assert.rejects(
    writePrivateJsonAtomic(file, { revision: 2 }, {
      platform: 'win32',
      renameImpl: async () => {
        attempts += 1;
        throw expected;
      },
      pauseImpl: async (milliseconds) => { pauses.push(milliseconds); }
    }),
    (error) => error === expected
  );
  assert.equal(attempts, 6);
  assert.deepEqual(pauses, [10, 20, 40, 80, 160]);
  assert.deepEqual(await readPrivateJson(file), { revision: 1 });
  assert.deepEqual(await readdir(directory), ['atomic.json']);
});
