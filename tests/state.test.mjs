import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
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
