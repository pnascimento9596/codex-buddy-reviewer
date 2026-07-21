import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { validateAutomaticReceipt } from '../src/automatic-receipt.mjs';
import { egressConfigurationHash } from '../src/egress-capability.mjs';
import { reviewersForMode } from '../src/mode.mjs';
import { aggregateReviewOutcomes } from '../src/review-aggregate.mjs';
import { canonicalJson, opaqueKey, workspaceKey } from '../src/state.mjs';
import { buildSummaryClaimGuardPacket } from '../src/summary-claim-guard.mjs';

const CREATED_AT = '2026-07-20T00:00:30.000Z';

function fixtureMode(root, dual = true) {
  return {
    schema_version: '1',
    policy_version: '3',
    config_revision: 12,
    workspace_root: root,
    enabled: true,
    scope: 'workspace',
    provider: 'grok',
    model: 'grok-4.5',
    effort: 'high',
    secondary_provider: dual ? 'claude' : null,
    secondary_model: dual ? 'claude-opus-4-8' : null,
    secondary_effort: dual ? 'high' : null,
    min_confidence: 0.75,
    max_patch_bytes: 262_144,
    timeout_ms: 60_000,
    continuous_review_enabled: true,
    continuous_review_consented_at: CREATED_AT,
    consented_at: CREATED_AT,
    updated_at: CREATED_AT
  };
}

function noFindings(summary) {
  return {
    schema_version: '2',
    status: 'no_findings',
    summary,
    findings: [],
    comments: []
  };
}

function context(dual = true) {
  const root = '/private/tmp/buddy-receipt-fixture';
  return {
    root,
    input: { session_id: 'receipt-session', turn_id: 'receipt-turn' },
    mode: fixtureMode(root, dual),
    baseline: { tree: '1'.repeat(40) },
    final: { tree: '2'.repeat(40) },
    evidence: {
      changed_paths: ['src/example.mjs'],
      excluded_paths: [],
      sensitive_change_count: 0,
      ignored_change_count: 0,
      path_evidence: [{ path: 'src/example.mjs', transmitted: true, disposition: 'complete' }],
      hunk_ranges: { 'src/example.mjs': [{ side: 'new', start: 1, end: 1, kind: 'changed' }] },
      line_counts: { 'src/example.mjs': 1 },
      old_line_counts: { 'src/example.mjs': 1 },
      patch_hash: '3'.repeat(64)
    },
    reviewKey: '4'.repeat(64)
  };
}

function auditFor(ctx, reviewer, sourceIndex) {
  const consumedAt = Date.parse(`2026-07-20T00:00:0${sourceIndex + 1}.000Z`);
  return {
    schema_version: '1',
    capability_id: String(sourceIndex + 5).repeat(64),
    workspace_key: workspaceKey(ctx.root),
    session_key: opaqueKey(ctx.input.session_id),
    turn_key: opaqueKey(ctx.input.turn_id),
    review_key: ctx.reviewKey,
    mode_revision: ctx.mode.config_revision,
    provider: reviewer.provider,
    model: reviewer.model,
    effort: reviewer.effort,
    timeout_ms: ctx.mode.timeout_ms,
    configuration_sha256: egressConfigurationHash({
      provider: reviewer.provider,
      model: reviewer.model,
      effort: reviewer.effort,
      timeout_ms: ctx.mode.timeout_ms,
      min_confidence: ctx.mode.min_confidence,
      max_patch_bytes: ctx.mode.max_patch_bytes
    }),
    approval_sha256: 'a'.repeat(64),
    content_policy_version: '1',
    channel_inventory_sha256: 'b'.repeat(64),
    prompt_sha256: 'c'.repeat(64),
    prompt_bytes: 512,
    response_schema_sha256: 'd'.repeat(64),
    summary_consent_revision: null,
    summary_sha256: null,
    summary_packet_sha256: null,
    issued_at: '2026-07-20T00:00:00.000Z',
    consumed_at: new Date(consumedAt).toISOString(),
    deadline_at: new Date(consumedAt + ctx.mode.timeout_ms + 10_000).toISOString()
  };
}

function successReceipt(ctx) {
  const reviewers = reviewersForMode(ctx.mode);
  const reviewerRuns = reviewers.map((reviewer, sourceIndex) => {
    const result = noFindings(`Reviewer ${sourceIndex + 1} completed.`);
    return {
      source_index: sourceIndex,
      provider: reviewer.provider,
      model: reviewer.model,
      status: 'succeeded',
      result,
      failure: null,
      summary_claim_advisory: null,
      provider_run: null,
      egress_capability: auditFor(ctx, reviewer, sourceIndex)
    };
  });
  const outcomes = reviewerRuns.map((run) => ({
    provider: run.provider,
    model: run.model,
    result: run.result
  }));
  const output = reviewers.length === 1
    ? {
        provider: reviewers[0].provider,
        model: reviewers[0].model,
        result: reviewerRuns[0].result,
        reviews: [{
          source_index: 0,
          label: `${reviewers[0].provider}/${reviewers[0].model}`,
          provider: reviewers[0].provider,
          model: reviewers[0].model,
          result: reviewerRuns[0].result
        }],
        failures: [],
        sources: null
      }
    : aggregateReviewOutcomes(outcomes);
  return {
    schema_version: '1',
    review_key: ctx.reviewKey,
    terminal_status: output.result.status,
    provider: output.provider,
    model: output.model,
    baseline_tree: ctx.baseline.tree,
    final_tree: ctx.final.tree,
    patch_hash: ctx.evidence.patch_hash,
    changed_path_count: ctx.evidence.changed_paths.length,
    excluded_path_count: 0,
    result: output.result,
    reviews: output.reviews,
    review_failures: output.failures,
    review_sources: output.sources,
    reviewer_runs: reviewerRuns,
    summary_claim_guard: null,
    summary_claim_advisory: null,
    provider_run: null,
    egress_capability: reviewers.length === 1 ? reviewerRuns[0].egress_capability : null,
    created_at: CREATED_AT
  };
}

function failureReceipt(ctx) {
  const reviewers = reviewersForMode(ctx.mode);
  return {
    schema_version: '1',
    review_key: ctx.reviewKey,
    terminal_status: 'provider_unavailable',
    failure_stage: 'provider',
    provider: reviewers.map((reviewer) => reviewer.provider).join('+'),
    model: reviewers.map((reviewer) => reviewer.model).join('+'),
    failure_code: 'no_successful_reviews',
    reviewer_runs: reviewers.map((reviewer, sourceIndex) => ({
      source_index: sourceIndex,
      provider: reviewer.provider,
      model: reviewer.model,
      status: 'circuit_open',
      result: null,
      failure: {
        stage: 'authorization',
        failure_code: 'circuit_open',
        message: 'Reviewer circuit is temporarily open.'
      },
      summary_claim_advisory: null,
      provider_run: null,
      egress_capability: null
    })),
    created_at: CREATED_AT
  };
}

function localContext(dual = true, evidence = {}) {
  const ctx = context(dual);
  ctx.final = { tree: ctx.baseline.tree };
  ctx.evidence = {
    changed_paths: [],
    excluded_paths: [],
    sensitive_change_count: 0,
    ignored_change_count: 0,
    incomplete_paths: [],
    path_evidence: [],
    hunk_ranges: {},
    line_counts: {},
    old_line_counts: {},
    patch_hash: '6'.repeat(64),
    ...evidence
  };
  return ctx;
}

function localReceipt(ctx, result = noFindings('No reviewable changes were observed in the selected scope.')) {
  return {
    schema_version: '1',
    review_key: ctx.reviewKey,
    terminal_status: result.status,
    provider: 'none',
    model: 'none',
    baseline_tree: ctx.baseline.tree,
    final_tree: ctx.final.tree,
    patch_hash: ctx.evidence.patch_hash,
    changed_path_count: ctx.evidence.changed_paths.length,
    excluded_path_count: ctx.evidence.excluded_paths.length
      + (ctx.evidence.sensitive_change_count ?? 0)
      + (ctx.evidence.ignored_change_count ?? 0),
    result,
    reviews: [],
    review_failures: [],
    review_sources: null,
    reviewer_runs: [],
    summary_claim_guard: null,
    summary_claim_advisory: null,
    provider_run: null,
    egress_capability: null,
    created_at: CREATED_AT
  };
}

test('accepts exact local no-egress success receipts', () => {
  for (const dual of [false, true]) {
    const ctx = localContext(dual);
    assert.equal(validateAutomaticReceipt(localReceipt(ctx), ctx).provider, 'none');
  }

  const excluded = localContext(true, {
    changed_paths: ['private.env'],
    excluded_paths: ['private.env'],
    path_evidence: [{ path: 'private.env', transmitted: false, disposition: 'excluded' }]
  });
  const abstain = {
    schema_version: '2',
    status: 'abstain',
    summary: 'All observed changes were excluded by privacy policy.',
    findings: [],
    comments: []
  };
  assert.equal(validateAutomaticReceipt(localReceipt(excluded, abstain), excluded).terminal_status, 'abstain');
});

test('rejects forged or provider-eligible local success receipts', () => {
  const providerEligible = context(false);
  assert.throws(
    () => validateAutomaticReceipt(localReceipt(providerEligible), providerEligible),
    /exact no-egress result/u
  );

  const ctx = localContext(false);
  const malformedContext = localContext(false);
  const malformedReceipt = localReceipt(malformedContext);
  delete malformedContext.evidence.changed_paths;
  assert.throws(
    () => validateAutomaticReceipt(malformedReceipt, malformedContext),
    /changed, excluded, and path evidence arrays/u
  );
  const missingPathEvidence = localContext(false);
  const missingPathReceipt = localReceipt(missingPathEvidence);
  delete missingPathEvidence.evidence.path_evidence;
  assert.throws(
    () => validateAutomaticReceipt(missingPathReceipt, missingPathEvidence),
    /changed, excluded, and path evidence arrays/u
  );
  for (const mutate of [
    (receipt) => { receipt.result.summary = 'Forged local result.'; },
    (receipt) => { receipt.reviews.push({ provider: 'none' }); },
    (receipt) => { receipt.reviewer_runs.push({ provider: 'none' }); },
    (receipt) => { receipt.summary_claim_advisory = {}; },
    (receipt) => { receipt.provider_run = {}; },
    (receipt) => { receipt.egress_capability = {}; }
  ]) {
    const receipt = localReceipt(ctx);
    mutate(receipt);
    assert.throws(() => validateAutomaticReceipt(receipt, ctx));
  }
});

test('accepts exact success and terminal failure receipts', () => {
  const dual = context(true);
  assert.equal(validateAutomaticReceipt(successReceipt(dual), dual).review_key, dual.reviewKey);
  assert.equal(validateAutomaticReceipt(failureReceipt(dual), dual).terminal_status, 'provider_unavailable');

  const single = context(false);
  assert.equal(validateAutomaticReceipt(successReceipt(single), single).review_key, single.reviewKey);
});

test('accepts the known compact circuit and terminal catch failure unions', () => {
  const ctx = context(true);
  const circuit = failureReceipt(ctx);
  delete circuit.failure_stage;
  delete circuit.failure_code;
  circuit.terminal_status = 'circuit_open';
  assert.equal(validateAutomaticReceipt(circuit, ctx).terminal_status, 'circuit_open');

  const terminalCatch = {
    schema_version: '1',
    review_key: ctx.reviewKey,
    terminal_status: 'authorization_error',
    failure_stage: 'authorization',
    provider: ctx.mode.provider,
    model: ctx.mode.model,
    failure_code: 'authorization_error',
    provider_run: null,
    egress_capability: null,
    reviewer_runs: [],
    error_hash: 'f'.repeat(64),
    created_at: CREATED_AT
  };
  assert.equal(validateAutomaticReceipt(terminalCatch, ctx).terminal_status, 'authorization_error');
});

test('rejects corrupted final evidence metadata and aggregate projections', () => {
  const ctx = context(true);
  const metadata = structuredClone(successReceipt(ctx));
  metadata.patch_hash = 'f'.repeat(64);
  assert.throws(() => validateAutomaticReceipt(metadata, ctx), /exact final evidence/u);

  const projection = structuredClone(successReceipt(ctx));
  projection.result.summary = 'A forged aggregate summary.';
  assert.throws(() => validateAutomaticReceipt(projection, ctx), /deterministic aggregate projection/u);
});

test('rejects reordered reviewer lanes even when every provider is configured', () => {
  const ctx = context(true);
  const receipt = structuredClone(successReceipt(ctx));
  receipt.reviewer_runs.reverse();
  assert.throws(() => validateAutomaticReceipt(receipt, ctx), /configured lane/u);
});

test('rejects egress audits bound to another turn or configuration', () => {
  const ctx = context(true);
  const wrongTurn = structuredClone(successReceipt(ctx));
  wrongTurn.reviewer_runs[0].egress_capability.turn_key = opaqueKey('another-turn');
  assert.throws(() => validateAutomaticReceipt(wrongTurn, ctx), /exact reviewer egress binding/u);

  const wrongConfiguration = structuredClone(successReceipt(ctx));
  wrongConfiguration.reviewer_runs[0].egress_capability.configuration_sha256 = '0'.repeat(64);
  assert.throws(() => validateAutomaticReceipt(wrongConfiguration, ctx), /exact reviewer egress binding/u);
});

test('rejects malformed provider run metadata on a single reviewer receipt', () => {
  const ctx = context(false);
  const receipt = structuredClone(successReceipt(ctx));
  receipt.reviewer_runs[0].provider_run = { exitCode: 0 };
  receipt.reviews[0].run = { exitCode: 0 };
  assert.throws(() => validateAutomaticReceipt(receipt, ctx), /review outcome 0\.run/u);
});

test('accepts a foreground all-failure receipt with exact summary egress bindings', () => {
  const ctx = context(true);
  ctx.input.last_assistant_message = 'Implemented and validated the requested change.';
  ctx.summaryGuardConsent = {
    schema_version: '1',
    policy_version: '1',
    scope: 'worker_summary_claim_advisory',
    enabled: true,
    provider: ctx.mode.provider,
    model: ctx.mode.model,
    consented_at: CREATED_AT,
    configuration_revision: 3
  };
  const packet = buildSummaryClaimGuardPacket({
    consent: ctx.summaryGuardConsent,
    reviewKey: ctx.reviewKey,
    summary: ctx.input.last_assistant_message
  });
  const receipt = failureReceipt(ctx);
  receipt.reviewer_runs[0].status = 'failed';
  receipt.reviewer_runs[0].failure = {
    stage: 'provider',
    failure_code: 'transport_exit',
    message: 'The reviewer did not complete.'
  };
  receipt.reviewer_runs[0].egress_capability = auditFor(
    ctx,
    reviewersForMode(ctx.mode)[0],
    0
  );
  Object.assign(receipt.reviewer_runs[0].egress_capability, {
    summary_consent_revision: packet.consent_revision,
    summary_sha256: packet.summary_sha256,
    summary_packet_sha256: createHash('sha256').update(canonicalJson(packet)).digest('hex')
  });
  receipt.error_hash = createHash('sha256').update(canonicalJson(
    receipt.reviewer_runs.map((run) => ({
      provider: run.provider,
      model: run.model,
      failure: run.failure
    }))
  )).digest('hex');
  assert.equal(validateAutomaticReceipt(receipt, ctx).terminal_status, 'provider_unavailable');
});

test('rejects noncanonical timestamps and incoherent terminal status', () => {
  const ctx = context(true);
  const timestamp = structuredClone(successReceipt(ctx));
  timestamp.created_at = '2026-07-20T00:00:30Z';
  assert.throws(() => validateAutomaticReceipt(timestamp, ctx), /creation timestamp/u);

  const terminal = structuredClone(successReceipt(ctx));
  terminal.terminal_status = 'findings';
  assert.throws(() => validateAutomaticReceipt(terminal, ctx), /exact final evidence and mode/u);
});
