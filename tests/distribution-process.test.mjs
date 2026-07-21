import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { DISTRIBUTION_TEST_ONLY } from '../scripts/lib/distribution-commit.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('distribution Git timeout waits for child close before rejecting', async () => {
  const child = fakeChild();
  let settled = false;
  const observed = DISTRIBUTION_TEST_ONLY.runGit('git', ['status'], {
    cwd: process.cwd(),
    repository: process.cwd(),
    timeoutMs: 5,
    reapTimeoutMs: 100,
    finalReapTimeoutMs: 100,
    spawnImpl: () => child
  }).then(
    (value) => ({ value }),
    (error) => ({ error })
  ).finally(() => {
    settled = true;
  });

  await delay(25);
  assert.equal(child.killCalls, 1);
  assert.equal(settled, false);
  child.emit('close', null, 'SIGKILL');

  const result = await observed;
  assert.match(result.error.message, /local validation deadline/);
  assert.equal(result.error.reapConfirmed, true);
});

test('distribution Git timeout has a bounded unreaped-child fallback', async () => {
  const child = fakeChild();
  const keepAlive = setTimeout(() => {}, 1_000);
  let result;
  try {
    result = await DISTRIBUTION_TEST_ONLY.runGit('git', ['status'], {
      cwd: process.cwd(),
      repository: process.cwd(),
      timeoutMs: 5,
      reapTimeoutMs: 10,
      finalReapTimeoutMs: 10,
      spawnImpl: () => child
    }).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
  } finally {
    clearTimeout(keepAlive);
  }

  assert.match(result.error.message, /local validation deadline/);
  assert.equal(result.error.reapConfirmed, false);
  assert.equal(child.killCalls, 2);
});

test('distribution Git early stdin close preserves the authoritative child result', async () => {
  const child = fakeChild();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error('synthetic early close'), { code: 'EPIPE' }));
    }
  });
  const observed = DISTRIBUTION_TEST_ONLY.runGit('git', ['update-index'], {
    cwd: process.cwd(),
    repository: process.cwd(),
    input: Buffer.alloc(128 * 1024),
    timeoutMs: 1_000,
    spawnImpl: () => child
  }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );

  await delay(10);
  child.exitCode = 7;
  child.emit('close', 7, null);

  const result = await observed;
  assert.match(result.error.message, /Git command failed with status 7/u);
  assert.doesNotMatch(result.error.message, /synthetic early close/u);
  assert.equal(result.error.reapConfirmed, true);
  assert.equal(child.killCalls, 0);
});

test('distribution Git unexpected stdin failure waits for child close', async () => {
  const child = fakeChild();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error('synthetic stdin failure'), { code: 'EIO' }));
    }
  });
  let settled = false;
  const observed = DISTRIBUTION_TEST_ONLY.runGit('git', ['update-index'], {
    cwd: process.cwd(),
    repository: process.cwd(),
    input: Buffer.alloc(128 * 1024),
    timeoutMs: 1_000,
    reapTimeoutMs: 100,
    finalReapTimeoutMs: 100,
    spawnImpl: () => child
  }).then(
    (value) => ({ value }),
    (error) => ({ error })
  ).finally(() => {
    settled = true;
  });

  await delay(10);
  assert.equal(child.killCalls, 1);
  assert.equal(settled, false);
  child.signalCode = 'SIGKILL';
  child.emit('close', null, 'SIGKILL');

  const result = await observed;
  assert.equal(result.error.code, 'EIO');
  assert.match(result.error.message, /synthetic stdin failure/u);
  assert.equal(result.error.reapConfirmed, true);
});

test('distribution cleanup uses bounded recursive retries', async () => {
  const primary = new Error('primary Git failure');
  Object.defineProperty(primary, 'reapConfirmed', { value: true });
  let call;
  const result = await DISTRIBUTION_TEST_ONLY.cleanupFailedDistribution(
    '/synthetic/distribution',
    primary,
    async (target, options) => {
      call = { target, options };
    }
  );

  assert.equal(result, primary);
  assert.equal(call.target, '/synthetic/distribution');
  assert.deepEqual(call.options, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  });
});

test('distribution cleanup never masks the primary failure', async () => {
  const primary = new Error('primary Git failure');
  Object.defineProperty(primary, 'reapConfirmed', { value: true });
  const cleanup = Object.assign(new Error('private temporary path'), { code: 'EBUSY' });
  const result = await DISTRIBUTION_TEST_ONLY.cleanupFailedDistribution(
    '/synthetic/distribution',
    primary,
    async () => {
      throw cleanup;
    }
  );

  assert.match(result.message, /^primary Git failure; partial output cleanup also failed \(EBUSY\)$/u);
  assert.equal(result.cause, primary);
  assert.equal(result.cleanupError, cleanup);
  assert.doesNotMatch(result.message, /private temporary path/u);
});

test('distribution cleanup preserves partial output when reap is unconfirmed', async () => {
  const primary = new Error('primary Git failure');
  Object.defineProperty(primary, 'reapConfirmed', { value: false });
  let removeCalls = 0;
  const result = await DISTRIBUTION_TEST_ONLY.cleanupFailedDistribution(
    '/synthetic/distribution',
    primary,
    async () => {
      removeCalls += 1;
    }
  );

  assert.equal(removeCalls, 0);
  assert.match(result.message, /^primary Git failure; partial output was preserved/u);
  assert.equal(result.cause, primary);
  assert.equal(result.reapConfirmed, false);
});
