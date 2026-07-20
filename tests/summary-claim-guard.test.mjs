import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseSummaryGuardArgs } from '../src/summary-claim-guard-cli.mjs';

import {
  SUMMARY_CLAIM_GUARD_POLICY_VERSION,
  SUMMARY_CLAIM_GUARD_SCOPE,
  assessSummaryClaimGuardEgress,
  buildSummaryClaimGuardPacket,
  changeSummaryClaimGuardConsent,
  readSummaryClaimGuardConsent,
  summaryClaimGuardConsentFile,
  validateSummaryClaimGuardConsent,
  validateSummaryClaimGuardPacket,
  validateSummaryClaimGuardResult,
  withSummaryClaimGuardIssuance
} from '../src/summary-claim-guard.mjs';

const reviewKey = 'c'.repeat(64);

test('summary-guard CLI requires explicit enable confirmation and rejects ignored status flags', () => {
  assert.equal(parseSummaryGuardArgs(['status', '--json']).action, 'status');
  assert.equal(parseSummaryGuardArgs([
    'enable', '--confirm-summary-egress', '--provider', 'grok', '--model', 'grok-4.5'
  ]).confirmSummaryEgress, true);
  for (const provider of ['claude', 'grok', 'ollama', 'opencode']) {
    assert.equal(parseSummaryGuardArgs([
      'enable', '--confirm-summary-egress', '--provider', provider, '--model', 'provider/model'
    ]).provider, provider);
  }
  assert.throws(
    () => parseSummaryGuardArgs(['enable', '--provider', 'grok']),
    /requires --confirm-summary-egress/
  );
  assert.throws(
    () => parseSummaryGuardArgs(['status', '--provider', 'grok']),
    /only valid for summary-guard enable/
  );
  assert.throws(
    () => parseSummaryGuardArgs(['disable', '--confirm-summary-egress']),
    /only valid for summary-guard enable/
  );
});

function consent(overrides = {}) {
  return {
    schema_version: '1',
    policy_version: SUMMARY_CLAIM_GUARD_POLICY_VERSION,
    scope: SUMMARY_CLAIM_GUARD_SCOPE,
    enabled: true,
    provider: 'grok',
    model: 'grok-code-fast-1',
    consented_at: '2026-07-18T12:00:00.000Z',
    configuration_revision: 3,
    ...overrides
  };
}

function resultNote(packet, quote, overrides = {}) {
  const summaryStart = packet.summary.indexOf(quote);
  return {
    category: 'missing_verification',
    confidence: 0.91,
    summary_start: summaryStart,
    summary_end: summaryStart + quote.length,
    quote,
    advice: 'Label this as unverified or cite the validation that supports it.',
    ...overrides
  };
}

test('summary advisory egress requires a separate exact purpose-specific consent', () => {
  assert.equal(validateSummaryClaimGuardConsent(consent(), { requireEnabled: true }).enabled, true);
  assert.throws(
    () => buildSummaryClaimGuardPacket({
      consent: consent({ enabled: false }), reviewKey, summary: 'All tests passed.'
    }),
    /not explicitly enabled/
  );
  assert.throws(
    () => validateSummaryClaimGuardConsent(consent({ scope: 'code_review_patch' }), { requireEnabled: true }),
    /wrong scope/
  );
  assert.throws(
    () => validateSummaryClaimGuardConsent(consent(), { requireEnabled: true, provider: 'ollama' }),
    /provider changed after consent/
  );
});

test('summary packets are bounded, sanitized, hash-bound, and define exact offset units', () => {
  const packet = buildSummaryClaimGuardPacket({
    consent: consent(),
    reviewKey,
    summary: `${'a'.repeat(3_995)}\u001b]52;c;payload\u0007😀tail`
  });
  assert.equal(packet.summary.length <= 4_000, true);
  assert.equal(packet.summary_truncated, true);
  assert.equal(packet.summary.endsWith('…'), true);
  assert.equal(packet.offset_unit, 'utf16_code_unit');
  assert.equal(packet.consent_revision, 3);
  assert.doesNotMatch(packet.summary, /[\u001b\u0007]/u);
  assert.equal(validateSummaryClaimGuardPacket(packet), packet);
  assert.throws(
    () => validateSummaryClaimGuardPacket({
      ...packet,
      summary: `${packet.summary.slice(0, -1)}x`
    }),
    /summary digest does not match/
  );
});

test('summary advisory egress suppresses secrets and denied path references without exposing them', () => {
  const secret = `sk-proj-${'A9_bC7-dE5_fG3-hJ1_kL8'}`;
  assert.deepEqual(
    assessSummaryClaimGuardEgress({
      summary: `Updated the integration token ${secret}.`,
      excludedPaths: []
    }),
    { allowed: false, reason: 'secret_material' }
  );
  assert.deepEqual(
    assessSummaryClaimGuardEgress({ summary: 'Updated .env. Reran checks.', excludedPaths: [] }),
    { allowed: false, reason: 'sensitive_path_reference' }
  );
  assert.deepEqual(
    assessSummaryClaimGuardEgress({
      summary: 'Updated config.js. and reran checks.',
      excludedPaths: [{ path: 'config.js', reason: 'high-confidence secret material' }]
    }),
    { allowed: false, reason: 'excluded_path_reference' }
  );
  assert.deepEqual(
    assessSummaryClaimGuardEgress({
      summary: 'Updated src/app.mjs and verified the focused tests.',
      excludedPaths: []
    }),
    { allowed: true, reason: null }
  );
});

test('summary advisory egress suppresses structured authorization and namespaced credentials', () => {
  const jwtCredential = [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJhdWQiOiJidWRkeSJ9',
    'Q7mN2vR9_kL4pX8aC6Zt1Yw5Hs3Df0Gj'
  ].join('.');
  for (const summary of [
    `Configured {"ANTHROPIC_API_KEY":"${'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'}"}.`,
    `Used {"Authorization":"Bearer ${jwtCredential}"}.`,
    'Connected with redis://:A9_bC7-dE5_fG3-hJ1_kL8@cache.example.invalid/0.'
  ]) {
    assert.deepEqual(
      assessSummaryClaimGuardEgress({ summary, excludedPaths: [] }),
      { allowed: false, reason: 'secret_material' },
      summary
    );
  }
});

test('advisory notes validate exact summary offsets and Unicode boundaries', () => {
  const packet = buildSummaryClaimGuardPacket({
    consent: consent(),
    reviewKey,
    summary: 'Implemented 😀 support. All tests passed.'
  });
  const quote = 'All tests passed';
  const raw = {
    schema_version: '1',
    status: 'notes',
    advisory: 'One completion claim needs explicit validation support.',
    notes: [resultNote(packet, quote)]
  };
  const validated = validateSummaryClaimGuardResult(raw, packet);
  assert.equal(validated.status, 'notes');
  assert.equal(validated.notes[0].quote, quote);
  assert.throws(
    () => validateSummaryClaimGuardResult({
      ...raw,
      notes: [resultNote(packet, quote, { summary_start: packet.summary.indexOf(quote) + 1 })]
    }, packet),
    /quote does not match its exact summary offsets/
  );
  const emojiStart = packet.summary.indexOf('😀');
  assert.throws(
    () => validateSummaryClaimGuardResult({
      ...raw,
      notes: [resultNote(packet, quote, {
        summary_start: emojiStart + 1,
        summary_end: emojiStart + 2,
        quote: '\ude00'
      })]
    }, packet),
    /splits a Unicode surrogate pair/
  );
});

test('guard notes reject code-finding fields and remain a separate advisory channel', () => {
  const packet = buildSummaryClaimGuardPacket({
    consent: consent(),
    reviewKey,
    summary: 'The implementation is production ready.'
  });
  const quote = 'production ready';
  const technicalReview = Object.freeze({
    schema_version: '2',
    status: 'no_findings',
    summary: 'No validated defects.',
    findings: Object.freeze([]),
    comments: Object.freeze([])
  });
  const before = JSON.stringify(technicalReview);
  assert.throws(
    () => validateSummaryClaimGuardResult({
      schema_version: '1',
      status: 'notes',
      advisory: 'Advisory only.',
      notes: [{ ...resultNote(packet, quote), severity: 'high', path: 'src/app.mjs', line_start: 1 }]
    }, packet),
    /contains code-finding fields: severity, path, line_start/
  );
  const advisory = validateSummaryClaimGuardResult({
    schema_version: '1',
    status: 'notes',
    advisory: 'The readiness claim should name its validation basis.',
    notes: [resultNote(packet, quote)]
  }, packet);
  assert.equal(JSON.stringify(technicalReview), before);
  assert.equal(Object.hasOwn(advisory, 'technical_review'), false);
  assert.equal(Object.hasOwn(advisory.notes[0], 'severity'), false);
  assert.equal(Object.hasOwn(advisory.notes[0], 'path'), false);
});

test('low-confidence guard notes become an honest advisory abstention', () => {
  const packet = buildSummaryClaimGuardPacket({
    consent: consent(),
    reviewKey,
    summary: 'This is fully optimized.'
  });
  const validated = validateSummaryClaimGuardResult({
    schema_version: '1',
    status: 'notes',
    advisory: 'Possible overstatement.',
    notes: [resultNote(packet, 'fully optimized', {
      category: 'overstatement', confidence: 0.4
    })]
  }, packet, { minConfidence: 0.75 });
  assert.deepEqual(validated, {
    schema_version: '1',
    status: 'abstain',
    advisory: 'Summary-claim notes were below the 0.75 publication threshold.',
    notes: []
  });
});

test('summary advisory consent is separately persisted and requires explicit egress confirmation', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-summary-guard-'));
  const root = '/tmp/buddy-summary-guard-workspace';
  try {
    assert.equal((await readSummaryClaimGuardConsent({ root, dataDir })).enabled, false);
    await assert.rejects(
      changeSummaryClaimGuardConsent({
        root,
        dataDir,
        action: 'enable',
        provider: 'grok',
        model: 'grok-4.5'
      }),
      /confirm-summary-egress/
    );
    const enabled = await changeSummaryClaimGuardConsent({
      root,
      dataDir,
      action: 'enable',
      provider: 'grok',
      model: 'grok-4.5',
      confirmSummaryEgress: true
    });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.provider, 'grok');
    const disabled = await changeSummaryClaimGuardConsent({ root, dataDir, action: 'disable' });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.provider, null);
    assert.equal(disabled.configuration_revision, enabled.configuration_revision + 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('summary consent rejects credential-shaped model identifiers before persistence', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-summary-model-guard-'));
  const root = '/tmp/buddy-summary-model-guard-workspace';
  const model = ['xai-', 'A9_bC7-dE5_fG3-hJ1_kL8'].join('');
  try {
    await assert.rejects(changeSummaryClaimGuardConsent({
      root,
      dataDir,
      action: 'enable',
      provider: 'grok',
      model,
      confirmSummaryEgress: true
    }), /model is invalid or contains credential material/);
    await assert.rejects(access(summaryClaimGuardConsentFile(root, dataDir)));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('summary issuance holds the consent lock only through the issuance transaction', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-summary-auth-'));
  const root = '/tmp/buddy-summary-auth-workspace';
  try {
    const expectedConsent = await changeSummaryClaimGuardConsent({
      root,
      dataDir,
      action: 'enable',
      provider: 'grok',
      model: 'grok-4.5',
      confirmSummaryEgress: true
    });
    let authorizeEntered;
    const entered = new Promise((resolve) => { authorizeEntered = resolve; });
    let releaseAuthorization;
    const released = new Promise((resolve) => { releaseAuthorization = resolve; });
    const authorization = withSummaryClaimGuardIssuance({
      root,
      dataDir,
      expectedConsent,
      provider: 'grok',
      model: 'grok-4.5'
    }, async (current) => {
      assert.equal(current.configuration_revision, expectedConsent.configuration_revision);
      authorizeEntered();
      await released;
      return 'review-complete';
    });
    await entered;
    let disableSettled = false;
    const disabling = changeSummaryClaimGuardConsent({ root, dataDir, action: 'disable' })
      .then((value) => {
        disableSettled = true;
        return value;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disableSettled, false);
    releaseAuthorization();
    assert.deepEqual(await authorization, { authorized: true, value: 'review-complete' });
    assert.equal((await disabling).enabled, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('summary issuance rejects stale, disabled, provider, and model state without invoking the callback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-summary-stale-'));
  const root = '/tmp/buddy-summary-stale-workspace';
  try {
    const expectedConsent = await changeSummaryClaimGuardConsent({
      root,
      dataDir,
      action: 'enable',
      provider: 'grok',
      model: 'grok-4.5',
      confirmSummaryEgress: true
    });
    await changeSummaryClaimGuardConsent({ root, dataDir, action: 'disable' });
    let calls = 0;
    const callback = async () => { calls += 1; };
    assert.deepEqual(await withSummaryClaimGuardIssuance({
      root, dataDir, expectedConsent, provider: 'grok', model: 'grok-4.5'
    }, callback), { authorized: false });

    const current = await changeSummaryClaimGuardConsent({
      root,
      dataDir,
      action: 'enable',
      provider: 'grok',
      model: 'grok-4.5',
      confirmSummaryEgress: true
    });
    assert.deepEqual(await withSummaryClaimGuardIssuance({
      root, dataDir, expectedConsent: current, provider: 'ollama', model: 'grok-4.5'
    }, callback), { authorized: false });
    assert.deepEqual(await withSummaryClaimGuardIssuance({
      root, dataDir, expectedConsent: current, provider: 'grok', model: 'grok-code-fast-1'
    }, callback), { authorized: false });
    assert.equal(calls, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('summary issuance releases its lock when an issuance callback fails', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-summary-timeout-'));
  const root = '/tmp/buddy-summary-timeout-workspace';
  try {
    const expectedConsent = await changeSummaryClaimGuardConsent({
      root,
      dataDir,
      action: 'enable',
      provider: 'grok',
      model: 'grok-4.5',
      confirmSummaryEgress: true
    });
    await assert.rejects(withSummaryClaimGuardIssuance({
      root, dataDir, expectedConsent, provider: 'grok', model: 'grok-4.5'
    }, async () => {
      throw new Error('provider timeout');
    }), /provider timeout/);
    let timeout;
    const disabled = await Promise.race([
      changeSummaryClaimGuardConsent({ root, dataDir, action: 'disable' }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('consent lock was not released')), 1_000);
      })
    ]).finally(() => clearTimeout(timeout));
    assert.equal(disabled.enabled, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
