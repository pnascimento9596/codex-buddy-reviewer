import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { readHookInput, readJsonObjectInput } from '../hooks/lib/hook-input.mjs';
import { createHookOutputGuard } from '../src/hook-transport.mjs';

test('hook stdin accepts one bounded identity object and fails closed on malformed input', async () => {
  const fixture = {
    hook_event_name: 'Stop', session_id: 'session', turn_id: 'turn', cwd: '/tmp/workspace'
  };
  assert.deepEqual(
    await readHookInput(Readable.from([Buffer.from(JSON.stringify(fixture))])),
    fixture
  );
  await assert.rejects(
    readHookInput(Readable.from([Buffer.from('[]')])),
    /must be one JSON object/
  );
  await assert.rejects(
    readHookInput(Readable.from([Buffer.from(JSON.stringify({ ...fixture, turn_id: '' }))])),
    /missing turn_id/
  );
  await assert.rejects(
    readHookInput(Readable.from([Buffer.alloc(33)]), 32),
    /exceeded 32 bytes/
  );
});

test('private worker stdin accepts a bounded identity object without hook-only fields', async () => {
  const fixture = {
    cwd: '/tmp/workspace',
    session_id: 'session',
    turn_id: 'turn',
    worker_nonce: 'a'.repeat(48)
  };
  assert.deepEqual(
    await readJsonObjectInput(Readable.from([Buffer.from(JSON.stringify(fixture))])),
    fixture
  );
  await assert.rejects(
    readJsonObjectInput(Readable.from([Buffer.from('[]')])),
    /must be one JSON object/
  );
});

test('hook output guard permits exactly one JSON object', async () => {
  const chunks = [];
  const guard = createHookOutputGuard({
    write(chunk, callback) {
      chunks.push(chunk);
      callback();
    }
  });

  assert.equal(guard.attempted, false);
  assert.equal(await guard.write({ decision: 'block' }), true);
  assert.equal(guard.attempted, true);
  await assert.rejects(guard.write({ systemMessage: 'second object' }), /already attempted/);
  assert.deepEqual(chunks, ['{"decision":"block"}\n']);
});

test('ambiguous stdout failure consumes the one-output allowance', async () => {
  const guard = createHookOutputGuard({
    write(_chunk, callback) {
      callback(new Error('ambiguous stream failure'));
    }
  });

  await assert.rejects(guard.write({ decision: 'block' }), /ambiguous stream failure/);
  assert.equal(guard.attempted, true);
  await assert.rejects(
    guard.write({ systemMessage: 'must not become a second JSON object' }),
    /already attempted/
  );
});

test('empty hook output does not consume the channel', async () => {
  const chunks = [];
  const guard = createHookOutputGuard({
    write(chunk, callback) {
      chunks.push(chunk);
      callback();
    }
  });

  assert.equal(await guard.write(null), false);
  assert.equal(guard.attempted, false);
  assert.equal(await guard.write({ systemMessage: 'fallback' }), true);
  assert.equal(chunks.length, 1);
});
