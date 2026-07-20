import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewKeyFor } from '../src/review-identity.mjs';

function mode() {
  return {
    provider: 'grok',
    model: 'grok-4.5',
    effort: 'high',
    secondary_provider: 'claude',
    secondary_model: 'claude-opus-4-8',
    secondary_effort: 'high',
    min_confidence: 0.75,
    max_patch_bytes: 262_144
  };
}

function snapshot(overrides = {}) {
  return {
    repository_root: '/private/workspace',
    head: '1'.repeat(40),
    tree: '2'.repeat(40),
    all_paths: ['src/app.mjs'],
    excluded_paths: [],
    incomplete_paths: {},
    content_hashes: { 'src/app.mjs': '3'.repeat(64) },
    excluded_fingerprints: {},
    sensitive_fingerprints: {},
    privacy_fragment_salt: '4'.repeat(64),
    sensitive_fragment_fingerprints: [],
    sensitive_short_fragment_fingerprints: [],
    sensitive_fragment_complete: true,
    privacy_coverage: { schema_version: '1', scope: 'turn_snapshot' },
    path_encoding: 'utf8-nfc-v1',
    ignored_reviewable_complete: true,
    ignored_reviewable_fingerprint: '5'.repeat(64),
    line_counts: { 'src/app.mjs': 1 },
    status_hash: '6'.repeat(64),
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    schema_version: '1',
    scope: 'turn',
    review_id: 'volatile-id',
    captured_at: '2026-07-20T00:00:00.000Z',
    changed_paths: ['src/app.mjs'],
    excluded_paths: [],
    incomplete_paths: [],
    path_evidence: [{ path: 'src/app.mjs', transmitted: true, disposition: 'complete' }],
    patch_hash: '7'.repeat(64),
    patch: 'diff --git a/src/app.mjs b/src/app.mjs\n',
    privacy_coverage: { schema_version: '1', scope: 'turn_evidence' },
    ...overrides
  };
}

function key(overrides = {}) {
  return reviewKeyFor({
    input: {
      session_id: 'session-secret',
      turn_id: 'turn-secret',
      last_assistant_message: 'Finished the implementation.',
      ...(overrides.input ?? {})
    },
    mode: overrides.mode ?? mode(),
    baseline: overrides.baseline ?? snapshot(),
    final: overrides.final ?? snapshot({ tree: '8'.repeat(40), status_hash: '9'.repeat(64) }),
    evidence: overrides.evidence ?? evidence(),
    summaryGuardConsent: overrides.summaryGuardConsent ?? { enabled: false, state: 'disabled' }
  });
}

test('review identity ignores only volatile evidence metadata', () => {
  const first = key();
  const second = key({ evidence: evidence({
    review_id: 'another-volatile-id',
    captured_at: '2026-07-20T01:00:00.000Z'
  }) });
  assert.equal(first, second);
});

test('same synthesized tree cannot hide excluded, ignored, or status changes', () => {
  const original = key();
  assert.notEqual(original, key({ final: snapshot({
    tree: '8'.repeat(40),
    status_hash: '9'.repeat(64),
    excluded_fingerprints: { '.env': 'a'.repeat(64) }
  }) }));
  assert.notEqual(original, key({ final: snapshot({
    tree: '8'.repeat(40),
    status_hash: '9'.repeat(64),
    ignored_reviewable_fingerprint: 'b'.repeat(64)
  }) }));
  assert.notEqual(original, key({ final: snapshot({
    tree: '8'.repeat(40),
    status_hash: 'c'.repeat(64)
  }) }));
});

test('the exact transmitted evidence and omissions are identity-bound', () => {
  const original = key();
  assert.notEqual(original, key({ evidence: evidence({ patch_hash: 'd'.repeat(64) }) }));
  assert.notEqual(original, key({ evidence: evidence({
    excluded_paths: ['private.txt'],
    path_evidence: [{ path: 'private.txt', transmitted: false, disposition: 'excluded' }]
  }) }));
});

test('worker summary is excluded from technical identity unless its separate guard is enabled', () => {
  const original = key();
  assert.equal(original, key({ input: { last_assistant_message: 'A different summary.' } }));
  const consent = {
    enabled: true,
    policy_version: '1',
    configuration_revision: 4,
    provider: 'grok',
    model: 'grok-4.5'
  };
  assert.notEqual(
    key({ summaryGuardConsent: consent }),
    key({ summaryGuardConsent: consent, input: { last_assistant_message: 'A different summary.' } })
  );
});
