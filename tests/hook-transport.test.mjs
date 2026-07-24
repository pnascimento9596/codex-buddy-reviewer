import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { normalizeHookInput, readHookInput, readJsonObjectInput } from '../hooks/lib/hook-input.mjs';
import { detectHostKind, resolveRuntimeDataDir } from '../hooks/lib/host-runtime.mjs';
import { createHookOutputGuard } from '../src/hook-transport.mjs';

test('hook stdin accepts one bounded identity object and fails closed on malformed input', async () => {
  const fixture = {
    hook_event_name: 'Stop', session_id: 'session', turn_id: 'turn', cwd: '/tmp/workspace'
  };
  const accepted = await readHookInput(Readable.from([Buffer.from(JSON.stringify(fixture))]));
  assert.equal(accepted.hook_event_name, 'Stop');
  assert.equal(accepted.session_id, 'session');
  assert.equal(accepted.turn_id, 'turn');
  assert.equal(accepted.cwd, '/tmp/workspace');
  assert.equal(accepted.buddy_host, 'codex');
  assert.match(accepted.buddy_turn_fingerprint, /^[0-9a-f]{64}$/);

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

test('Claude Code hook payload with prompt_id synthesizes a stable turn_id', async () => {
  // Documented Claude common fields: session_id, prompt_id, cwd, hook_event_name.
  // Claude does not emit Codex turn_id; prompt_id is the per-prompt stable id.
  const claudeStop = {
    hook_event_name: 'Stop',
    session_id: 'abc123',
    prompt_id: '019f91d9-bff1-7362-91e3-5d634f340297',
    cwd: '/tmp/claude-workspace',
    stop_hook_active: false,
    last_assistant_message: 'worker summary text'
  };
  const env = { CLAUDE_PLUGIN_ROOT: '/plugins/buddy', CLAUDE_PLUGIN_DATA: '/data/buddy' };
  const normalized = normalizeHookInput(claudeStop, env);
  assert.equal(normalized.turn_id, 'claude:019f91d9-bff1-7362-91e3-5d634f340297');
  assert.equal(normalized.buddy_host, 'claude');
  assert.equal(normalized.session_id, 'abc123');
  assert.equal(normalized.cwd, '/tmp/claude-workspace');

  const start = normalizeHookInput({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'abc123',
    prompt_id: '019f91d9-bff1-7362-91e3-5d634f340297',
    cwd: '/tmp/claude-workspace',
    prompt: 'fix the bug'
  }, env);
  assert.equal(start.turn_id, normalized.turn_id);
  assert.equal(start.buddy_turn_fingerprint, normalized.buddy_turn_fingerprint);
});

test('Claude Code payload without prompt_id or turn_id fails closed', () => {
  assert.throws(
    () => normalizeHookInput({
      hook_event_name: 'Stop',
      session_id: 'session',
      cwd: '/tmp/workspace'
    }, { CLAUDE_PLUGIN_ROOT: '/plugins/buddy' }),
    /missing prompt_id/
  );
});

test('Codex payload regression keeps exact turn_id identity', () => {
  const codex = normalizeHookInput({
    hook_event_name: 'UserPromptSubmit',
    session_id: 's1',
    turn_id: 't1',
    cwd: '/repo',
    prompt: 'work'
  }, { PLUGIN_ROOT: '/codex/plugin', PLUGIN_DATA: '/codex/data' });
  assert.equal(codex.turn_id, 't1');
  assert.equal(codex.buddy_host, 'codex');
});

test('runtime data dir prefers host plugin data outside the reviewed repo', () => {
  assert.equal(resolveRuntimeDataDir({ PLUGIN_DATA: '/codex/data' }), '/codex/data');
  assert.equal(resolveRuntimeDataDir({ CLAUDE_PLUGIN_DATA: '/claude/data' }), '/claude/data');
  assert.equal(
    resolveRuntimeDataDir({ PLUGIN_DATA: '/codex/data', CLAUDE_PLUGIN_DATA: '/claude/data' }),
    '/codex/data'
  );
  assert.equal(resolveRuntimeDataDir({}), undefined);
  assert.equal(detectHostKind({ CLAUDE_PLUGIN_ROOT: '/p' }), 'claude');
  assert.equal(detectHostKind({ PLUGIN_ROOT: '/p' }), 'codex');
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
