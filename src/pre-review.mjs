import path from 'node:path';
import { watch } from 'node:fs';

import { automaticReceiptFile, automaticTurnDirectory, speculativeAttemptFile } from './automatic-paths.mjs';
import { launchPreReviewWorker } from './background-worker.mjs';
import { prepareReviewRequest, reviewEvidence } from './cli.mjs';
import {
  egressConfigurationHash,
  issueEgressCapabilityBatch,
  spendEgressCapability,
  withProviderLane
} from './egress-capability.mjs';
import { reviewKeyFor } from './review-identity.mjs';
import { readMode, resolveRepositoryRoot, reviewersForMode, withModeLock } from './mode.mjs';
import { appendOutboxEvent } from './outbox.mjs';
import {
  MAX_SPECULATIVE_GENERATIONS,
  PRE_REVIEW_DEBOUNCE_MS,
  PRE_REVIEW_POLL_MS,
  claimPreReviewWorker,
  finishPreReviewWorker,
  incrementPreReviewLaunch,
  markPreReviewLaunchFailed,
  notePreReviewMutation,
  readPreReviewState,
  updatePreReviewWorker
} from './pre-review-state.mjs';
import { privacyCoverageIsCurrentComplete } from './privacy-inventory.mjs';
import { approveProviderReviewRequest } from './provider-registry.mjs';
import { providerEgressPlatformPolicy } from './provider-egress-platform.mjs';
import {
  providerCircuitIsOpen,
  recordProviderCircuit
} from './provider-circuit.mjs';
import { aggregateReviewOutcomes, ReviewAggregationError } from './review-aggregate.mjs';
import {
  assertStateOutsideRepository,
  ensurePrivateStatePath,
  opaqueKey,
  readPrivateJson,
  resolveDataDir,
  resolveRuntimeDataDir,
  withFileLock,
  writePrivateJsonExclusive
} from './state.mjs';
import { readSummaryClaimGuardConsent } from './summary-claim-guard.mjs';
import { buildTurnEvidence, captureTurnSnapshot, turnSnapshotDigest } from './turn-snapshot.mjs';

const INPUT_KEYS = Object.freeze([
  'cwd',
  'session_id',
  'turn_id',
  'worker_nonce',
  'runtime_data_dir',
  'mode_data_dir'
]);
const REQUIRED_INPUT_KEYS = Object.freeze(['cwd', 'session_id', 'turn_id', 'worker_nonce']);
const START_INPUT_KEYS = Object.freeze(['cwd', 'session_id', 'turn_id', 'runtime_data_dir', 'mode_data_dir']);
const START_REQUIRED_INPUT_KEYS = Object.freeze(['cwd', 'session_id', 'turn_id']);
const NONCE_PATTERN = /^[0-9a-f]{48}$/u;
export const PRE_REVIEW_MAX_LIFETIME_MS = 6 * 60 * 60 * 1_000;
const MAX_ALLOWED_WORKER_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const PRE_REVIEW_MODE_REVALIDATE_MS = 30_000;
const SNAPSHOT_ACTIVITY_LOCK_TIMEOUT_MS = 120_000;

class PreReviewWorkerExpiredError extends Error {
  constructor() {
    super('Buddy pre-review worker reached its absolute lifetime');
    this.name = 'PreReviewWorkerExpiredError';
  }
}

class PreReviewOwnershipLostError extends Error {
  constructor() {
    super('Buddy pre-review worker no longer owns this turn');
    this.name = 'PreReviewOwnershipLostError';
  }
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return ownKeys.every((key) => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'));
}

function validateInput(value) {
  if (!plainObject(value)) throw new TypeError('Buddy pre-review input must be one plain object');
  const keys = Object.keys(value);
  if (keys.some((key) => !INPUT_KEYS.includes(key))
      || REQUIRED_INPUT_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError('Buddy pre-review input contains unsupported or missing fields');
  }
  if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || value.cwd.length > 4096
      || typeof value.session_id !== 'string' || !value.session_id || value.session_id.length > 1024
      || typeof value.turn_id !== 'string' || !value.turn_id || value.turn_id.length > 1024
      || typeof value.worker_nonce !== 'string' || !NONCE_PATTERN.test(value.worker_nonce)) {
    throw new TypeError('Buddy pre-review input identity is invalid');
  }
  for (const key of ['runtime_data_dir', 'mode_data_dir']) {
    if (Object.hasOwn(value, key)
        && (typeof value[key] !== 'string' || !path.isAbsolute(value[key]) || value[key].length > 4096)) {
      throw new TypeError(`Buddy pre-review ${key} must be an absolute path`);
    }
  }
  return Object.freeze({ ...value });
}

function validateStartInput(value) {
  if (!plainObject(value)) throw new TypeError('Buddy pre-review start input must be one plain object');
  const keys = Object.keys(value);
  if (keys.some((key) => !START_INPUT_KEYS.includes(key))
      || START_REQUIRED_INPUT_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError('Buddy pre-review start input contains unsupported or missing fields');
  }
  return validateInput({ ...value, worker_nonce: '0'.repeat(48) });
}

function validConsentTimestamp(value) {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateWorkerLifetime(milliseconds) {
  if (!Number.isSafeInteger(milliseconds)
      || milliseconds < 1
      || milliseconds >= MAX_ALLOWED_WORKER_LIFETIME_MS) {
    throw new TypeError('Buddy pre-review worker lifetime must be a positive safe integer below 24 hours');
  }
  return milliseconds;
}

function validateModeRevalidateInterval(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new TypeError('Buddy pre-review mode revalidation interval must be a positive safe integer');
  }
  return milliseconds;
}

function assertWorkerLifetime(deadline, signal, now) {
  if (signal.aborted || now() >= deadline) throw new PreReviewWorkerExpiredError();
}

async function pauseWithinWorkerLifetime(milliseconds, deadline, signal, deps) {
  assertWorkerLifetime(deadline, signal, deps.now);
  const remaining = Math.max(0, deadline - deps.now());
  await pauseUnlessAborted(Math.min(milliseconds, remaining), signal, deps.pause);
  assertWorkerLifetime(deadline, signal, deps.now);
}

function continuousModeMatches(current, expected, baselineRecord) {
  return current.enabled
    && current.continuous_review_enabled
    && validConsentTimestamp(current.continuous_review_consented_at)
    && current.config_revision === baselineRecord.mode_revision
    && current.continuous_review_consented_at === expected.continuous_review_consented_at;
}

function createRepositoryMutationMonitor(root) {
  let revision = 0;
  const waiters = new Set();
  const notify = () => {
    revision += 1;
    for (const waiter of waiters) waiter(revision);
    waiters.clear();
  };
  let watcher;
  try {
    watcher = watch(root, { recursive: true, persistent: false }, notify);
  } catch {
    return null;
  }
  watcher.on('error', notify);
  return Object.freeze({
    get revision() {
      return revision;
    },
    wait(afterRevision, timeoutMs, signal) {
      if (revision !== afterRevision || signal?.aborted) return Promise.resolve(revision);
      return new Promise((resolve) => {
        let timer;
        const settle = (value) => {
          clearTimeout(timer);
          waiters.delete(settle);
          signal?.removeEventListener('abort', settle);
          resolve(value);
        };
        waiters.add(settle);
        signal?.addEventListener('abort', settle, { once: true });
        timer = setTimeout(() => settle(revision), timeoutMs);
        timer.unref?.();
      });
    },
    close() {
      watcher.close();
      for (const waiter of waiters) waiter(revision);
      waiters.clear();
    }
  });
}

function safeFailure(error) {
  const code = typeof error?.failureCode === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(error.failureCode)
    ? error.failureCode
    : error?.name === 'AbortError' ? 'superseded' : 'provider_error';
  return Object.freeze({
    stage: error?.egressCapabilityStage === 'settlement' ? 'settlement' : 'provider',
    failure_code: code,
    message: code === 'superseded'
      ? 'The speculative review was superseded by a newer exact checkpoint.'
      : 'The reviewer did not complete.'
  });
}

function intentionalProviderCancellation(error) {
  return error?.name === 'AbortError'
    || ['cancelled', 'superseded'].includes(error?.failureCode);
}

function circuitOpenOutcome(reviewer) {
  return {
    provider: reviewer.provider,
    model: reviewer.model,
    failure: {
      stage: 'authorization',
      failure_code: 'circuit_open',
      message: 'Reviewer circuit is temporarily open.'
    }
  };
}

function providerComposite(reviewers, field) {
  return reviewers.map((reviewer) => reviewer[field]).join('+');
}

function reviewerRun(outcome, index, reviewed = null, failure = null) {
  const publicFailure = failure ? {
    stage: failure.stage,
    failure_code: failure.failure_code,
    message: failure.message
  } : null;
  return {
    source_index: index,
    provider: outcome.provider,
    model: outcome.model,
    status: reviewed ? 'succeeded' : 'failed',
    result: reviewed?.result ?? null,
    failure: publicFailure,
    summary_claim_advisory: null,
    provider_run: reviewed?.run ?? failure?.run ?? null,
    egress_capability: reviewed?.egressCapabilityAudit ?? failure?.egressCapabilityAudit ?? null
  };
}

function receiptForSuccess({ reviewKey, reviewers, reviewerRuns, output, baseline, final, evidence }) {
  return {
    schema_version: '1',
    review_key: reviewKey,
    terminal_status: output.result.status,
    provider: output.provider,
    model: output.model,
    baseline_tree: baseline.tree,
    final_tree: final.tree,
    patch_hash: evidence.patch_hash,
    changed_path_count: evidence.changed_paths.length,
    excluded_path_count: evidence.excluded_paths.length
      + (evidence.sensitive_change_count ?? 0)
      + (evidence.ignored_change_count ?? 0),
    result: output.result,
    reviews: output.reviews ?? [],
    review_failures: output.failures ?? [],
    review_sources: output.sources ?? null,
    reviewer_runs: reviewerRuns,
    summary_claim_guard: null,
    summary_claim_advisory: null,
    provider_run: reviewers.length === 1 ? reviewerRuns[0]?.provider_run ?? null : null,
    egress_capability: reviewers.length === 1 ? reviewerRuns[0]?.egress_capability ?? null : null,
    created_at: new Date().toISOString()
  };
}

function receiptForFailure({ reviewKey, reviewers, reviewerRuns }) {
  return {
    schema_version: '1',
    review_key: reviewKey,
    terminal_status: 'provider_unavailable',
    failure_stage: 'provider',
    provider: providerComposite(reviewers, 'provider'),
    model: providerComposite(reviewers, 'model'),
    failure_code: 'no_successful_reviews',
    reviewer_runs: reviewerRuns,
    created_at: new Date().toISOString()
  };
}

function localReviewOutput(reviewed) {
  return {
    ...reviewed,
    reviews: [{
      source_index: 0,
      label: `${reviewed.provider}/${reviewed.model}`,
      provider: reviewed.provider,
      model: reviewed.model,
      result: reviewed.result,
      ...(reviewed.run ? { run: reviewed.run } : {})
    }],
    failures: [],
    sources: null
  };
}

async function safeEmit(deps, options) {
  try {
    return await deps.emit(options);
  } catch {
    return null;
  }
}

async function debounceGeneration({ directory, workerNonce, deadline, lifetimeSignal, deps }) {
  let observed = await deps.readState(directory);
  while (true) {
    assertWorkerLifetime(deadline, lifetimeSignal, deps.now);
    if (observed.worker_nonce !== workerNonce) return null;
    const generation = observed.generation;
    await pauseWithinWorkerLifetime(deps.debounceMs, deadline, lifetimeSignal, deps);
    const current = await deps.readState(directory);
    if (current.worker_nonce !== workerNonce) return null;
    if (current.generation === generation) return current;
    observed = current;
  }
}

async function pauseUnlessAborted(milliseconds, signal, pauseImpl) {
  if (signal.aborted) return;
  let onAbort;
  await Promise.race([
    pauseImpl(milliseconds),
    new Promise((resolve) => {
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    })
  ]);
  if (onAbort) signal.removeEventListener('abort', onAbort);
}

async function captureCheckpoint({ root, directory, baseline, workerNonce, deps }) {
  return deps.withSnapshotActivity(directory, async () => {
    const state = await deps.readState(directory);
    if (state.worker_nonce !== workerNonce) throw new PreReviewOwnershipLostError();
    return deps.captureSnapshot({
      root,
      workDir: path.join(directory, 'snapshot'),
      privacySalt: baseline.privacy_fragment_salt
    });
  });
}

async function stableCheckpoint({
  root,
  directory,
  baseline,
  workerNonce,
  initial,
  mutationMonitor,
  deadline,
  lifetimeSignal,
  deps
}) {
  assertWorkerLifetime(deadline, lifetimeSignal, deps.now);
  let candidate = initial ?? await captureCheckpoint({
    root, directory, baseline, workerNonce, deps
  });
  while (true) {
    assertWorkerLifetime(deadline, lifetimeSignal, deps.now);
    const digest = deps.snapshotDigest(candidate);
    await pauseWithinWorkerLifetime(deps.debounceMs, deadline, lifetimeSignal, deps);
    const beforeConfirmation = mutationMonitor?.revision ?? 0;
    const confirmation = await captureCheckpoint({
      root, directory, baseline, workerNonce, deps
    });
    assertWorkerLifetime(deadline, lifetimeSignal, deps.now);
    const afterConfirmation = mutationMonitor?.revision ?? beforeConfirmation;
    if (afterConfirmation === beforeConfirmation && deps.snapshotDigest(confirmation) === digest) {
      return { checkpoint: confirmation, mutationRevision: afterConfirmation };
    }
    candidate = confirmation;
  }
}

async function monitorSupersession({
  root,
  directory,
  baseline,
  workerNonce,
  stateGeneration,
  reviewKey,
  checkpointDigest,
  mutationMonitor,
  mutationRevision,
  controller,
  deadline,
  lifetimeSignal,
  deps
}) {
  let observedRevision = mutationRevision;
  let fallbackAt = deps.now() + deps.checkpointPollMs;
  while (!controller.signal.aborted) {
    if (lifetimeSignal.aborted || deps.now() >= deadline) {
      controller.abort(new DOMException('Speculative worker expired', 'AbortError'));
      return 'expired';
    }
    const waitMs = Math.max(0, Math.min(
      deps.statePollMs,
      fallbackAt - deps.now(),
      deadline - deps.now()
    ));
    const beforeWait = observedRevision;
    if (mutationMonitor) {
      observedRevision = await mutationMonitor.wait(
        observedRevision,
        waitMs,
        controller.signal
      );
    } else {
      await pauseUnlessAborted(waitMs, controller.signal, deps.pause);
    }
    if (controller.signal.aborted) break;
    const state = await deps.readState(directory);
    const lostOwnership = state.worker_nonce !== workerNonce;
    const newerGeneration = state.generation !== stateGeneration;
    const differentFinal = state.final_requested
      && state.final_review_key !== null
      && state.final_review_key !== reviewKey;
    if (lostOwnership || newerGeneration || differentFinal) {
      controller.abort(new DOMException('Speculative review superseded', 'AbortError'));
      return 'superseded';
    }
    const repositoryEvent = mutationMonitor && observedRevision !== beforeWait;
    const fallbackDue = deps.now() >= fallbackAt;
    if (!repositoryEvent && !fallbackDue) continue;
    const observed = await captureCheckpoint({
      root, directory, baseline, workerNonce, deps
    });
    if (deps.snapshotDigest(observed) !== checkpointDigest) {
      controller.abort(new DOMException('Speculative review superseded', 'AbortError'));
      return 'superseded';
    }
    fallbackAt = deps.now() + deps.checkpointPollMs;
  }
  return lifetimeSignal.aborted || deps.now() >= deadline ? 'expired' : 'finished';
}

async function waitAfterReady({
  root,
  directory,
  baseline,
  workerNonce,
  stateGeneration,
  reviewKey,
  checkpointDigest,
  mutationMonitor,
  mutationRevision,
  deadline,
  lifetimeSignal,
  revalidateMode,
  deps
}) {
  let observedRevision = mutationRevision;
  let fallbackAt = deps.now() + deps.checkpointPollMs;
  let modeCheckAt = deps.now();
  while (true) {
    assertWorkerLifetime(deadline, lifetimeSignal, deps.now);
    const state = await deps.readState(directory);
    if (state.worker_nonce !== workerNonce) return { status: 'not_owner' };
    if (state.final_requested) {
      return state.final_review_key === reviewKey
        ? { status: 'final_ready' }
        : { status: 'superseded' };
    }
    if (state.generation !== stateGeneration) return { status: 'changed' };
    if (deps.now() >= modeCheckAt) {
      if (!await revalidateMode()) return { status: 'mode_changed' };
      modeCheckAt = deps.now() + deps.modeRevalidateMs;
    }
    const waitMs = Math.max(0, Math.min(
      deps.statePollMs,
      fallbackAt - deps.now(),
      modeCheckAt - deps.now(),
      deadline - deps.now()
    ));
    const beforeWait = observedRevision;
    if (mutationMonitor) {
      observedRevision = await mutationMonitor.wait(observedRevision, waitMs, lifetimeSignal);
    } else {
      await pauseWithinWorkerLifetime(waitMs, deadline, lifetimeSignal, deps);
    }
    assertWorkerLifetime(deadline, lifetimeSignal, deps.now);
    const repositoryEvent = mutationMonitor && observedRevision !== beforeWait;
    const fallbackDue = deps.now() >= fallbackAt;
    if (!repositoryEvent && !fallbackDue) continue;
    const observed = await captureCheckpoint({
      root, directory, baseline, workerNonce, deps
    });
    if (deps.snapshotDigest(observed) !== checkpointDigest) {
      return { status: 'changed', checkpoint: observed };
    }
    fallbackAt = deps.now() + deps.checkpointPollMs;
  }
}

function dependencies(options) {
  return {
    resolveRoot: options.resolveRoot ?? resolveRepositoryRoot,
    readMode: options.readMode ?? readMode,
    withModeLock: options.withModeLock ?? withModeLock,
    readSummaryConsent: options.readSummaryConsent ?? readSummaryClaimGuardConsent,
    platformPolicy: options.platformPolicy ?? providerEgressPlatformPolicy,
    captureSnapshot: options.captureSnapshot ?? captureTurnSnapshot,
    buildEvidence: options.buildEvidence ?? buildTurnEvidence,
    privacyComplete: options.privacyComplete ?? privacyCoverageIsCurrentComplete,
    reviewKey: options.reviewKey ?? reviewKeyFor,
    prepareRequest: options.prepareRequest ?? prepareReviewRequest,
    approveRequest: options.approveRequest ?? approveProviderReviewRequest,
    issueCapabilities: options.issueCapabilities ?? issueEgressCapabilityBatch,
    spendCapability: options.spendCapability ?? spendEgressCapability,
    withProviderLane: options.withProviderLane ?? withProviderLane,
    review: options.review ?? reviewEvidence,
    reviewInjected: Object.hasOwn(options, 'review'),
    aggregate: options.aggregate ?? aggregateReviewOutcomes,
    circuitIsOpen: options.circuitIsOpen ?? providerCircuitIsOpen,
    recordCircuit: options.recordCircuit ?? recordProviderCircuit,
    ensurePrivatePath: options.ensurePrivatePath ?? ensurePrivateStatePath,
    readJson: options.readJson ?? readPrivateJson,
    writeExclusive: options.writeExclusive ?? writePrivateJsonExclusive,
    emit: options.emit ?? appendOutboxEvent,
    withSnapshotActivity: options.withSnapshotActivity ?? ((directory, callback) => withFileLock(
      path.join(directory, 'snapshot-activity'),
      callback,
      {
        timeoutMs: SNAPSHOT_ACTIVITY_LOCK_TIMEOUT_MS,
        staleMs: SNAPSHOT_ACTIVITY_LOCK_TIMEOUT_MS
      }
    )),
    claimWorker: options.claimWorker ?? claimPreReviewWorker,
    readState: options.readState ?? readPreReviewState,
    updateWorker: options.updateWorker ?? updatePreReviewWorker,
    incrementLaunch: options.incrementLaunch ?? incrementPreReviewLaunch,
    finishWorker: options.finishWorker ?? finishPreReviewWorker,
    noteMutation: options.noteMutation ?? notePreReviewMutation,
    launchWorker: options.launchWorker ?? launchPreReviewWorker,
    launchFailed: options.launchFailed ?? markPreReviewLaunchFailed,
    pause: options.pause ?? pause,
    debounceMs: options.debounceMs ?? PRE_REVIEW_DEBOUNCE_MS,
    statePollMs: options.statePollMs ?? PRE_REVIEW_POLL_MS,
    checkpointPollMs: options.checkpointPollMs ?? Math.max(PRE_REVIEW_DEBOUNCE_MS, 30_000),
    snapshotDigest: options.snapshotDigest ?? turnSnapshotDigest,
    createMutationMonitor: options.createMutationMonitor ?? createRepositoryMutationMonitor,
    platform: options.platform ?? process.platform,
    now: options.now ?? Date.now,
    workerLifetimeMs: validateWorkerLifetime(
      options.workerLifetimeMs ?? PRE_REVIEW_MAX_LIFETIME_MS
    ),
    modeRevalidateMs: validateModeRevalidateInterval(
      options.modeRevalidateMs ?? PRE_REVIEW_MODE_REVALIDATE_MS
    ),
    setTimer: options.setTimer ?? setTimeout,
    clearTimer: options.clearTimer ?? clearTimeout
  };
}

async function issueProviderLanes({ root, input, mode, modeDataDir, evidence, reviewKey, lanes, deps }) {
  const prepared = deps.prepareRequest(evidence, { summaryGuardPacket: null });
  const entries = lanes.map(({ reviewer }) => ({
    binding: {
      sessionKey: opaqueKey(input.session_id),
      turnKey: opaqueKey(input.turn_id),
      reviewKey,
      modeRevision: mode.config_revision,
      provider: reviewer.provider,
      model: reviewer.model,
      effort: reviewer.effort,
      timeoutMs: mode.timeout_ms,
      configurationSha256: egressConfigurationHash({
        provider: reviewer.provider,
        model: reviewer.model,
        effort: reviewer.effort,
        timeout_ms: mode.timeout_ms,
        min_confidence: mode.min_confidence,
        max_patch_bytes: mode.max_patch_bytes
      }),
      summaryConsentRevision: null,
      summarySha256: null
    },
    approvedRequest: deps.approveRequest(reviewer.provider, {
      root,
      prompt: prepared.prompt,
      model: reviewer.model,
      effort: reviewer.effort,
      timeoutMs: mode.timeout_ms,
      responseSchema: prepared.responseSchema
    }, { purpose: 'technical_review', summaryGuardPacket: null })
  }));
  const capabilities = await deps.issueCapabilities({ root, dataDir: modeDataDir, entries });
  return { mode, lanes, capabilities };
}

async function executeProviders({
  root,
  runtimeDataDir,
  modeDataDir,
  evidence,
  configuredReviewers,
  openStates,
  issued,
  input,
  reviewKey,
  controller,
  deps
}) {
  const { mode, lanes, capabilities } = issued;
  let reviewStartedEmission = null;
  try {
    const settlements = await Promise.allSettled(lanes.map((lane, index) => (
      deps.spendCapability({ root, dataDir: modeDataDir, capability: capabilities[index] }, async (approvedRequest) => {
        reviewStartedEmission ??= safeEmit(deps, {
          runtimeDataDir,
          repositoryRoot: root,
          sessionId: input.session_id,
          turnId: input.turn_id,
          reviewKey,
          type: 'review_started',
          state: 'reviewing',
          headline: 'Independent review started',
          detail: `${lanes.length} reviewer ${lanes.length === 1 ? 'connection is' : 'connections are'} reviewing ${evidence.changed_paths.length} allowlisted path(s) from an exact checkpoint.`
        });
        if (deps.reviewInjected) lane.providerAttempted = true;
        const reviewed = await deps.review(evidence, {
          provider: lane.reviewer.provider,
          model: lane.reviewer.model,
          effort: lane.reviewer.effort,
          platform: deps.platform,
          minConfidence: mode.min_confidence,
          timeoutMs: mode.timeout_ms,
          store: false,
          retainEvidence: false,
          summaryGuardPacket: null,
          approvedRequest,
          signal: controller.signal,
          onProviderDispatch: () => { lane.providerAttempted = true; }
        });
        if (reviewed.provider !== lane.reviewer.provider || reviewed.model !== lane.reviewer.model) {
          const error = new Error('reviewer result identity does not match its configured lane');
          error.failureCode = 'invalid_review_schema';
          throw error;
        }
        return reviewed;
      }).then(({ value, audit }) => ({ ...value, egressCapabilityAudit: audit }))
    )));
    await Promise.all(lanes.map(async (lane, index) => {
      const settlement = settlements[index];
      if (settlement.status === 'fulfilled') {
        await deps.recordCircuit({
          runtimeDataDir,
          root,
          provider: lane.reviewer.provider,
          model: lane.reviewer.model
        }, true).catch(() => null);
        return;
      }
      if (lane.providerAttempted
          && settlement.reason?.egressCapabilityStage !== 'settlement'
          && !intentionalProviderCancellation(settlement.reason)) {
        await deps.recordCircuit({
          runtimeDataDir,
          root,
          provider: lane.reviewer.provider,
          model: lane.reviewer.model
        }, false).catch(() => null);
      }
    }));
    const laneBySource = new Map(lanes.map((lane, index) => [lane.sourceIndex, {
      lane,
      settlement: settlements[index]
    }]));
    const outcomes = configuredReviewers.map((reviewer, sourceIndex) => {
      if (openStates[sourceIndex]) return circuitOpenOutcome(reviewer);
      const { settlement } = laneBySource.get(sourceIndex);
      if (settlement.status === 'fulfilled') {
        return {
          provider: reviewer.provider,
          model: reviewer.model,
          result: settlement.value.result,
          ...(settlement.value.run ? { run: settlement.value.run } : {})
        };
      }
      return { provider: reviewer.provider, model: reviewer.model, failure: safeFailure(settlement.reason) };
    });
    const reviewerRuns = outcomes.map((outcome, sourceIndex) => {
      if (openStates[sourceIndex]) {
        return {
          source_index: sourceIndex,
          provider: outcome.provider,
          model: outcome.model,
          status: 'circuit_open',
          result: null,
          failure: outcome.failure,
          summary_claim_advisory: null,
          provider_run: null,
          egress_capability: null
        };
      }
      const { settlement } = laneBySource.get(sourceIndex);
      return settlement.status === 'fulfilled'
        ? reviewerRun(outcome, sourceIndex, settlement.value)
        : reviewerRun(outcome, sourceIndex, null, {
            ...safeFailure(settlement.reason),
            ...(settlement.reason?.run ? { run: settlement.reason.run } : {}),
            ...(settlement.reason?.egressCapabilityAudit
              ? { egressCapabilityAudit: settlement.reason.egressCapabilityAudit }
              : {})
          });
    });
    if (controller.signal.aborted) return { superseded: true, reviewerRuns };
    if (configuredReviewers.length === 1) {
      if (openStates[0] || settlements[0].status === 'rejected') {
        return { failure: new ReviewAggregationError(outcomes), reviewerRuns };
      }
      return { output: localReviewOutput(settlements[0].value), reviewerRuns };
    }
    try {
      return { output: deps.aggregate(outcomes), reviewerRuns };
    } catch (error) {
      if (!(error instanceof ReviewAggregationError)) throw error;
      return { failure: error, reviewerRuns };
    }
  } finally {
    await reviewStartedEmission;
  }
}

export async function startTurnPreReview(rawInput, options = {}) {
  const validated = validateStartInput(rawInput);
  const {
    worker_nonce: _validationNonce,
    runtime_data_dir: inputRuntimeDataDir,
    mode_data_dir: inputModeDataDir,
    ...identity
  } = validated;
  const deps = dependencies(options);
  const runtimeDataDir = inputRuntimeDataDir ?? options.runtimeDataDir;
  const modeDataDir = inputModeDataDir ?? options.modeDataDir;
  let root;
  try {
    root = await deps.resolveRoot(identity.cwd);
  } catch {
    return { skipped: 'non_git' };
  }
  await assertStateOutsideRepository(root, resolveRuntimeDataDir(runtimeDataDir), 'runtime state');
  await assertStateOutsideRepository(root, resolveDataDir(modeDataDir), 'mode state');
  const directory = automaticTurnDirectory(runtimeDataDir, root, identity.session_id, identity.turn_id);
  const runtimeRoot = resolveRuntimeDataDir(runtimeDataDir);
  await deps.ensurePrivatePath(runtimeRoot, directory);
  const noted = await deps.noteMutation(directory);
  if (!noted.launched) return { skipped: 'already_started', root, directory, state: noted.state };
  const payload = {
    ...identity,
    worker_nonce: noted.workerNonce,
    ...(runtimeDataDir ? { runtime_data_dir: path.resolve(runtimeDataDir) } : {}),
    ...(modeDataDir ? { mode_data_dir: path.resolve(modeDataDir) } : {})
  };
  try {
    const launched = await deps.launchWorker(payload);
    return { status: 'started', root, directory, state: noted.state, pid: launched.pid ?? null };
  } catch (error) {
    await deps.launchFailed(directory, noted.workerNonce).catch(() => null);
    return { skipped: 'launch_failed', error, root, directory };
  }
}

export async function runPreReviewWorker(rawInput, options = {}) {
  const input = validateInput(rawInput);
  const deps = dependencies(options);
  const runtimeDataDir = input.runtime_data_dir ?? options.runtimeDataDir;
  const modeDataDir = input.mode_data_dir ?? options.modeDataDir;
  let root;
  try {
    root = await deps.resolveRoot(input.cwd);
  } catch {
    return { skipped: 'non_git' };
  }
  await assertStateOutsideRepository(root, resolveRuntimeDataDir(runtimeDataDir), 'runtime state');
  await assertStateOutsideRepository(root, resolveDataDir(modeDataDir), 'mode state');
  const directory = automaticTurnDirectory(runtimeDataDir, root, input.session_id, input.turn_id);
  const runtimeRoot = resolveRuntimeDataDir(runtimeDataDir);
  await deps.ensurePrivatePath(runtimeRoot, directory);
  const claimed = await deps.claimWorker(directory, input.worker_nonce);
  if (!claimed.claimed) return { skipped: 'not_owner' };
  const workerDeadline = deps.now() + deps.workerLifetimeMs;
  const lifetimeController = new AbortController();
  const lifetimeTimer = deps.setTimer(() => {
    lifetimeController.abort(new DOMException('Speculative worker expired', 'AbortError'));
  }, deps.workerLifetimeMs);
  lifetimeTimer?.unref?.();

  const disable = async (reason) => {
    await deps.finishWorker(directory, input.worker_nonce, 'disabled');
    return { skipped: reason, root, directory };
  };
  let mutationMonitor = null;
  try {
    const mode = await deps.readMode({ root, dataDir: modeDataDir });
    if (!mode.enabled || !mode.continuous_review_enabled
        || !validConsentTimestamp(mode.continuous_review_consented_at)) {
      return disable('continuous_disabled');
    }
    if (!deps.platformPolicy(deps.platform).allowed) return disable('platform_blocked');
    const baselineRecord = await deps.readJson(path.join(directory, 'baseline.json'));
    if (!baselineRecord?.snapshot || baselineRecord.mode_revision !== mode.config_revision) {
      return disable(baselineRecord ? 'mode_changed' : 'missing_baseline');
    }
    const summaryConsent = await deps.readSummaryConsent({ root, dataDir: modeDataDir });
    if (summaryConsent?.enabled) return disable('summary_guard_enabled');
    mutationMonitor = deps.createMutationMonitor(root);
    const revalidateMode = async () => {
      const currentMode = await deps.readMode({ root, dataDir: modeDataDir });
      return continuousModeMatches(currentMode, mode, baselineRecord);
    };

    let pendingCheckpoint = null;
    while (true) {
      assertWorkerLifetime(workerDeadline, lifetimeController.signal, deps.now);
      const stable = await debounceGeneration({
        directory,
        workerNonce: input.worker_nonce,
        deadline: workerDeadline,
        lifetimeSignal: lifetimeController.signal,
        deps
      });
      if (!stable) return { skipped: 'not_owner', root, directory };
      if (!await revalidateMode()) return disable('mode_changed');
      if (stable.speculative_launches >= MAX_SPECULATIVE_GENERATIONS) {
        return disable('generation_limit');
      }
      const stateGeneration = stable.generation;
      const batchGeneration = stable.speculative_launches + 1;
      await deps.updateWorker(directory, input.worker_nonce, {
        worker_state: 'capturing',
        active_generation: batchGeneration,
        active_review_key: null,
        ready_review_key: null
      });
      const stableCapture = await stableCheckpoint({
        root,
        directory,
        baseline: baselineRecord.snapshot,
        workerNonce: input.worker_nonce,
        initial: pendingCheckpoint,
        mutationMonitor,
        deadline: workerDeadline,
        lifetimeSignal: lifetimeController.signal,
        deps
      });
      const final = stableCapture.checkpoint;
      pendingCheckpoint = null;
      const checkpointDigest = deps.snapshotDigest(final);
      const mutationRevision = stableCapture.mutationRevision;
      const evidence = await deps.buildEvidence({
        baseline: baselineRecord.snapshot,
        final,
        sessionId: input.session_id,
        turnId: input.turn_id,
        maxPatchBytes: mode.max_patch_bytes
      });
      assertWorkerLifetime(workerDeadline, lifetimeController.signal, deps.now);
      const reviewKey = deps.reviewKey({
        input: { session_id: input.session_id, turn_id: input.turn_id },
        mode,
        baseline: baselineRecord.snapshot,
        final,
        evidence,
        summaryGuardConsent: summaryConsent
      });
      const receipt = automaticReceiptFile(runtimeDataDir, root, reviewKey);
      await deps.ensurePrivatePath(runtimeRoot, path.dirname(receipt));
      const existing = await deps.readJson(receipt);
      if (existing?.review_key === reviewKey) {
        await deps.updateWorker(directory, input.worker_nonce, {
          worker_state: 'debouncing', active_generation: null, active_review_key: null,
          ready_review_key: reviewKey
        });
        const next = await waitAfterReady({
          root,
          directory,
          baseline: baselineRecord.snapshot,
          workerNonce: input.worker_nonce,
          stateGeneration,
          reviewKey,
          checkpointDigest,
          mutationMonitor,
          mutationRevision,
          deadline: workerDeadline,
          lifetimeSignal: lifetimeController.signal,
          revalidateMode,
          deps
        });
        if (next.status === 'final_ready') {
          await deps.finishWorker(directory, input.worker_nonce, 'ready', reviewKey);
          return { status: 'ready', reused: true, reviewKey, receipt, root, directory };
        }
        if (next.status === 'changed' && stable.speculative_launches < MAX_SPECULATIVE_GENERATIONS) {
          pendingCheckpoint = next.checkpoint ?? null;
          continue;
        }
        if (next.status === 'mode_changed') return disable('mode_changed');
        await deps.finishWorker(directory, input.worker_nonce, 'superseded');
        return { skipped: next.status, reviewKey, root, directory };
      }
      const current = await deps.readState(directory);
      if (current.generation !== stateGeneration
          || (current.final_requested && current.final_review_key !== null
            && current.final_review_key !== reviewKey)) {
        if (current.generation !== stateGeneration
            && current.speculative_launches < MAX_SPECULATIVE_GENERATIONS
            && !current.final_requested) {
          await deps.updateWorker(directory, input.worker_nonce, {
            worker_state: 'debouncing', active_generation: null, active_review_key: null
          });
          continue;
        }
        await deps.finishWorker(directory, input.worker_nonce, 'superseded');
        return { skipped: 'superseded', reviewKey, root, directory };
      }
      const providerEligible = (evidence.path_evidence ?? []).some(
        (item) => item.transmitted === true && item.disposition === 'complete'
      );
      if (providerEligible && !deps.privacyComplete(evidence.privacy_coverage, 'turn_evidence')) {
        await deps.finishWorker(directory, input.worker_nonce, 'failed');
        return { skipped: 'privacy_coverage_incomplete', reviewKey, root, directory };
      }
      if (!providerEligible) {
        await deps.updateWorker(directory, input.worker_nonce, {
          worker_state: 'debouncing',
          active_generation: null,
          active_review_key: null,
          ready_review_key: null
        });
        const next = await waitAfterReady({
          root,
          directory,
          baseline: baselineRecord.snapshot,
          workerNonce: input.worker_nonce,
          stateGeneration,
          reviewKey,
          checkpointDigest,
          mutationMonitor,
          mutationRevision,
          deadline: workerDeadline,
          lifetimeSignal: lifetimeController.signal,
          revalidateMode,
          deps
        });
        if (next.status === 'changed') {
          pendingCheckpoint = next.checkpoint ?? null;
          continue;
        }
        if (next.status === 'mode_changed') return disable('mode_changed');
        await deps.finishWorker(directory, input.worker_nonce, 'superseded');
        return { skipped: 'non_reviewable_final', reviewKey, root, directory };
      }
      assertWorkerLifetime(workerDeadline, lifetimeController.signal, deps.now);
      const launched = await deps.incrementLaunch(
        directory,
        input.worker_nonce,
        batchGeneration,
        reviewKey
      );
      if (!launched.incremented) return disable('generation_limit');
      const attempt = speculativeAttemptFile(directory, reviewKey);
      await deps.ensurePrivatePath(runtimeRoot, path.dirname(attempt));
      const attemptStored = await deps.writeExclusive(attempt, {
        schema_version: '1',
        review_key: reviewKey,
        generation: batchGeneration,
        started_at: new Date().toISOString()
      });
      if (!attemptStored) {
        const racedReceipt = await deps.readJson(receipt);
        await deps.finishWorker(
          directory,
          input.worker_nonce,
          racedReceipt?.review_key === reviewKey ? 'ready' : 'failed',
          racedReceipt?.review_key === reviewKey ? reviewKey : null
        );
        return racedReceipt?.review_key === reviewKey
          ? { status: 'ready', reused: true, reviewKey, receipt, root, directory }
          : { skipped: 'prior_attempt_incomplete', reviewKey, root, directory };
      }
      const reviewers = reviewersForMode(mode);
      let terminal;
      const controller = new AbortController();
      const expireProvider = () => {
        controller.abort(new DOMException('Speculative worker expired', 'AbortError'));
      };
      lifetimeController.signal.addEventListener('abort', expireProvider, { once: true });
      if (lifetimeController.signal.aborted) expireProvider();
      const monitor = monitorSupersession({
        root,
        directory,
        baseline: baselineRecord.snapshot,
        workerNonce: input.worker_nonce,
        stateGeneration,
        reviewKey,
        checkpointDigest,
        mutationMonitor,
        mutationRevision,
        controller,
        deadline: workerDeadline,
        lifetimeSignal: lifetimeController.signal,
        deps
      });
      let execution;
      try {
        execution = await deps.withProviderLane({ root, dataDir: modeDataDir }, async () => {
          assertWorkerLifetime(workerDeadline, lifetimeController.signal, deps.now);
          const authorization = await deps.withModeLock({ root, dataDir: modeDataDir }, async (lockedMode) => {
            assertWorkerLifetime(workerDeadline, lifetimeController.signal, deps.now);
            if (!lockedMode.enabled || !lockedMode.continuous_review_enabled
                || lockedMode.config_revision !== baselineRecord.mode_revision
                || lockedMode.continuous_review_consented_at !== mode.continuous_review_consented_at) {
              return null;
            }
            const lockedReviewers = reviewersForMode(lockedMode);
            const openStates = await Promise.all(lockedReviewers.map((reviewer) => deps.circuitIsOpen({
              runtimeDataDir,
              root,
              provider: reviewer.provider,
              model: reviewer.model
            })));
            const lanes = lockedReviewers
              .map((reviewer, sourceIndex) => ({ reviewer, sourceIndex, providerAttempted: false }))
              .filter((lane) => !openStates[lane.sourceIndex]);
            if (lanes.length === 0) {
              return { mode: lockedMode, reviewers: lockedReviewers, openStates, issued: null };
            }
            const issued = await issueProviderLanes({
              root, input, mode: lockedMode, modeDataDir, evidence,
              reviewKey, lanes, deps
            });
            return { mode: lockedMode, reviewers: lockedReviewers, openStates, issued };
          });
          if (!authorization) return { disabled: true };
          if (!authorization.issued) {
            const outcomes = authorization.reviewers.map(circuitOpenOutcome);
            const reviewerRuns = outcomes.map((outcome, sourceIndex) => ({
              source_index: sourceIndex,
              provider: outcome.provider,
              model: outcome.model,
              status: 'circuit_open',
              result: null,
              failure: outcome.failure,
              summary_claim_advisory: null,
              provider_run: null,
              egress_capability: null
            }));
            return { failure: new ReviewAggregationError(outcomes), reviewerRuns };
          }
          return executeProviders({
            root,
            runtimeDataDir,
            modeDataDir,
            evidence,
            configuredReviewers: authorization.reviewers,
            openStates: authorization.openStates,
            issued: authorization.issued,
            input,
            reviewKey,
            controller,
            deps
          });
        });
      } finally {
        if (!controller.signal.aborted) controller.abort(new DOMException('Review completed', 'AbortError'));
        await monitor;
        lifetimeController.signal.removeEventListener('abort', expireProvider);
      }
      assertWorkerLifetime(workerDeadline, lifetimeController.signal, deps.now);
      if (execution?.disabled) return disable('mode_changed');
      if (execution?.superseded
          || (await deps.readState(directory)).generation !== stateGeneration) {
        const latest = await deps.readState(directory);
        if (!latest.final_requested
            && latest.speculative_launches < MAX_SPECULATIVE_GENERATIONS
            && latest.worker_nonce === input.worker_nonce) {
          await deps.updateWorker(directory, input.worker_nonce, {
            worker_state: 'debouncing', active_generation: null, active_review_key: null
          });
          continue;
        }
        await deps.finishWorker(directory, input.worker_nonce, 'superseded');
        return { skipped: 'superseded', reviewKey, root, directory };
      }
      terminal = execution.failure
        ? receiptForFailure({ reviewKey, reviewers, reviewerRuns: execution.reviewerRuns })
        : receiptForSuccess({
            reviewKey, reviewers, reviewerRuns: execution.reviewerRuns,
            output: execution.output, baseline: baselineRecord.snapshot, final, evidence
          });
      const currentCheckpoint = await captureCheckpoint({
        root, directory, baseline: baselineRecord.snapshot,
        workerNonce: input.worker_nonce,
        deps
      });
      assertWorkerLifetime(workerDeadline, lifetimeController.signal, deps.now);
      if (deps.snapshotDigest(currentCheckpoint) !== checkpointDigest) {
        const latest = await deps.readState(directory);
        if (!latest.final_requested
            && latest.speculative_launches < MAX_SPECULATIVE_GENERATIONS
            && latest.worker_nonce === input.worker_nonce) {
          pendingCheckpoint = currentCheckpoint;
          await deps.updateWorker(directory, input.worker_nonce, {
            worker_state: 'debouncing', active_generation: null, active_review_key: null,
            ready_review_key: null
          });
          continue;
        }
        await deps.finishWorker(directory, input.worker_nonce, 'superseded');
        return { skipped: 'superseded', reviewKey, root, directory };
      }
      const stored = await deps.writeExclusive(receipt, terminal);
      if (!stored) {
        const raced = await deps.readJson(receipt);
        if (raced?.review_key !== reviewKey) throw new Error('Buddy speculative receipt identity conflict');
      }
      const finalState = await deps.readState(directory);
      if (finalState.generation !== stateGeneration
          || (finalState.final_requested && finalState.final_review_key !== null
            && finalState.final_review_key !== reviewKey)) {
        await deps.finishWorker(directory, input.worker_nonce, 'superseded');
        return { skipped: 'superseded', reviewKey, receipt, root, directory };
      }
      await deps.updateWorker(directory, input.worker_nonce, {
        worker_state: 'debouncing', active_generation: null, active_review_key: null,
        ready_review_key: reviewKey
      });
      const next = await waitAfterReady({
        root, directory, baseline: baselineRecord.snapshot, workerNonce: input.worker_nonce,
        stateGeneration,
        reviewKey,
        checkpointDigest,
        mutationMonitor,
        mutationRevision,
        deadline: workerDeadline,
        lifetimeSignal: lifetimeController.signal,
        revalidateMode,
        deps
      });
      if (next.status === 'final_ready') {
        await deps.finishWorker(directory, input.worker_nonce, 'ready', reviewKey);
        return { status: 'ready', reviewKey, receipt, root, directory };
      }
      const afterReady = await deps.readState(directory);
      if (next.status === 'changed'
          && afterReady.speculative_launches < MAX_SPECULATIVE_GENERATIONS
          && !afterReady.final_requested) {
        pendingCheckpoint = next.checkpoint ?? null;
        continue;
      }
      if (next.status === 'mode_changed') return disable('mode_changed');
      await deps.finishWorker(directory, input.worker_nonce, 'superseded');
      return { skipped: next.status, reviewKey, receipt, root, directory };
    }
  } catch (error) {
    if (error instanceof PreReviewOwnershipLostError) {
      await deps.finishWorker(directory, input.worker_nonce, 'superseded').catch(() => null);
      return { skipped: 'not_owner', root, directory };
    }
    if (error instanceof PreReviewWorkerExpiredError) {
      await deps.finishWorker(directory, input.worker_nonce, 'expired').catch(() => null);
      return { skipped: 'worker_expired', root, directory };
    }
    await deps.finishWorker(directory, input.worker_nonce, 'failed').catch(() => null);
    return { skipped: 'worker_error', error, root, directory };
  } finally {
    deps.clearTimer(lifetimeTimer);
    mutationMonitor?.close();
  }
}
