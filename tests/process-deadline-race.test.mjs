import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runProcess } from '../src/process.mjs';
import { buildGrokInferenceProcess } from '../src/providers/grok.mjs';

class DeterministicSupervisor extends EventEmitter {
  constructor({ code, signal, stdout = '' }) {
    super();
    this.pid = undefined;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.outcome = { code, signal, stdout };
    this.startMessage = null;
  }

  send(message, callback) {
    this.startMessage = message;
    callback?.(null);
  }
}

function forcedDeadlineRun(command, args, outcome) {
  let deadlineCallback;
  let supervisor;
  const running = runProcess(command, args, {
    timeoutMs: 250,
    spawnImpl: () => {
      supervisor = new DeterministicSupervisor(outcome);
      return supervisor;
    },
    deadlineNowImpl: () => 0,
    deadlineSetTimeoutImpl: (callback) => {
      deadlineCallback = callback;
      return { unref() {} };
    },
    deadlineClearTimeoutImpl: () => {},
    terminateImpl: (child) => {
      const { code, signal, stdout } = child.outcome;
      if (stdout) child.stdout.write(stdout);
      child.emit('message', {
        schema_version: '1',
        type: 'result',
        token: child.startMessage.token,
        code,
        signal,
        leader_exited: true
      });
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', code, signal);
        child.emit('close', code, signal);
      });
      const escalation = setTimeout(() => {}, 60_000);
      escalation.unref();
      return escalation;
    }
  });
  assert.equal(typeof deadlineCallback, 'function');
  deadlineCallback();
  return running;
}

test('deadline termination remains a timeout when a direct subprocess result races in after the kill', {
  skip: process.platform === 'win32'
}, async () => {
  await assert.rejects(
    forcedDeadlineRun(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      code: null,
      signal: 'SIGTERM'
    }),
    /exceeded its 250 ms deadline/
  );
});

test('deadline termination remains a timeout through the POSIX Grok FIFO bridge under adverse result ordering', {
  skip: process.platform === 'win32'
}, async () => {
  const inference = buildGrokInferenceProcess('/synthetic/grok', ['--prompt-file', 'prompt.pipe'], {
    platform: process.platform,
    fifoPath: '/synthetic/prompt.pipe'
  });
  const outcomes = await Promise.allSettled([
    forcedDeadlineRun(inference.command, inference.args, {
      code: null,
      signal: 'SIGTERM',
      stdout: 'success\n'
    }),
    forcedDeadlineRun(inference.command, inference.args, {
      code: 0,
      signal: null,
      stdout: 'success\n'
    })
  ]);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected');
    assert.match(outcome.reason.message, /exceeded its 250 ms deadline/);
  }
});
