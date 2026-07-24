import { createHash } from 'node:crypto';

import { detectHostKind } from './host-runtime.mjs';

const DEFAULT_MAX_STDIN_BYTES = 1024 * 1024;

export async function readJsonObjectInput(stream = process.stdin, maxBytes = DEFAULT_MAX_STDIN_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error(`hook input exceeded ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('input must be one JSON object');
  }
  return value;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Normalize host-specific hook payloads into the Codex Buddy contract:
 * hook_event_name, session_id, turn_id, cwd (all non-empty strings).
 *
 * Claude Code does not emit turn_id. Prefer prompt_id (stable per user prompt
 * for UserPromptSubmit and Stop on Claude Code v2.1.196+). When prompt_id is
 * absent, refuse rather than invent a cross-event turn identity.
 */
export function normalizeHookInput(value, env = process.env) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('input must be one JSON object');
  }

  const hookEventName = nonEmptyString(value.hook_event_name);
  const sessionId = nonEmptyString(value.session_id);
  const cwd = nonEmptyString(value.cwd);
  if (!hookEventName || !sessionId || !cwd) {
    throw new Error('hook input is missing required fields');
  }

  let turnId = nonEmptyString(value.turn_id);
  const host = detectHostKind(env, value);

  if (!turnId) {
    const promptId = nonEmptyString(value.prompt_id);
    if (promptId) {
      // Prefix keeps Claude turn keys distinct from accidental Codex turn_id
      // collisions while remaining exact and stable for the same prompt_id.
      turnId = `claude:${promptId}`;
    } else if (host === 'claude') {
      throw new Error('Claude Code hook input is missing prompt_id; cannot synthesize a stable turn_id');
    } else {
      throw new Error('hook input is missing turn_id');
    }
  }

  const normalized = {
    ...value,
    hook_event_name: hookEventName,
    session_id: sessionId,
    turn_id: turnId,
    cwd,
    buddy_host: host === 'unknown' ? (turnId.startsWith('claude:') ? 'claude' : 'codex') : host
  };

  // Collision-safe opaque identity material remains session_id + turn_id only.
  // Hash is available for diagnostics; lifecycle still uses opaqueKey on strings.
  normalized.buddy_turn_fingerprint = createHash('sha256')
    .update(`${sessionId}\0${turnId}`)
    .digest('hex');

  return normalized;
}

export async function readHookInput(stream = process.stdin, maxBytes = DEFAULT_MAX_STDIN_BYTES, env = process.env) {
  const value = await readJsonObjectInput(stream, maxBytes);
  return normalizeHookInput(value, env);
}
