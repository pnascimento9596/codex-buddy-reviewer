import { createHash } from 'node:crypto';

import { PROVIDER_CONTENT_POLICY_VERSION } from './approved-provider-request.mjs';
import { egressConfigurationHash } from './egress-capability.mjs';
import { reviewersForMode } from './mode.mjs';
import { aggregateReviewOutcomes } from './review-aggregate.mjs';
import { localReviewResultForEvidence, validateReviewResult } from './result.mjs';
import { canonicalJson, opaqueKey, workspaceKey } from './state.mjs';
import {
  assessSummaryClaimGuardEgress,
  buildSummaryClaimGuardPacket
} from './summary-claim-guard.mjs';

const RECEIPT_SCHEMA_VERSION = '1';
const REVIEW_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const OPAQUE_KEY_PATTERN = /^[0-9a-f]{24}$/u;
const SUCCESS_STATUSES = new Set(['findings', 'no_findings', 'abstain']);
const RUN_STATUSES = new Set(['succeeded', 'failed', 'circuit_open']);
const SUCCESS_KEYS = Object.freeze([
  'schema_version',
  'review_key',
  'terminal_status',
  'provider',
  'model',
  'baseline_tree',
  'final_tree',
  'patch_hash',
  'changed_path_count',
  'excluded_path_count',
  'result',
  'reviews',
  'review_failures',
  'review_sources',
  'reviewer_runs',
  'summary_claim_guard',
  'summary_claim_advisory',
  'provider_run',
  'egress_capability',
  'created_at'
]);
const FAILURE_KEYS = Object.freeze([
  'schema_version',
  'review_key',
  'terminal_status',
  'failure_stage',
  'provider',
  'model',
  'failure_code',
  'reviewer_runs',
  'created_at'
]);
const FOREGROUND_FAILURE_KEYS = Object.freeze([...FAILURE_KEYS, 'error_hash']);
const CIRCUIT_FAILURE_KEYS = Object.freeze([
  'schema_version',
  'review_key',
  'terminal_status',
  'provider',
  'model',
  'reviewer_runs',
  'created_at'
]);
const CATCH_FAILURE_KEYS = Object.freeze([
  'schema_version',
  'review_key',
  'terminal_status',
  'failure_stage',
  'provider',
  'model',
  'failure_code',
  'provider_run',
  'egress_capability',
  'reviewer_runs',
  'error_hash',
  'created_at'
]);
const REVIEWER_RUN_KEYS = Object.freeze([
  'source_index',
  'provider',
  'model',
  'status',
  'result',
  'failure',
  'summary_claim_advisory',
  'provider_run',
  'egress_capability'
]);
const EGRESS_AUDIT_KEYS = Object.freeze([
  'schema_version',
  'capability_id',
  'workspace_key',
  'session_key',
  'turn_key',
  'review_key',
  'mode_revision',
  'provider',
  'model',
  'effort',
  'timeout_ms',
  'configuration_sha256',
  'approval_sha256',
  'content_policy_version',
  'channel_inventory_sha256',
  'prompt_sha256',
  'prompt_bytes',
  'response_schema_sha256',
  'summary_consent_revision',
  'summary_sha256',
  'summary_packet_sha256',
  'issued_at',
  'consumed_at',
  'deadline_at'
]);

function fail(message) {
  throw new TypeError(`Buddy automatic receipt: ${message}`);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === 'string'
    && descriptors[key]?.enumerable
    && Object.hasOwn(descriptors[key], 'value'));
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) fail(`${label} must be a plain data object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function providerComposite(reviewers, field) {
  return reviewers.map((reviewer) => reviewer[field]).join('+');
}

function excludedPathCount(evidence) {
  return evidence.excluded_paths.length
    + (evidence.sensitive_change_count ?? 0)
    + (evidence.ignored_change_count ?? 0);
}

function validateEgressAudit(audit, {
  root,
  input,
  reviewKey,
  mode,
  reviewer,
  summaryPacket = null
}, label) {
  exactKeys(audit, EGRESS_AUDIT_KEYS, label);
  const configurationSha256 = egressConfigurationHash({
    provider: reviewer.provider,
    model: reviewer.model,
    effort: reviewer.effort,
    timeout_ms: mode.timeout_ms,
    min_confidence: mode.min_confidence,
    max_patch_bytes: mode.max_patch_bytes
  });
  const issuedAt = Date.parse(audit.issued_at);
  const consumedAt = Date.parse(audit.consumed_at);
  const deadlineAt = Date.parse(audit.deadline_at);
  const expectedSummaryPacketSha256 = summaryPacket === null
    ? null
    : createHash('sha256').update(canonicalJson(summaryPacket)).digest('hex');
  if (audit.schema_version !== '1'
      || !HASH_PATTERN.test(audit.capability_id)
      || audit.workspace_key !== workspaceKey(root)
      || !OPAQUE_KEY_PATTERN.test(audit.session_key)
      || audit.session_key !== opaqueKey(input.session_id)
      || !OPAQUE_KEY_PATTERN.test(audit.turn_key)
      || audit.turn_key !== opaqueKey(input.turn_id)
      || audit.review_key !== reviewKey
      || audit.mode_revision !== mode.config_revision
      || audit.provider !== reviewer.provider
      || audit.model !== reviewer.model
      || audit.effort !== reviewer.effort
      || audit.timeout_ms !== mode.timeout_ms
      || audit.configuration_sha256 !== configurationSha256
      || !HASH_PATTERN.test(audit.approval_sha256)
      || audit.content_policy_version !== PROVIDER_CONTENT_POLICY_VERSION
      || !HASH_PATTERN.test(audit.channel_inventory_sha256)
      || !HASH_PATTERN.test(audit.prompt_sha256)
      || !Number.isSafeInteger(audit.prompt_bytes) || audit.prompt_bytes < 1
      || !HASH_PATTERN.test(audit.response_schema_sha256)
      || audit.summary_consent_revision !== (summaryPacket?.consent_revision ?? null)
      || audit.summary_sha256 !== (summaryPacket?.summary_sha256 ?? null)
      || audit.summary_packet_sha256 !== expectedSummaryPacketSha256
      || !canonicalTimestamp(audit.issued_at)
      || !canonicalTimestamp(audit.consumed_at)
      || !canonicalTimestamp(audit.deadline_at)
      || consumedAt < issuedAt
      || deadlineAt !== consumedAt + mode.timeout_ms + 10_000) {
    fail(`${label} does not match the exact reviewer egress binding`);
  }
}

function groundedResult(result, evidence, mode, label) {
  let validated;
  try {
    validated = validateReviewResult(result, evidence, { minConfidence: mode.min_confidence });
  } catch {
    fail(`${label} is not grounded in the exact final evidence`);
  }
  if (!same(validated, result)) {
    fail(`${label} is not the exact grounded result projection`);
  }
  return result;
}

function validateReviewerRuns(receipt, context, reviewers, { allowEmpty = false } = {}) {
  if (allowEmpty && Array.isArray(receipt.reviewer_runs) && receipt.reviewer_runs.length === 0) {
    return [];
  }
  if (!Array.isArray(receipt.reviewer_runs)
      || receipt.reviewer_runs.length !== reviewers.length) {
    fail('reviewer runs do not match the configured reviewer count');
  }
  return receipt.reviewer_runs.map((run, sourceIndex) => {
    const reviewer = reviewers[sourceIndex];
    exactKeys(run, REVIEWER_RUN_KEYS, `reviewer run ${sourceIndex}`);
    if (run.source_index !== sourceIndex
        || run.provider !== reviewer.provider
        || run.model !== reviewer.model
        || !RUN_STATUSES.has(run.status)) {
      fail(`reviewer run ${sourceIndex} does not match its configured lane`);
    }
    const summaryPacket = sourceIndex === 0 ? context.summaryPacket ?? null : null;
    if (run.status === 'succeeded') {
      if ((summaryPacket === null) !== (run.summary_claim_advisory === null)) {
        fail(`reviewer run ${sourceIndex} does not match its summary-review binding`);
      }
      if (run.result === null || run.failure !== null || run.egress_capability === null) {
        fail(`reviewer run ${sourceIndex} has an incoherent success shape`);
      }
      groundedResult(run.result, context.evidence, context.mode, `reviewer run ${sourceIndex} result`);
      validateEgressAudit(run.egress_capability, {
        ...context,
        reviewer,
        summaryPacket
      }, `reviewer run ${sourceIndex} egress audit`);
      const outcome = {
        provider: reviewer.provider,
        model: reviewer.model,
        result: run.result,
        ...(run.provider_run === null ? {} : { run: run.provider_run })
      };
      if (run.summary_claim_advisory !== null) {
        outcome.summaryAdvisory = run.summary_claim_advisory;
      }
      return outcome;
    }
    if (run.result !== null || run.failure === null) {
      fail(`reviewer run ${sourceIndex} has an incoherent failure shape`);
    }
    if (run.summary_claim_advisory !== null) {
      fail(`failed reviewer run ${sourceIndex} cannot contain a summary advisory`);
    }
    if (run.status === 'circuit_open') {
      if (run.failure?.failure_code !== 'circuit_open'
          || run.provider_run !== null
          || run.egress_capability !== null) {
        fail(`reviewer run ${sourceIndex} has an incoherent circuit-open shape`);
      }
    } else if (run.egress_capability !== null) {
      validateEgressAudit(run.egress_capability, {
        ...context,
        reviewer,
        summaryPacket
      }, `reviewer run ${sourceIndex} egress audit`);
    }
    return {
      provider: reviewer.provider,
      model: reviewer.model,
      failure: run.failure,
      ...(run.provider_run === null ? {} : { run: run.provider_run })
    };
  });
}

function validateSuccessReceipt(receipt, context, reviewers, outcomes) {
  if (!outcomes.some((outcome) => Object.hasOwn(outcome, 'result'))) {
    fail('success receipt has no successful reviewer run');
  }
  const singleReviewerIdentityMismatch = reviewers.length === 1
    && (receipt.provider !== reviewers[0].provider || receipt.model !== reviewers[0].model);
  if (receipt.terminal_status !== receipt.result?.status
      || !SUCCESS_STATUSES.has(receipt.terminal_status)
      || singleReviewerIdentityMismatch
      || receipt.baseline_tree !== context.baseline.tree
      || receipt.final_tree !== context.final.tree
      || receipt.patch_hash !== context.evidence.patch_hash
      || receipt.changed_path_count !== context.evidence.changed_paths.length
      || receipt.excluded_path_count !== excludedPathCount(context.evidence)) {
    fail('success receipt metadata does not match the exact final evidence and mode');
  }
  const expectedSummaryGuard = context.summaryPacket === null
    ? null
    : {
        policy_version: context.summaryPacket.policy_version,
        consent_revision: context.summaryPacket.consent_revision,
        summary_sha256: context.summaryPacket.summary_sha256,
        summary_truncated: context.summaryPacket.summary_truncated
      };
  const primaryAdvisory = receipt.reviewer_runs[0].summary_claim_advisory;
  if (!same(receipt.summary_claim_guard, expectedSummaryGuard)
      || !same(receipt.summary_claim_advisory, primaryAdvisory)) {
    fail('success receipt summary bindings do not match the exact final request');
  }
  groundedResult(receipt.result, context.evidence, context.mode, 'aggregate result');

  let expected;
  if (reviewers.length === 1) {
    // Reuse the aggregate boundary as a validation-only pass so single-lane
    // run and failure metadata receive the same strict structural checks.
    aggregateReviewOutcomes(outcomes);
    const [run] = receipt.reviewer_runs;
    expected = {
      provider: reviewers[0].provider,
      model: reviewers[0].model,
      result: run.result,
      reviews: [{
        source_index: 0,
        label: `${reviewers[0].provider}/${reviewers[0].model}`,
        provider: reviewers[0].provider,
        model: reviewers[0].model,
        result: run.result,
        ...(run.provider_run === null ? {} : { run: run.provider_run }),
        ...(run.summary_claim_advisory === null
          ? {}
          : { summaryAdvisory: run.summary_claim_advisory })
      }],
      failures: [],
      sources: null,
      providerRun: run.provider_run,
      egressCapability: run.egress_capability
    };
  } else {
    const aggregate = aggregateReviewOutcomes(outcomes);
    expected = {
      provider: aggregate.provider,
      model: aggregate.model,
      result: aggregate.result,
      reviews: aggregate.reviews,
      failures: aggregate.failures,
      sources: aggregate.sources,
      providerRun: null,
      egressCapability: null
    };
  }
  if (receipt.provider !== expected.provider
      || receipt.model !== expected.model
      || !same(receipt.result, expected.result)
      || !same(receipt.reviews, expected.reviews)
      || !same(receipt.review_failures, expected.failures)
      || !same(receipt.review_sources, expected.sources)
      || !same(receipt.provider_run, expected.providerRun)
      || !same(receipt.egress_capability, expected.egressCapability)) {
    fail('success receipt contains a non-deterministic aggregate projection');
  }
}

function validateLocalSuccessReceipt(receipt, context) {
  const expectedResult = localReviewResultForEvidence(context.evidence);
  if (expectedResult === null
      || receipt.provider !== 'none'
      || receipt.model !== 'none'
      || receipt.terminal_status !== expectedResult.status
      || receipt.baseline_tree !== context.baseline.tree
      || receipt.final_tree !== context.final.tree
      || receipt.patch_hash !== context.evidence.patch_hash
      || receipt.changed_path_count !== context.evidence.changed_paths.length
      || receipt.excluded_path_count !== excludedPathCount(context.evidence)
      || !same(receipt.result, expectedResult)
      || !same(receipt.reviews, [])
      || !same(receipt.review_failures, [])
      || receipt.review_sources !== null
      || !same(receipt.reviewer_runs, [])
      || receipt.summary_claim_guard !== null
      || receipt.summary_claim_advisory !== null
      || receipt.provider_run !== null
      || receipt.egress_capability !== null) {
    fail('local success receipt does not match the exact no-egress result');
  }
}

function validateFailureReceipt(receipt, context, reviewers, outcomes, kind) {
  if (kind === 'circuit') {
    if (receipt.terminal_status !== 'circuit_open'
        || receipt.provider !== providerComposite(reviewers, 'provider')
        || receipt.model !== providerComposite(reviewers, 'model')
        || outcomes.some((outcome) => outcome.failure?.failure_code !== 'circuit_open')) {
      fail('circuit-open receipt is inconsistent with its configured reviewer runs');
    }
    return;
  }
  if (kind === 'catch') {
    const expectedTerminal = receipt.failure_stage === 'provider'
      ? 'provider_unavailable'
      : `${receipt.failure_stage}_error`;
    const primary = reviewers[0];
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(receipt.failure_stage)
        || !/^[a-z][a-z0-9_]{0,63}$/u.test(receipt.failure_code)
        || receipt.terminal_status !== expectedTerminal
        || receipt.provider !== primary.provider
        || receipt.model !== primary.model
        || !HASH_PATTERN.test(receipt.error_hash)) {
      fail('terminal catch receipt is inconsistent with its failure stage');
    }
    if (receipt.egress_capability !== null) {
      validateEgressAudit(receipt.egress_capability, {
        ...context,
        reviewer: primary,
        summaryPacket: context.summaryPacket
      }, 'terminal catch egress audit');
    }
    if (outcomes.length > 0) {
      if (receipt.provider_run !== null
          && !receipt.reviewer_runs.some((run) => same(run.provider_run, receipt.provider_run))) {
        fail('terminal catch provider metadata is not bound to a reviewer run');
      }
      if (receipt.egress_capability !== null
          && !receipt.reviewer_runs.some((run) => same(run.egress_capability, receipt.egress_capability))) {
        fail('terminal catch egress metadata is not bound to a reviewer run');
      }
    } else if (receipt.provider_run !== null || receipt.egress_capability !== null) {
      fail('terminal catch receipt has unbound provider metadata');
    }
    return;
  }
  if (outcomes.some((outcome) => Object.hasOwn(outcome, 'result'))
      || receipt.terminal_status !== 'provider_unavailable'
      || receipt.failure_stage !== 'provider'
      || receipt.failure_code !== 'no_successful_reviews'
      || receipt.provider !== providerComposite(reviewers, 'provider')
      || receipt.model !== providerComposite(reviewers, 'model')) {
    fail('failure receipt is inconsistent with its reviewer runs');
  }
  if (Object.hasOwn(receipt, 'error_hash')) {
    const expectedErrorHash = createHash('sha256').update(canonicalJson(
      receipt.reviewer_runs.map((run) => ({
        provider: run.provider,
        model: run.model,
        failure: run.failure
      }))
    )).digest('hex');
    if (receipt.error_hash !== expectedErrorHash) {
      fail('foreground failure receipt has an invalid reviewer-run projection hash');
    }
  }
  try {
    aggregateReviewOutcomes(outcomes);
  } catch (error) {
    if (error?.code === 'no_successful_reviews') return;
    throw error;
  }
  fail('failure receipt unexpectedly aggregates to a successful result');
}

function summaryPacketForReceipt(receipt, context, reviewers) {
  const primaryAudit = receipt.reviewer_runs?.[0]?.egress_capability;
  const claimsSummaryEgress = Object.hasOwn(receipt, 'summary_claim_guard')
    ? receipt.summary_claim_guard !== null
    : primaryAudit?.summary_consent_revision !== null
      && primaryAudit?.summary_consent_revision !== undefined;
  if (!claimsSummaryEgress) {
    return null;
  }
  const consent = context.summaryGuardConsent;
  const [primary] = reviewers;
  const summary = context.input.last_assistant_message;
  if (!plainObject(consent)
      || consent.enabled !== true
      || consent.provider !== primary.provider
      || consent.model !== primary.model
      || typeof summary !== 'string'
      || !assessSummaryClaimGuardEgress({
        summary,
        excludedPaths: context.evidence.excluded_paths
      }).allowed) {
    fail('summary receipt is not authorized by the current consent and evidence');
  }
  try {
    return buildSummaryClaimGuardPacket({
      consent,
      reviewKey: context.reviewKey,
      summary
    });
  } catch {
    fail('summary receipt cannot be rebuilt from the current final request');
  }
}

/**
 * Validates a durable automatic-review receipt against independently captured
 * final evidence. The returned object is safe to adopt only for this exact turn.
 */
export function validateAutomaticReceipt(receipt, context) {
  if (!plainObject(context)
      || !plainObject(context.input)
      || !plainObject(context.mode)
      || !plainObject(context.baseline)
      || !plainObject(context.final)
      || !plainObject(context.evidence)) {
    fail('validation context is incomplete');
  }
  const reviewKey = context.reviewKey;
  if (!REVIEW_KEY_PATTERN.test(reviewKey ?? '')
      || receipt?.schema_version !== RECEIPT_SCHEMA_VERSION
      || receipt?.review_key !== reviewKey
      || !canonicalTimestamp(receipt?.created_at)) {
    fail('schema, review key, or creation timestamp is invalid');
  }
  const success = Object.hasOwn(receipt, 'result');
  const localSuccess = success && receipt?.provider === 'none' && receipt?.model === 'none';
  const failureKind = success
    ? null
    : receipt?.terminal_status === 'circuit_open' ? 'circuit'
      : Object.hasOwn(receipt ?? {}, 'provider_run') ? 'catch'
        : Object.hasOwn(receipt ?? {}, 'error_hash') ? 'aggregate'
          : 'speculative';
  const failureKeys = failureKind === 'circuit' ? CIRCUIT_FAILURE_KEYS
    : failureKind === 'catch' ? CATCH_FAILURE_KEYS
      : failureKind === 'aggregate' ? FOREGROUND_FAILURE_KEYS
        : FAILURE_KEYS;
  exactKeys(receipt, success ? SUCCESS_KEYS : failureKeys, success ? 'success receipt' : 'failure receipt');
  const reviewers = reviewersForMode(context.mode);
  const validationContext = {
    ...context,
    summaryPacket: summaryPacketForReceipt(receipt, context, reviewers)
  };
  const outcomes = validateReviewerRuns(receipt, validationContext, reviewers, {
    allowEmpty: failureKind === 'catch' || localSuccess
  });
  if (outcomes.length > 0) {
    try {
      aggregateReviewOutcomes(outcomes);
    } catch (error) {
      if (error?.code !== 'no_successful_reviews') throw error;
    }
  }
  if (localSuccess) validateLocalSuccessReceipt(receipt, validationContext);
  else if (success) validateSuccessReceipt(receipt, validationContext, reviewers, outcomes);
  else validateFailureReceipt(receipt, validationContext, reviewers, outcomes, failureKind);
  return receipt;
}

export function automaticReceiptDigest(receipt) {
  if (!plainObject(receipt)) fail('digest input must be a plain data object');
  return createHash('sha256').update(canonicalJson(receipt)).digest('hex');
}
