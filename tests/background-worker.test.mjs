import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { launchPreReviewWorker } from '../src/background-worker.mjs';

test('public artifact includes the detached pre-review worker entrypoint', async () => {
  const config = JSON.parse(await readFile(
    new URL('../release/public-files.json', import.meta.url),
    'utf8'
  ));
  const worker = config.files.find((entry) => entry.source === 'scripts/buddy-pre-review-worker.mjs');
  assert.deepEqual(worker, {
    source: 'scripts/buddy-pre-review-worker.mjs',
    destination: 'scripts/buddy-pre-review-worker.mjs'
  });
});

function regularFile() {
  return { isFile: () => true, isSymbolicLink: () => false };
}

function fakeChild(onInput) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = {
    end(value, callback) {
      onInput(value);
      callback();
    }
  };
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

test('background worker uses an absolute non-shell entrypoint and sanitized environment', async () => {
  let spawnArguments;
  let input;
  let child;
  const result = await launchPreReviewWorker({ worker_nonce: 'a'.repeat(48) }, {
    executable: '/opt/node/bin/node',
    workerFile: '/opt/buddy/scripts/pre-review.mjs',
    ambientEnvironment: {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require=/tmp/inject.cjs',
      NODE_PATH: '/tmp/modules',
      NODE_REPL_HISTORY: '/tmp/history',
      NODE_INSPECT_RESUME_ON_START: '1',
      PROVIDER_CONNECTION: 'ambient-runtime-connection'
    },
    lstatImpl: async () => regularFile(),
    spawnImpl: (...args) => {
      spawnArguments = args;
      child = fakeChild((value) => { input = value; });
      return child;
    }
  });

  assert.equal(result.pid, 4242);
  assert.equal(child.unrefCalled, true);
  assert.deepEqual(spawnArguments.slice(0, 2), [
    '/opt/node/bin/node',
    ['/opt/buddy/scripts/pre-review.mjs']
  ]);
  const options = spawnArguments[2];
  assert.equal(options.shell, false);
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(options.env.CODEX_BUDDY_SUPPRESS_HOOKS, '1');
  assert.equal(options.env.PATH, '/usr/bin');
  assert.equal(options.env.PROVIDER_CONNECTION, 'ambient-runtime-connection');
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_HISTORY', 'NODE_INSPECT_RESUME_ON_START']) {
    assert.equal(Object.hasOwn(options.env, key), false);
  }
  assert.deepEqual(JSON.parse(input), { worker_nonce: 'a'.repeat(48) });
  assert.equal(input.endsWith('\n'), true);
});

test('background worker rejects relative, missing, and symlink entrypoints before spawn', async () => {
  let spawnCalls = 0;
  const spawnImpl = () => { spawnCalls += 1; };
  await assert.rejects(
    launchPreReviewWorker({}, {
      executable: 'node',
      workerFile: '/opt/buddy/worker.mjs',
      lstatImpl: async () => regularFile(),
      spawnImpl
    }),
    /absolute executable/
  );
  await assert.rejects(
    launchPreReviewWorker({}, {
      executable: '/opt/node',
      workerFile: '/opt/buddy/worker.mjs',
      lstatImpl: async () => ({ isFile: () => true, isSymbolicLink: () => true }),
      spawnImpl
    }),
    /regular non-symlink/
  );
  await assert.rejects(
    launchPreReviewWorker({}, {
      executable: '/opt/node',
      workerFile: '/opt/buddy/worker.mjs',
      lstatImpl: async () => ({ isFile: () => false, isSymbolicLink: () => false }),
      spawnImpl
    }),
    /regular non-symlink/
  );
  assert.equal(spawnCalls, 0);
});

test('background worker rejects invalid or oversized payloads before spawn', async () => {
  let spawnCalls = 0;
  const options = {
    executable: '/opt/node',
    workerFile: '/opt/buddy/worker.mjs',
    lstatImpl: async () => regularFile(),
    spawnImpl: () => { spawnCalls += 1; }
  };
  await assert.rejects(launchPreReviewWorker(null, options), /payload must be one object/);
  const circular = {};
  circular.self = circular;
  await assert.rejects(launchPreReviewWorker(circular, options), /circular/i);
  await assert.rejects(
    launchPreReviewWorker({ value: 'x'.repeat(65 * 1024) }, options),
    /private IPC limit/
  );
  assert.equal(spawnCalls, 0);
});

test('background worker reports spawn failure and never writes or unrefs', async () => {
  let inputWrites = 0;
  let unrefs = 0;
  await assert.rejects(
    launchPreReviewWorker({}, {
      executable: '/opt/node',
      workerFile: '/opt/buddy/worker.mjs',
      lstatImpl: async () => regularFile(),
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdin = { end: () => { inputWrites += 1; } };
        child.unref = () => { unrefs += 1; };
        queueMicrotask(() => child.emit('error', new Error('spawn failed')));
        return child;
      }
    }),
    /spawn failed/
  );
  assert.equal(inputWrites, 0);
  assert.equal(unrefs, 0);
});

test('background worker terminates a spawned child when private IPC delivery fails', async () => {
  let killed = 0;
  let unrefs = 0;
  await assert.rejects(
    launchPreReviewWorker({}, {
      executable: '/opt/node',
      workerFile: '/opt/buddy/worker.mjs',
      lstatImpl: async () => regularFile(),
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdin = {
          end: (_, callback) => callback(new Error('pipe failed')),
          destroy() {}
        };
        child.kill = () => { killed += 1; };
        child.unref = () => { unrefs += 1; };
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }
    }),
    /pipe failed/
  );
  assert.equal(killed, 1);
  assert.equal(unrefs, 0);
});
