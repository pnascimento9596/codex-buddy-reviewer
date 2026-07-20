import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPreReviewWorker, startTurnPreReview } from '../src/pre-review.mjs';

const NONCE = 'a'.repeat(48);
const CONSENTED_AT = '2026-07-20T00:00:00.000Z';

function mode(root, overrides = {}) {
  return {
    schema_version: '1',
    policy_version: '4',
    config_revision: 7,
    workspace_root: root,
    enabled: true,
    scope: 'workspace',
    provider: 'grok',
    model: 'grok-4.5',
    effort: 'high',
    secondary_provider: null,
    secondary_model: null,
    secondary_effort: null,
    min_confidence: 0.75,
    max_patch_bytes: 262144,
    timeout_ms: 10_000,
    continuous_review_enabled: true,
    continuous_review_consented_at: CONSENTED_AT,
    consented_at: CONSENTED_AT,
    updated_at: CONSENTED_AT,
    ...overrides
  };
}

function snapshot(root, id) {
  return {
    schema_version: '1',
    repository_root: root,
    tree: id.repeat(40).slice(0, 40),
    privacy_fragment_salt: 'b'.repeat(64),
    id
  };
}

function evidence(root, id, overrides = {}) {
  return {
    repository_root: root,
    changed_paths: ['src/example.mjs'],
    excluded_paths: [],
    sensitive_change_count: 0,
    ignored_change_count: 0,
    path_evidence: [{ path: 'src/example.mjs', transmitted: true, disposition: 'complete' }],
    privacy_coverage: { id: 'complete' },
    patch_hash: id.repeat(64).slice(0, 64),
    ...overrides
  };
}

function reviewResult() {
  return {
    provider: 'grok',
    model: 'grok-4.5',
    result: {
      schema_version: '2',
      status: 'no_findings',
      summary: 'No validated defect findings were reported.',
      findings: [],
      comments: []
    },
    run: { exitCode: 0 }
  };
}

async function harness(overrides = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'buddy-pre-review-test-'));
  const root = path.join(temp, 'repo');
  const runtimeDataDir = path.join(temp, 'runtime');
  const modeDataDir = path.join(temp, 'mode');
  const baseline = snapshot(root, '0');
  const stored = new Map();
  const writes = [];
  const events = [];
  const circuitRecords = [];
  const captures = [...(overrides.captures ?? [
    snapshot(root, '1'), snapshot(root, '1'), snapshot(root, '1'), snapshot(root, '1')
  ])];
  let state = {
    schema_version: '1',
    generation: 1,
    speculative_launches: 0,
    worker_nonce: NONCE,
    worker_state: 'starting',
    active_generation: null,
    active_review_key: null,
    ready_review_key: null,
    final_requested: false,
    final_review_key: null,
    updated_at: CONSENTED_AT
  };
  let reviewCalls = 0;
  let capabilityIssues = 0;
  let captureCalls = 0;
  let pauses = 0;
  let receiptWrites = 0;
  const options = {
    runtimeDataDir,
    modeDataDir,
    resolveRoot: async () => root,
    ensurePrivatePath: async () => {},
    readMode: async () => mode(root, overrides.mode),
    withModeLock: async (_options, callback) => callback(mode(root, overrides.mode)),
    platformPolicy: () => ({ allowed: true }),
    readSummaryConsent: async () => ({ enabled: Boolean(overrides.summaryGuard) }),
    claimWorker: async (_directory, nonce) => {
      const claimed = state.worker_nonce === nonce && state.worker_state === 'starting';
      if (claimed) state = { ...state, worker_state: 'debouncing' };
      return { claimed, state };
    },
    readState: async () => ({ ...state }),
    updateWorker: async (_directory, nonce, update) => {
      if (state.worker_nonce !== nonce) return { updated: false, state };
      state = { ...state, ...update };
      return { updated: true, state };
    },
    incrementLaunch: async (_directory, nonce, generation, reviewKey) => {
      if (state.worker_nonce !== nonce || state.speculative_launches >= 2) {
        return { incremented: false, state };
      }
      state = {
        ...state,
        speculative_launches: state.speculative_launches + 1,
        worker_state: 'reviewing',
        active_generation: generation,
        active_review_key: reviewKey
      };
      return { incremented: true, state };
    },
    finishWorker: async (_directory, nonce, status, readyReviewKey = null) => {
      if (state.worker_nonce === nonce) {
        state = {
          ...state,
          worker_nonce: null,
          worker_state: status,
          active_generation: null,
          active_review_key: null,
          ready_review_key: status === 'ready' ? readyReviewKey : null
        };
      }
      return state;
    },
    readJson: async (file) => {
      if (path.basename(file) === 'baseline.json') {
        return { schema_version: '1', mode_revision: 7, snapshot: baseline };
      }
      if (overrides.existingReceipt && file.includes(`${path.sep}automatic-reviews${path.sep}`)) {
        const reviewKey = path.basename(file, '.json');
        state = { ...state, final_requested: true, final_review_key: reviewKey };
        return { schema_version: '1', review_key: reviewKey, terminal_status: 'no_findings' };
      }
      return stored.get(file) ?? null;
    },
    writeExclusive: async (file, value) => {
      writes.push({ file, value: structuredClone(value) });
      if (stored.has(file)) return false;
      stored.set(file, structuredClone(value));
      if (file.includes(`${path.sep}automatic-reviews${path.sep}`)) {
        receiptWrites += 1;
        const finalAfter = overrides.finalAfterReceiptCount ?? 1;
        if (!overrides.noFinalRequest && receiptWrites >= finalAfter) {
          state = { ...state, final_requested: true, final_review_key: value.review_key };
        }
      }
      return true;
    },
    captureSnapshot: async () => {
      captureCalls += 1;
      const next = captures.shift();
      if (!next) throw new Error('unexpected checkpoint capture');
      if (overrides.onCapture) await overrides.onCapture({ captureCalls, state, setState: (nextState) => { state = nextState; } });
      return next;
    },
    snapshotDigest: (value) => value.id,
    buildEvidence: async ({ final }) => evidence(root, final.id, overrides.evidence),
    privacyComplete: () => overrides.privacyComplete ?? true,
    reviewKey: ({ final }) => final.id.repeat(64).slice(0, 64),
    prepareRequest: () => ({ prompt: 'privacy filtered patch', responseSchema: {}, summaryGuardPacket: null }),
    approveRequest: () => Object.freeze({ approved: true }),
    issueCapabilities: async ({ entries }) => {
      capabilityIssues += 1;
      return entries.map((_entry, index) => Object.freeze({ capability_id: String(index) }));
    },
    spendCapability: async (_options, executor) => ({
      value: await executor(Object.freeze({ approved: true })),
      audit: { schema_version: '1' }
    }),
    withProviderLane: async (_options, callback) => callback(),
    circuitIsOpen: async ({ provider, model }) => (overrides.openCircuits ?? [])
      .some((item) => item.provider === provider && item.model === model),
    recordCircuit: async ({ provider, model }, succeeded) => {
      circuitRecords.push({ provider, model, succeeded });
    },
    review: async (_turnEvidence, reviewOptions) => {
      reviewCalls += 1;
      if (overrides.review) return overrides.review(reviewOptions);
      return reviewResult();
    },
    emit: async (event) => {
      events.push(structuredClone(event));
      return { event };
    },
    withSnapshotActivity: async (_directory, callback) => callback(),
    pause: async (milliseconds) => {
      pauses += 1;
      if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
      else await Promise.resolve();
    },
    debounceMs: 0,
    checkpointPollMs: 10,
    ...overrides.options
  };
  const input = {
    cwd: root,
    session_id: 'session-safe',
    turn_id: 'turn-safe',
    worker_nonce: NONCE,
    runtime_data_dir: runtimeDataDir,
    mode_data_dir: modeDataDir
  };
  return {
    input,
    options,
    root,
    runtimeDataDir,
    modeDataDir,
    stored,
    writes,
    events,
    circuitRecords,
    state: () => state,
    setState: (next) => { state = next; },
    metrics: () => ({ reviewCalls, capabilityIssues, captureCalls, pauses, receiptWrites })
  };
}

test('start payload contains only opaque identity and data-directory fields', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'buddy-pre-review-start-'));
  const root = path.join(temp, 'repo');
  let launchedPayload = null;
  const result = await startTurnPreReview({
    cwd: root,
    session_id: 'session',
    turn_id: 'turn',
    runtime_data_dir: path.join(temp, 'runtime')
  }, {
    resolveRoot: async () => root,
    ensurePrivatePath: async () => {},
    noteMutation: async () => ({
      launched: true,
      workerNonce: NONCE,
      state: { worker_state: 'starting' }
    }),
    launchWorker: async (payload) => {
      launchedPayload = structuredClone(payload);
      return { pid: 12 };
    }
  });
  assert.equal(result.status, 'started');
  assert.deepEqual(Object.keys(launchedPayload).sort(), [
    'cwd', 'runtime_data_dir', 'session_id', 'turn_id', 'worker_nonce'
  ]);
  assert.equal(JSON.stringify(launchedPayload).includes('prompt'), false);
  assert.equal(JSON.stringify(launchedPayload).includes('tool'), false);
  await assert.rejects(
    startTurnPreReview({ cwd: root, session_id: 's', turn_id: 't', tool_input: { secret: 'x' } }),
    /unsupported or missing fields/
  );
});

test('debounces exact checkpoint changes and reviews only the stable generation', async () => {
  const seed = await harness({ captures: [] });
  let index = 0;
  const values = [
    snapshot(seed.root, '1'), snapshot(seed.root, '2'), snapshot(seed.root, '2'), snapshot(seed.root, '2')
  ];
  seed.options.captureSnapshot = async () => values[index++];
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.status, 'ready', result.error?.stack ?? JSON.stringify(result));
  assert.equal(result.reviewKey, '2'.repeat(64));
  assert.equal(seed.metrics().reviewCalls, 1);
  assert.equal(seed.metrics().capabilityIssues, 1);
  assert.ok(index >= 4);
});

test('writes an exact immutable receipt and no completed or XP state', async () => {
  const seed = await harness();
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.status, 'ready', result.error?.stack ?? JSON.stringify(result));
  const receiptWrite = seed.writes.find(({ file }) => file.includes(`${path.sep}automatic-reviews${path.sep}`));
  assert.equal(receiptWrite.value.review_key, '1'.repeat(64));
  assert.equal(receiptWrite.value.result.status, 'no_findings');
  assert.equal(seed.writes.some(({ file }) => path.basename(file) === 'completed.json'), false);
  assert.equal(seed.writes.some(({ file }) => /presentation|xp|profile/u.test(file)), false);
  assert.equal(seed.events.some((event) => event.result || event.reviews), false);
});

test('successful speculative review resets only its exact provider circuit', async () => {
  const seed = await harness();
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.status, 'ready', result.error?.stack ?? JSON.stringify(result));
  assert.deepEqual(seed.circuitRecords, [{
    provider: 'grok',
    model: 'grok-4.5',
    succeeded: true
  }]);
});

test('ordinary speculative provider failure increments its exact circuit', async () => {
  const seed = await harness({
    review: async () => {
      const error = new Error('ordinary provider failure');
      error.failureCode = 'transport_exit';
      throw error;
    }
  });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.status, 'ready', result.error?.stack ?? JSON.stringify(result));
  assert.deepEqual(seed.circuitRecords, [{
    provider: 'grok',
    model: 'grok-4.5',
    succeeded: false
  }]);
  const receipt = seed.writes.find(({ file }) => file.includes(`${path.sep}automatic-reviews${path.sep}`));
  assert.equal(receipt.value.terminal_status, 'provider_unavailable');
  assert.equal(receipt.value.reviewer_runs[0].failure.failure_code, 'transport_exit');
});

test('all-open speculative circuits write an exact failure receipt without provider calls', async () => {
  const seed = await harness({
    openCircuits: [{ provider: 'grok', model: 'grok-4.5' }]
  });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.status, 'ready', result.error?.stack ?? JSON.stringify(result));
  assert.equal(seed.metrics().reviewCalls, 0);
  assert.equal(seed.metrics().capabilityIssues, 0);
  assert.deepEqual(seed.circuitRecords, []);
  const receipt = seed.writes.find(({ file }) => file.includes(`${path.sep}automatic-reviews${path.sep}`));
  assert.equal(receipt.value.review_key, result.reviewKey);
  assert.equal(receipt.value.terminal_status, 'provider_unavailable');
  assert.equal(receipt.value.failure_code, 'no_successful_reviews');
  assert.deepEqual(receipt.value.reviewer_runs.map((run) => run.status), ['circuit_open']);
  assert.equal(seed.events.some((event) => event.type === 'review_started'), false);
});

test('background start publication cannot delay consumed provider entry', async () => {
  let releaseEmission;
  let providerEnteredResolve;
  let emissionCalls = 0;
  const providerEntered = new Promise((resolve) => { providerEnteredResolve = resolve; });
  const seed = await harness({
    options: {
      emit: async () => {
        emissionCalls += 1;
        return new Promise((resolve) => { releaseEmission = resolve; });
      },
      review: async () => {
        providerEnteredResolve();
        return reviewResult();
      }
    }
  });
  const running = runPreReviewWorker(seed.input, seed.options);
  await providerEntered;
  assert.equal(emissionCalls, 1);
  assert.equal(typeof releaseEmission, 'function');
  releaseEmission({ stored: true });
  const result = await running;
  assert.equal(result.status, 'ready', result.error?.stack ?? JSON.stringify(result));
});

test('synchronous start publication failure cannot fail a settled provider batch', async () => {
  let reviewCalls = 0;
  const seed = await harness({
    options: {
      emit: () => {
        throw new Error('local outbox unavailable');
      },
      review: async () => {
        reviewCalls += 1;
        return reviewResult();
      }
    }
  });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.status, 'ready', result.error?.stack ?? JSON.stringify(result));
  assert.equal(reviewCalls, 1);
  assert.equal(result.skipped, undefined);
});

test('dual speculative reviewers emit one start event at the dispatch boundary', async () => {
  const seed = await harness({
    mode: {
      secondary_provider: 'claude',
      secondary_model: 'claude-opus-4-8',
      secondary_effort: 'high'
    },
    review: async (reviewOptions) => {
      const { run: _run, ...reviewed } = reviewResult();
      return {
        ...reviewed,
        provider: reviewOptions.provider,
        model: reviewOptions.model
      };
    }
  });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.status, 'ready', result.error?.stack ?? JSON.stringify(result));
  assert.equal(seed.metrics().reviewCalls, 2);
  assert.equal(seed.events.filter((event) => event.type === 'review_started').length, 1);
});

test('mode revocation before capability execution emits no start event', async () => {
  const seed = await harness({
    options: {
      withModeLock: async (_options, callback) => callback(mode(seed.root, {
        enabled: false,
        continuous_review_enabled: false
      }))
    }
  });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.skipped, 'mode_changed', result.error?.stack ?? JSON.stringify(result));
  assert.equal(seed.metrics().reviewCalls, 0);
  assert.equal(seed.metrics().capabilityIssues, 0);
  assert.equal(seed.events.some((event) => event.type === 'review_started'), false);
});

test('an open speculative lane does not suppress a healthy secondary reviewer', async () => {
  const seed = await harness({
    mode: {
      secondary_provider: 'claude',
      secondary_model: 'claude-opus-4-8',
      secondary_effort: 'high'
    },
    openCircuits: [{ provider: 'grok', model: 'grok-4.5' }],
    review: async (reviewOptions) => {
      const { run: _run, ...reviewed } = reviewResult();
      return {
        ...reviewed,
        provider: reviewOptions.provider,
        model: reviewOptions.model
      };
    }
  });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.status, 'ready', result.error?.stack ?? JSON.stringify(result));
  assert.equal(seed.metrics().reviewCalls, 1);
  assert.equal(seed.metrics().capabilityIssues, 1);
  assert.deepEqual(seed.circuitRecords, [{
    provider: 'claude',
    model: 'claude-opus-4-8',
    succeeded: true
  }]);
  const receipt = seed.writes.find(({ file }) => file.includes(`${path.sep}automatic-reviews${path.sep}`));
  assert.deepEqual(receipt.value.reviewer_runs.map((run) => run.status), ['circuit_open', 'succeeded']);
  assert.equal(receipt.value.result.status, 'no_findings');
  assert.match(receipt.value.result.summary, /1 of 2 reviewer runs succeeded/u);
});

test('adopts only the receipt whose exact checkpoint key matches', async () => {
  const seed = await harness({ existingReceipt: true });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.status, 'ready', result.error?.stack ?? JSON.stringify(result));
  assert.equal(result.reused, true);
  assert.equal(result.reviewKey, '1'.repeat(64));
  assert.equal(seed.metrics().reviewCalls, 0);
  assert.equal(seed.metrics().capabilityIssues, 0);
  assert.equal(seed.writes.length, 0);
});

test('skips speculative review when summary guard is enabled', async () => {
  const seed = await harness({ summaryGuard: true });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.skipped, 'summary_guard_enabled');
  assert.deepEqual(seed.metrics(), {
    reviewCalls: 0, capabilityIssues: 0, captureCalls: 0, pauses: 0, receiptWrites: 0
  });
  assert.equal(seed.writes.length, 0);
});

test('blocks provider authorization when current privacy coverage is incomplete', async () => {
  const seed = await harness({ privacyComplete: false, noFinalRequest: true });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.skipped, 'privacy_coverage_incomplete');
  assert.equal(seed.metrics().reviewCalls, 0);
  assert.equal(seed.metrics().capabilityIssues, 0);
  assert.equal(seed.writes.length, 0);
});

test('unchanged or non-reviewable checkpoints wait without consuming a speculative generation', async () => {
  const seed = await harness({
    noFinalRequest: true,
    evidence: {
      changed_paths: [],
      path_evidence: []
    },
    onCapture: async ({ captureCalls, state, setState }) => {
      if (captureCalls === 3) {
        setState({
          ...state,
          final_requested: true,
          final_review_key: '1'.repeat(64)
        });
      }
    },
    options: { checkpointPollMs: 0, statePollMs: 0 }
  });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.skipped, 'non_reviewable_final', result.error?.stack ?? JSON.stringify(result));
  assert.equal(seed.state().speculative_launches, 0);
  assert.equal(seed.metrics().reviewCalls, 0);
  assert.equal(seed.metrics().capabilityIssues, 0);
  assert.equal(seed.metrics().receiptWrites, 0);
  assert.equal(seed.writes.length, 0);
});

test('idle worker expires at its injected absolute deadline and releases final fallback ownership', async () => {
  let clock = 0;
  const seed = await harness({
    noFinalRequest: true,
    evidence: {
      changed_paths: [],
      path_evidence: []
    },
    options: {
      workerLifetimeMs: 10,
      debounceMs: 2,
      statePollMs: 2,
      checkpointPollMs: 2,
      modeRevalidateMs: 2,
      now: () => clock,
      pause: async (milliseconds) => { clock += milliseconds; },
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {}
    }
  });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.skipped, 'worker_expired', result.error?.stack ?? JSON.stringify(result));
  assert.equal(clock, 10);
  assert.equal(seed.state().worker_state, 'expired');
  assert.equal(seed.state().worker_nonce, null);
  assert.equal(seed.state().active_review_key, null);
  assert.equal(seed.metrics().reviewCalls, 0);
  assert.equal(seed.writes.some(({ file }) => file.includes('pre-review-attempts')), false);
  assert.equal(seed.writes.some(({ file }) => file.includes(`${path.sep}automatic-reviews${path.sep}`)), false);
});

test('absolute expiry aborts an in-flight provider without penalizing its circuit', async () => {
  let expireWorker;
  let providerSignal;
  const seed = await harness({
    noFinalRequest: true,
    review: async (reviewOptions) => {
      providerSignal = reviewOptions.signal;
      return new Promise((resolve, reject) => {
        reviewOptions.signal.addEventListener('abort', () => {
          const error = new Error('cancelled by absolute worker expiry');
          error.failureCode = 'cancelled';
          reject(error);
        }, { once: true });
        expireWorker();
      });
    },
    options: {
      workerLifetimeMs: 1_000,
      setTimer: (callback) => {
        expireWorker = callback;
        return { unref() {} };
      },
      clearTimer: () => {}
    }
  });
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.skipped, 'worker_expired', result.error?.stack ?? JSON.stringify(result));
  assert.equal(providerSignal.aborted, true);
  assert.equal(seed.state().worker_state, 'expired');
  assert.deepEqual(seed.circuitRecords, []);
  assert.equal(seed.writes.filter(({ file }) => file.includes('pre-review-attempts')).length, 1);
  assert.equal(seed.writes.some(({ file }) => file.includes(`${path.sep}automatic-reviews${path.sep}`)), false);
});

test('idle worker revalidates mode and yields without provider dispatch', async () => {
  const seed = await harness({
    noFinalRequest: true,
    evidence: {
      changed_paths: [],
      path_evidence: []
    },
    options: { modeRevalidateMs: 1 }
  });
  let reads = 0;
  seed.options.readMode = async () => {
    reads += 1;
    return mode(seed.root, reads >= 3 ? {
      enabled: false,
      continuous_review_enabled: false
    } : {});
  };
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.skipped, 'mode_changed', result.error?.stack ?? JSON.stringify(result));
  assert.ok(reads >= 3);
  assert.equal(seed.state().worker_state, 'disabled');
  assert.equal(seed.metrics().reviewCalls, 0);
  assert.equal(seed.events.some((event) => event.type === 'review_started'), false);
});

test('worker lifetime rejects an unbounded 24-hour configuration', async () => {
  await assert.rejects(
    runPreReviewWorker({
      cwd: '/tmp/repo',
      session_id: 'session',
      turn_id: 'turn',
      worker_nonce: NONCE
    }, { workerLifetimeMs: 24 * 60 * 60 * 1_000 }),
    /below 24 hours/
  );
});

test('aborts a stale provider batch without publishing a receipt', async () => {
  let providerSignal = null;
  const seed = await harness({
    captures: [],
    noFinalRequest: true,
    review: async (reviewOptions) => {
      providerSignal = reviewOptions.signal;
      return new Promise((resolve, reject) => {
        reviewOptions.signal.addEventListener('abort', () => {
          const error = new Error('cancelled by exact checkpoint supersession');
          error.failureCode = 'cancelled';
          reject(error);
        }, { once: true });
      });
    }
  });
  seed.options.checkpointPollMs = 0;
  const values = [snapshot(seed.root, '1'), snapshot(seed.root, '1'), snapshot(seed.root, '2')];
  let index = 0;
  seed.options.captureSnapshot = async () => {
    const value = values[index++];
    if (index === 3) {
      const current = seed.state();
      seed.setState({
        ...current,
        final_requested: true,
        final_review_key: 'f'.repeat(64)
      });
    }
    return value;
  };
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.skipped, 'superseded', result.error?.stack ?? JSON.stringify(result));
  assert.equal(providerSignal.aborted, true);
  assert.equal(seed.state().worker_state, 'superseded');
  assert.equal(seed.writes.some(({ file }) => file.includes(`${path.sep}automatic-reviews${path.sep}`)), false);
  assert.equal(seed.writes.some(({ file }) => file.includes(`${path.sep}circuits${path.sep}`)), false);
  assert.deepEqual(seed.circuitRecords, []);
  assert.equal(seed.writes.filter(({ file }) => file.includes('pre-review-attempts')).length, 1);
  assert.equal(seed.events.some((event) => ['review_completed', 'review_degraded'].includes(event.type)), false);
});

test('runs at most two stable speculative generations', async () => {
  const seed = await harness({ captures: [], noFinalRequest: true });
  const values = [
    snapshot(seed.root, '1'), snapshot(seed.root, '1'), snapshot(seed.root, '1'),
    snapshot(seed.root, '2'), snapshot(seed.root, '2'), snapshot(seed.root, '2'),
    snapshot(seed.root, '3')
  ];
  let index = 0;
  seed.options.captureSnapshot = async () => values[index++];
  const result = await runPreReviewWorker(seed.input, seed.options);
  assert.equal(result.skipped, 'changed', result.error?.stack ?? JSON.stringify(result));
  assert.equal(seed.metrics().reviewCalls, 2);
  assert.equal(seed.metrics().capabilityIssues, 2);
  assert.equal(seed.metrics().receiptWrites, 2);
  assert.equal(seed.writes.filter(({ file }) => file.includes('pre-review-attempts')).length, 2);
});
