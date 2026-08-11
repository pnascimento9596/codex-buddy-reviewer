import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CaptureBudgetError } from '../src/capture-budget.mjs';
import { automaticReceiptFile, automaticTurnDirectory } from '../src/automatic-paths.mjs';
import { automaticReceiptDigest } from '../src/automatic-receipt.mjs';
import { prepareReviewRequest, reviewEvidence as reviewEvidenceImpl } from '../src/cli.mjs';
import { egressConfigurationHash, readEgressRegistry } from '../src/egress-capability.mjs';
import { collectEvidence } from '../src/evidence.mjs';
import { writeHookOutput } from '../src/hook-transport.mjs';
import {
  captureTurnStart as captureTurnStartImpl,
  markContinuationStdoutWritten,
  renderContinuation,
  reviewTurnStop as reviewTurnStopImpl
} from '../src/lifecycle.mjs';
import { changeMode, modeFile, readMode, reviewersForMode } from '../src/mode.mjs';
import { appendOutboxEvent, readSequencedOutboxEvents } from '../src/outbox.mjs';
import { runProcess } from '../src/process.mjs';
import { runPreReviewWorker, startTurnPreReview } from '../src/pre-review.mjs';
import { inspectApprovedProviderReviewRequest } from '../src/provider-registry.mjs';
import { reviewKeyFor } from '../src/review-identity.mjs';
import { localReviewResultForEvidence } from '../src/result.mjs';
import { pruneWorkspaceTurns } from '../src/runtime-pruner.mjs';
import { canonicalJson, opaqueKey, withFileLock, workspaceKey } from '../src/state.mjs';
import { buildTurnEvidence, captureTurnSnapshot } from '../src/turn-snapshot.mjs';
import {
  changePresentationProfile,
  readCompletedReviewKeys
} from '../src/presentation-state.mjs';
import {
  changeSummaryClaimGuardConsent,
  buildSummaryClaimGuardPacket,
  readSummaryClaimGuardConsent
} from '../src/summary-claim-guard.mjs';
import { assertNoExclusiveAuthorship } from './helpers/exclusive-authorship.mjs';

const temporaryPaths = [];
const CONCURRENT_STATE_VISIBILITY_TIMEOUT_MS = 10_000;
const CLEAN_FILTER_MARKER_ENV = 'CODEX_BUDDY_CLEAN_FILTER_MARKER';
const CLEAN_FILTER_COMMAND = "node -e \"const fs=require('node:fs');fs.appendFileSync(process.env.CODEX_BUDDY_CLEAN_FILTER_MARKER,'clean\\\\n');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s.replaceAll('RAW_WORKTREE','FILTER_OUTPUT')))\"";
const reviewEvidence = (evidence, options = {}) => reviewEvidenceImpl(evidence, {
  platform: 'linux',
  ...options
});
const captureTurnStart = (input, options = {}) => captureTurnStartImpl(input, {
  platform: 'linux',
  startPreReview: async () => ({ status: 'started' }),
  ...options
});
const reviewTurnStop = (input, options = {}) => reviewTurnStopImpl(input, {
  platform: 'linux',
  ...options
});

function completeWindowsVerification() {
  const root = (classification, value) => Object.freeze({
    class: classification,
    path: value,
    filesystem_acl_capable: true,
    ensured: true,
    verified: true,
    tree_verified: true
  });
  return Object.freeze({
    schema_version: '2',
    platform: 'win32',
    arch: 'x64',
    ok: true,
    failure_code: null,
    message: null,
    helper: Object.freeze({
      verified: true,
      path: 'C:\\trusted\\buddy-job-supervisor.exe',
      arch: 'x64',
      sha256: 'a'.repeat(64),
      protocol_version: '2'
    }),
    filesystem_acl_capable: true,
    roots: Object.freeze([
      root('durable_data', '/fixture/data'),
      root('runtime_data', '/fixture/runtime'),
      root('provider_temp_parent', '/fixture/provider-temp')
    ]),
    assured_paths: Object.freeze([]),
    operation: 'ensure_and_verify'
  });
}

function mutableWindowsPlatformPolicy(env) {
  return () => env.CODEX_BUDDY_WINDOWS_EGRESS_BLOCK === '1'
    ? {
        allowed: false,
        failureCode: 'windows_private_state_kill_switch',
        summary: 'blocked',
        detail: 'kill-switch'
      }
    : { allowed: true };
}

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function git(root, args) {
  return runProcess('git', args, { cwd: root });
}

async function withCleanFilterMarker(marker, operation) {
  const previous = process.env[CLEAN_FILTER_MARKER_ENV];
  process.env[CLEAN_FILTER_MARKER_ENV] = marker;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env[CLEAN_FILTER_MARKER_ENV];
    else process.env[CLEAN_FILTER_MARKER_ENV] = previous;
  }
}

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(target));
    else output.push(target);
  }
  return output;
}

async function makeRepository() {
  const root = await temporaryDirectory('codex-buddy-auto-repo-');
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Buddy Test']);
  await git(root, ['config', 'user.email', 'buddy@example.invalid']);
  await writeFile(path.join(root, 'app.js'), 'const value = 1;\n');
  await git(root, ['add', 'app.js']);
  await git(root, ['commit', '-q', '-m', 'initial']);
  return realpath(root);
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

function turnDirectory(runtimeDataDir, root, sessionId, turnId) {
  return path.join(
    runtimeDataDir,
    'turns',
    workspaceKey(root),
    opaqueKey(sessionId),
    opaqueKey(turnId)
  );
}

function successfulReceipt(
  mode,
  reviewKey,
  context,
  summary = 'No validated defects were reported.',
  { summaryGuardConsent = null, workerSummary = null } = {}
) {
  const result = noFindings(summary);
  const [reviewer] = reviewersForMode(mode);
  const summaryPacket = summaryGuardConsent === null
    ? null
    : buildSummaryClaimGuardPacket({
        consent: summaryGuardConsent,
        reviewKey,
        summary: workerSummary
      });
  const summaryAdvisory = summaryPacket === null ? null : {
    schema_version: '1',
    status: 'no_notes',
    advisory: 'The bounded summary claims are proportionate.',
    notes: []
  };
  const consumedAt = Date.parse('2026-07-20T00:00:01.000Z');
  const egressCapability = {
    schema_version: '1',
    capability_id: 'a'.repeat(64),
    workspace_key: workspaceKey(context.root),
    session_key: opaqueKey(context.input.session_id),
    turn_key: opaqueKey(context.input.turn_id),
    review_key: reviewKey,
    mode_revision: mode.config_revision,
    provider: reviewer.provider,
    model: reviewer.model,
    effort: reviewer.effort,
    timeout_ms: mode.timeout_ms,
    configuration_sha256: egressConfigurationHash({
      provider: reviewer.provider,
      model: reviewer.model,
      effort: reviewer.effort,
      timeout_ms: mode.timeout_ms,
      min_confidence: mode.min_confidence,
      max_patch_bytes: mode.max_patch_bytes
    }),
    approval_sha256: 'b'.repeat(64),
    content_policy_version: '1',
    channel_inventory_sha256: 'c'.repeat(64),
    prompt_sha256: 'd'.repeat(64),
    prompt_bytes: 128,
    response_schema_sha256: 'e'.repeat(64),
    summary_consent_revision: summaryPacket?.consent_revision ?? null,
    summary_sha256: summaryPacket?.summary_sha256 ?? null,
    summary_packet_sha256: summaryPacket === null
      ? null
      : createHash('sha256').update(canonicalJson(summaryPacket)).digest('hex'),
    issued_at: '2026-07-20T00:00:00.000Z',
    consumed_at: new Date(consumedAt).toISOString(),
    deadline_at: new Date(consumedAt + mode.timeout_ms + 10_000).toISOString()
  };
  return {
    schema_version: '1',
    review_key: reviewKey,
    terminal_status: result.status,
    provider: mode.provider,
    model: mode.model,
    baseline_tree: context.baseline.tree,
    final_tree: context.final.tree,
    patch_hash: context.evidence.patch_hash,
    changed_path_count: context.evidence.changed_paths.length,
    excluded_path_count: context.evidence.excluded_paths.length
      + (context.evidence.sensitive_change_count ?? 0)
      + (context.evidence.ignored_change_count ?? 0),
    result,
    reviews: [{
      source_index: 0,
      label: `${mode.provider}/${mode.model}`,
      provider: mode.provider,
      model: mode.model,
      result,
      ...(summaryAdvisory === null ? {} : { summaryAdvisory })
    }],
    review_failures: [],
    review_sources: null,
    reviewer_runs: [{
      source_index: 0,
      provider: mode.provider,
      model: mode.model,
      status: 'succeeded',
      result,
      failure: null,
      summary_claim_advisory: summaryAdvisory,
      provider_run: null,
      egress_capability: egressCapability
    }],
    summary_claim_guard: summaryPacket === null ? null : {
      policy_version: summaryPacket.policy_version,
      consent_revision: summaryPacket.consent_revision,
      summary_sha256: summaryPacket.summary_sha256,
      summary_truncated: summaryPacket.summary_truncated
    },
    summary_claim_advisory: summaryAdvisory,
    provider_run: null,
    egress_capability: egressCapability,
    created_at: new Date().toISOString()
  };
}

function localSuccessReceipt(reviewKey, context) {
  const result = localReviewResultForEvidence(context.evidence);
  assert.notEqual(result, null);
  return {
    schema_version: '1',
    review_key: reviewKey,
    terminal_status: result.status,
    provider: 'none',
    model: 'none',
    baseline_tree: context.baseline.tree,
    final_tree: context.final.tree,
    patch_hash: context.evidence.patch_hash,
    changed_path_count: context.evidence.changed_paths.length,
    excluded_path_count: context.evidence.excluded_paths.length
      + (context.evidence.sensitive_change_count ?? 0)
      + (context.evidence.ignored_change_count ?? 0),
    result,
    reviews: [],
    review_failures: [],
    review_sources: null,
    reviewer_runs: [],
    summary_claim_guard: null,
    summary_claim_advisory: null,
    provider_run: null,
    egress_capability: null,
    created_at: new Date().toISOString()
  };
}

async function prepareDualReviewerTurn({
  secondaryProvider = 'claude',
  secondaryModel,
  sessionId = 'dual-session',
  turnId = 'dual-turn',
  value = 200
} = {}) {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  const mode = await changeMode({
    root,
    action: 'enable',
    dataDir: modeDataDir,
    secondaryProvider,
    ...(secondaryModel ? { secondaryModel } : {})
  });
  const identity = { session_id: sessionId, turn_id: turnId, cwd: root };
  await captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Implement the dual reviewer fixture.'
  }, { modeDataDir, runtimeDataDir });
  await writeFile(path.join(root, 'app.js'), `const value = ${value};\n`);
  return {
    root,
    mode,
    modeDataDir,
    runtimeDataDir,
    stopInput: {
      ...identity,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'Implemented and validated the dual reviewer fixture.'
    }
  };
}

function continuationPayload(reason) {
  const lines = reason.split('\n');
  const startIndex = lines.findIndex((line) => /^BUDDY_REVIEW_DATA_[0-9a-f]{36}_START$/u.test(line));
  assert.notEqual(startIndex, -1);
  return JSON.parse(lines[startIndex + 1]);
}

async function snapshotPair(root, mutate) {
  const snapshotDir = await temporaryDirectory('codex-buddy-snapshot-');
  const baseline = await captureTurnSnapshot({ root, workDir: snapshotDir });
  await mutate();
  const final = await captureTurnSnapshot({
    root, workDir: snapshotDir, privacySalt: baseline.privacy_fragment_salt
  });
  const evidence = await buildTurnEvidence({
    baseline,
    final,
    sessionId: 'session-1',
    turnId: 'turn-1'
  });
  return { baseline, final, evidence };
}

test('dual reviewers start concurrently and preserve configured presentation order', async () => {
  const fixture = await prepareDualReviewerTurn({ turnId: 'dual-concurrent', value: 201 });
  const started = [];
  const releases = new Map();
  let settled = false;
  const stopping = reviewTurnStop(fixture.stopInput, {
    modeDataDir: fixture.modeDataDir,
    runtimeDataDir: fixture.runtimeDataDir,
    review: async (evidence, options) => {
      started.push(options.provider);
      return new Promise((resolve) => {
        releases.set(options.provider, () => resolve({
          evidence,
          provider: options.provider,
          model: options.model,
          result: noFindings(`${options.provider} completed independently.`)
        }));
      });
    }
  });
  stopping.then(() => { settled = true; });

  await waitFor(() => started.length === 2, 'both reviewer lanes to start', 30_000);
  assert.deepEqual(new Set(started), new Set(['ollama', 'claude']));
  releases.get('claude')();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false);
  releases.get('ollama')();

  const stopped = await stopping;
  assert.equal(stopped.result.status, 'no_findings');
  const payload = continuationPayload(stopped.output.reason);
  assert.deepEqual(Object.keys(payload).sort(), ['review_key', 'schema_version', 'visible_review']);
  assert.match(payload.visible_review, /no actionable correctness defect/u);
  assert.doesNotMatch(stopped.output.reason, /completed independently/u);
  const receipt = JSON.parse(await readFile(stopped.receipt, 'utf8'));
  assert.deepEqual(receipt.reviewer_runs.map((run) => run.provider), ['ollama', 'claude']);
  assert.deepEqual(receipt.reviewer_runs.map((run) => run.status), ['succeeded', 'succeeded']);
});

test('one invalid reviewer and one success complete with attributed audit records', async () => {
  const fixture = await prepareDualReviewerTurn({ turnId: 'dual-partial', value: 202 });
  const stopped = await reviewTurnStop(fixture.stopInput, {
    modeDataDir: fixture.modeDataDir,
    runtimeDataDir: fixture.runtimeDataDir,
    review: async (evidence, options) => {
      if (options.provider === 'ollama') {
        return {
          evidence,
          provider: options.provider,
          model: options.model,
          result: {
            schema_version: '1',
            status: 'no_findings',
            summary: 'PRIVATE_INVALID_PROVIDER_PAYLOAD',
            findings: [],
            comments: []
          }
        };
      }
      return {
        evidence,
        provider: options.provider,
        model: options.model,
        result: noFindings('Claude completed the independent review.')
      };
    }
  });

  assert.equal(stopped.result.status, 'no_findings');
  assert.match(stopped.result.summary, /1 of 2 reviewer runs succeeded/);
  const receiptText = await readFile(stopped.receipt, 'utf8');
  assert.doesNotMatch(receiptText, /PRIVATE_INVALID_PROVIDER_PAYLOAD/);
  const receipt = JSON.parse(receiptText);
  assert.deepEqual(receipt.reviewer_runs.map((run) => run.status), ['failed', 'succeeded']);
  assert.equal(receipt.reviewer_runs[0].failure.failure_code, 'invalid_review_schema');
  assert.match(receipt.reviewer_runs[0].egress_capability.capability_id, /^[0-9a-f]{64}$/u);
  assert.match(receipt.reviewer_runs[1].egress_capability.capability_id, /^[0-9a-f]{64}$/u);
  assert.deepEqual(receipt.reviews.map((review) => review.source_index), [1]);
  assert.deepEqual(receipt.review_failures.map((failure) => failure.source_index), [0]);
  const payload = continuationPayload(stopped.output.reason);
  assert.match(payload.visible_review, /partial review/u);
  assert.equal(Object.hasOwn(payload, 'reviews'), false);
  assert.equal(Object.hasOwn(payload, 'review_failures'), false);
  const outbox = await readSequencedOutboxEvents({
    repositoryRoot: fixture.root,
    runtimeDataDir: fixture.runtimeDataDir
  });
  const completed = outbox.events.find((item) => item.event.event_type === 'review_completed');
  assert.deepEqual(
    completed.event.payload.reviews.map(({ provider, status }) => ({ provider, status })),
    [
      { provider: 'ollama', status: 'failed' },
      { provider: 'claude', status: 'succeeded' }
    ]
  );
});

test('two reviewer failures degrade once without fallback or sensitive diagnostics', async () => {
  const fixture = await prepareDualReviewerTurn({ turnId: 'dual-failure', value: 203 });
  let calls = 0;
  const stopped = await reviewTurnStop(fixture.stopInput, {
    modeDataDir: fixture.modeDataDir,
    runtimeDataDir: fixture.runtimeDataDir,
    review: async (_, options) => {
      calls += 1;
      throw new Error(`PRIVATE_${options.provider}_FAILURE`);
    }
  });

  assert.equal(calls, 2);
  assert.match(stopped.output.systemMessage, /no configured reviewer succeeded/);
  const receiptText = await readFile(stopped.receipt, 'utf8');
  assert.doesNotMatch(receiptText, /PRIVATE_.*_FAILURE/u);
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.terminal_status, 'provider_unavailable');
  assert.equal(receipt.failure_code, 'no_successful_reviews');
  assert.deepEqual(receipt.reviewer_runs.map((run) => run.status), ['failed', 'failed']);
  assert.equal(receipt.result, undefined);
});

test('an open primary circuit does not suppress a healthy secondary reviewer or widen summary egress', async () => {
  const fixture = await prepareDualReviewerTurn({ turnId: 'dual-open-primary', value: 204 });
  const circuitDirectory = path.join(
    fixture.runtimeDataDir,
    'circuits',
    workspaceKey(fixture.root)
  );
  await mkdir(circuitDirectory, { recursive: true });
  await writeFile(path.join(
    circuitDirectory,
    `${opaqueKey(`${fixture.mode.provider}\0${fixture.mode.model}`)}.json`
  ), `${JSON.stringify({
    schema_version: '1',
    consecutive_failures: 3,
    open_until: new Date(Date.now() + 60_000).toISOString(),
    updated_at: new Date().toISOString()
  })}\n`);
  await changeSummaryClaimGuardConsent({
    root: fixture.root,
    dataDir: fixture.modeDataDir,
    action: 'enable',
    provider: fixture.mode.provider,
    model: fixture.mode.model,
    confirmSummaryEgress: true
  });
  const calls = [];
  const stopped = await reviewTurnStop(fixture.stopInput, {
    modeDataDir: fixture.modeDataDir,
    runtimeDataDir: fixture.runtimeDataDir,
    review: async (evidence, options) => {
      calls.push(options.provider);
      assert.equal(options.summaryGuardPacket, null);
      return {
        evidence,
        provider: options.provider,
        model: options.model,
        result: noFindings('Healthy secondary reviewer completed.')
      };
    }
  });

  assert.deepEqual(calls, ['claude']);
  assert.equal(stopped.result.status, 'no_findings');
  const receipt = JSON.parse(await readFile(stopped.receipt, 'utf8'));
  assert.deepEqual(receipt.reviewer_runs.map((run) => run.status), ['circuit_open', 'succeeded']);
  assert.equal(receipt.summary_claim_guard, null);
  assert.equal(receipt.reviewer_runs[1].egress_capability.summary_sha256, null);
});

test('summary consent remains bound to the primary reviewer and secondary stays technical-only', async () => {
  const fixture = await prepareDualReviewerTurn({ turnId: 'dual-summary', value: 205 });
  await changeSummaryClaimGuardConsent({
    root: fixture.root,
    dataDir: fixture.modeDataDir,
    action: 'enable',
    provider: fixture.mode.provider,
    model: fixture.mode.model,
    confirmSummaryEgress: true
  });
  const packets = new Map();
  const approvedRequests = [];
  const stopped = await reviewTurnStop(fixture.stopInput, {
    modeDataDir: fixture.modeDataDir,
    runtimeDataDir: fixture.runtimeDataDir,
    review: async (evidence, options) => {
      packets.set(options.provider, options.summaryGuardPacket);
      const approved = inspectApprovedProviderReviewRequest(options.approvedRequest);
      const technicalBytes = Buffer.from(canonicalJson(evidence), 'utf8');
      approvedRequests.push({
        provider: approved.provider,
        channelInventory: approved.channelInventory,
        technicalBytes,
        technicalSha256: createHash('sha256').update(technicalBytes).digest('hex')
      });
      return {
        evidence,
        provider: options.provider,
        model: options.model,
        result: noFindings(`${options.provider} completed.`),
        ...(options.summaryGuardPacket ? {
          summaryAdvisory: {
            schema_version: '1',
            status: 'no_notes',
            advisory: 'The bounded summary claims are proportionate.',
            notes: []
          }
        } : {})
      };
    }
  });

  // This proves that both lane callbacks receive the same canonical evidence object bytes
  // and that each approved request advertises the intended channel inventory. It does not
  // prove approved-request-derived technical digest equality; that would require a runtime
  // metadata seam, which this test-only lane intentionally does not add.
  const approvedByProvider = new Map(
    approvedRequests.map((request) => [request.provider, request])
  );
  assert.deepEqual([...approvedByProvider.keys()].sort(), ['claude', 'ollama']);
  assert.deepEqual(
    approvedByProvider.get('ollama').technicalBytes,
    approvedByProvider.get('claude').technicalBytes
  );
  assert.equal(
    approvedByProvider.get('ollama').technicalSha256,
    approvedByProvider.get('claude').technicalSha256
  );
  assert.deepEqual(
    approvedByProvider.get('ollama').channelInventory,
    ['technical_evidence', 'worker_summary']
  );
  assert.deepEqual(approvedByProvider.get('claude').channelInventory, ['technical_evidence']);
  assert.equal(packets.get('ollama').summary, fixture.stopInput.last_assistant_message);
  assert.equal(packets.get('claude'), null);
  const receipt = JSON.parse(await readFile(stopped.receipt, 'utf8'));
  assert.equal(receipt.summary_claim_guard !== null, true);
  assert.equal(receipt.reviewer_runs[0].egress_capability.summary_sha256 !== null, true);
  assert.equal(receipt.reviewer_runs[1].egress_capability.summary_sha256, null);
});

test('review idempotency key binds the configured reviewer order', async () => {
  const root = await makeRepository();
  const identity = { session_id: 'ordered-key-session', turn_id: 'ordered-key-turn', cwd: root };
  const runWithOrder = async (provider, secondaryProvider) => {
    const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
    const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
    await changeMode({
      root,
      action: 'enable',
      dataDir: modeDataDir,
      provider,
      secondaryProvider
    });
    await captureTurnStart({
      ...identity,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Create the same deterministic delta.'
    }, { modeDataDir, runtimeDataDir });
    await writeFile(path.join(root, 'app.js'), 'const value = 206;\n');
    return reviewTurnStop({
      ...identity,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'Created the same deterministic delta.'
    }, {
      modeDataDir,
      runtimeDataDir,
      review: async (evidence, options) => ({
        evidence,
        provider: options.provider,
        model: options.model,
        result: noFindings(`${options.provider} completed.`)
      })
    });
  };

  const first = await runWithOrder('ollama', 'claude');
  await writeFile(path.join(root, 'app.js'), 'const value = 1;\n');
  const second = await runWithOrder('claude', 'ollama');
  assert.notEqual(first.reviewKey, second.reviewKey);
  assert.deepEqual(
    JSON.parse(await readFile(first.receipt, 'utf8')).reviewer_runs.map((run) => run.provider),
    ['ollama', 'claude']
  );
  assert.deepEqual(
    JSON.parse(await readFile(second.receipt, 'utf8')).reviewer_runs.map((run) => run.provider),
    ['claude', 'ollama']
  );
});

test('provider attempt is not burned while a different turn holds mode authorization', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'authorization-wait-session', turn_id: 'authorization-wait-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it.' }, {
    modeDataDir,
    runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 22;\n');

  let lockHeld;
  const held = new Promise((resolve) => { lockHeld = resolve; });
  let releaseLock;
  const release = new Promise((resolve) => { releaseLock = resolve; });
  const holding = withFileLock(modeFile(root, modeDataDir), async () => {
    lockHeld();
    await release;
  }, { timeoutMs: 10_000, staleMs: 10_000 });
  await held;

  let finalCaptured;
  const captured = new Promise((resolve) => { finalCaptured = resolve; });
  let reviewCalls = 0;
  const stopping = reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Implemented the queued review fixture.'
  }, {
    modeDataDir,
    runtimeDataDir,
    captureSnapshot: async (snapshotOptions) => {
      const snapshot = await captureTurnSnapshot(snapshotOptions);
      finalCaptured();
      return snapshot;
    },
    review: async (evidence) => {
      reviewCalls += 1;
      return {
        evidence,
        provider: 'ollama',
        model: 'glm-5.2:cloud',
        result: {
          schema_version: '2', status: 'no_findings', summary: 'No validated defects.', findings: [], comments: []
        }
      };
    }
  });
  await captured;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const turnRoot = path.join(
    runtimeDataDir,
    'turns',
    workspaceKey(root),
    opaqueKey(identity.session_id),
    opaqueKey(identity.turn_id)
  );
  await assert.rejects(access(path.join(turnRoot, 'attempt.json')));
  assert.equal(reviewCalls, 0);
  releaseLock();
  await holding;
  const stopped = await stopping;
  assert.equal(reviewCalls, 1);
  assert.equal(stopped.result.status, 'no_findings');
});

test('tampered Ollama effort fails before attempt, capability issuance, provider call, or circuit charge', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir, provider: 'ollama' });
  const identity = {
    session_id: 'invalid-ollama-effort-session',
    turn_id: 'invalid-ollama-effort-turn',
    cwd: root
  };
  await captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Exercise invalid Ollama effort authorization.'
  }, { modeDataDir, runtimeDataDir });
  await writeFile(path.join(root, 'app.js'), 'const value = 93;\n');
  const file = modeFile(root, modeDataDir);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify({ ...stored, effort: 'xhigh' })}\n`, { mode: 0o600 });

  let reviewCalls = 0;
  await assert.rejects(
    reviewTurnStop({
      ...identity,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'Completed the invalid effort fixture.'
    }, {
      modeDataDir,
      runtimeDataDir,
      review: async () => {
        reviewCalls += 1;
        throw new Error('review must not start');
      }
    }),
    /Invalid Buddy reasoning effort for ollama/
  );
  assert.equal(reviewCalls, 0);
  const turnRoot = path.join(
    runtimeDataDir,
    'turns',
    workspaceKey(root),
    opaqueKey(identity.session_id),
    opaqueKey(identity.turn_id)
  );
  await assert.rejects(access(path.join(turnRoot, 'attempt.json')));
  assert.deepEqual((await readEgressRegistry({ root, dataDir: modeDataDir })).active, []);
  assert.deepEqual(await filesBelow(path.join(runtimeDataDir, 'circuits')), []);
});

test('manual review reverification preserves explicit Windows path-resolution inputs', async () => {
  const root = await makeRepository();
  const { evidence } = await snapshotPair(root, async () => {
    await writeFile(path.join(root, 'app.js'), 'const value = 951;\n');
  });
  const dataDir = '/fixture/Buddy/manual-mode';
  const runtimeDataDir = '/fixture/Buddy/manual-runtime';
  const providerTempBase = '/fixture/Buddy/manual-temp';
  let observed = null;
  await assert.rejects(reviewEvidence(evidence, {
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    effort: 'high',
    timeoutMs: 1_000,
    minConfidence: 0.75,
    store: false,
    platform: 'win32',
    arch: 'x64',
    env: {},
    dataDir,
    runtimeDataDir,
    providerTempBase,
    windowsPrivateStateVerification: completeWindowsVerification(),
    reverifyWindowsPrivateStateRoots: async (_verification, options) => {
      observed = options;
      return completeWindowsVerification();
    }
  }));
  assert.equal(observed.dataDir, dataDir);
  assert.equal(observed.runtimeDataDir, runtimeDataDir);
  assert.equal(observed.tempBase, providerTempBase);
});

test('lifecycle rechecks the Windows kill-switch before capability issuance', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir, provider: 'ollama' });
  const identity = { session_id: 'windows-issue-kill-session', turn_id: 'windows-issue-kill-turn', cwd: root };
  const env = {};
  const verification = completeWindowsVerification();
  const windowsOptions = {
    platform: 'win32',
    arch: 'x64',
    env,
    ensureWindowsPrivateState: async () => verification,
    platformPolicy: mutableWindowsPlatformPolicy(env)
  };
  await captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Exercise the lifecycle issuance kill-switch.'
  }, { modeDataDir, runtimeDataDir, ...windowsOptions });
  await writeFile(path.join(root, 'app.js'), 'const value = 951;\n');
  let reviewCalls = 0;
  const stopped = await reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Completed the lifecycle issuance fixture.'
  }, {
    modeDataDir,
    runtimeDataDir,
    ...windowsOptions,
    reverifyWindowsPrivateState: async () => {
      env.CODEX_BUDDY_WINDOWS_EGRESS_BLOCK = '1';
      return verification;
    },
    review: async () => {
      reviewCalls += 1;
      throw new Error('review must not start');
    }
  });
  assert.equal(reviewCalls, 0);
  assert.equal(stopped.error.failureCode, 'windows_private_state_kill_switch');
  assert.deepEqual((await readEgressRegistry({ root, dataDir: modeDataDir })).active, []);
  const turnRoot = automaticTurnDirectory(runtimeDataDir, root, identity.session_id, identity.turn_id);
  await assert.rejects(access(path.join(turnRoot, 'attempt.json')));
  assert.deepEqual(await filesBelow(path.join(runtimeDataDir, 'circuits')), []);
});

test('lifecycle rechecks the Windows kill-switch at capability executor entry', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  const providerTempBase = await temporaryDirectory('codex-buddy-provider-temp-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir, provider: 'ollama' });
  const identity = { session_id: 'windows-executor-kill-session', turn_id: 'windows-executor-kill-turn', cwd: root };
  const env = {};
  const verification = completeWindowsVerification();
  const windowsOptions = {
    platform: 'win32',
    arch: 'x64',
    env,
    ensureWindowsPrivateState: async () => verification,
    platformPolicy: mutableWindowsPlatformPolicy(env)
  };
  await captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Exercise the lifecycle executor kill-switch.'
  }, { modeDataDir, runtimeDataDir, ...windowsOptions });
  await writeFile(path.join(root, 'app.js'), 'const value = 952;\n');
  let reverifications = 0;
  const reverifyOptions = [];
  let reviewCalls = 0;
  const stopped = await reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Completed the lifecycle executor fixture.'
  }, {
    modeDataDir,
    runtimeDataDir,
    providerTempBase,
    ...windowsOptions,
    reverifyWindowsPrivateState: async (_current, currentOptions) => {
      reverifyOptions.push(currentOptions);
      reverifications += 1;
      if (reverifications === 2) env.CODEX_BUDDY_WINDOWS_EGRESS_BLOCK = '1';
      return verification;
    },
    review: async () => {
      reviewCalls += 1;
      throw new Error('review must not start');
    }
  });
  assert.equal(reverifications, 2);
  assert.equal(reverifyOptions.every((current) => current.dataDir === modeDataDir
    && current.runtimeDataDir === runtimeDataDir
    && current.tempBase === providerTempBase), true);
  assert.equal(reviewCalls, 0);
  assert.match(stopped.output.systemMessage, /could not complete/);
  assert.deepEqual((await readEgressRegistry({ root, dataDir: modeDataDir })).active, []);
  assert.deepEqual(await filesBelow(path.join(runtimeDataDir, 'circuits')), []);
  const receipt = JSON.parse(await readFile(stopped.receipt, 'utf8'));
  assert.equal(receipt.terminal_status, 'provider_unavailable');
  assert.equal(receipt.reviewer_runs[0].failure.stage, 'provider');
  assert.equal(receipt.reviewer_runs[0].failure.failure_code, 'windows_private_state_kill_switch');
});

test('automatic provider issuance rejects stale privacy coverage with zero provider calls', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir, provider: 'ollama' });
  const identity = {
    session_id: 'stale-privacy-coverage-session',
    turn_id: 'stale-privacy-coverage-turn',
    cwd: root
  };
  await captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Exercise the privacy-coverage provider gate.'
  }, { modeDataDir, runtimeDataDir });
  await writeFile(path.join(root, 'app.js'), 'const value = 95;\n');
  let reviewCalls = 0;
  const stopped = await reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Completed the privacy-coverage fixture.'
  }, {
    modeDataDir,
    runtimeDataDir,
    buildEvidence: async (options) => {
      const evidence = await buildTurnEvidence(options);
      return {
        ...evidence,
        privacy_coverage: { ...evidence.privacy_coverage, schema_version: '1' }
      };
    },
    review: async () => {
      reviewCalls += 1;
      throw new Error('review must not start');
    }
  });
  assert.equal(reviewCalls, 0);
  assert.equal(stopped.error.failureCode, 'privacy_coverage_incomplete');
  assert.deepEqual((await readEgressRegistry({ root, dataDir: modeDataDir })).active, []);
  const turnRoot = path.join(
    runtimeDataDir,
    'turns',
    workspaceKey(root),
    opaqueKey(identity.session_id),
    opaqueKey(identity.turn_id)
  );
  await assert.rejects(access(path.join(turnRoot, 'attempt.json')));
});

test('capability spend precedes blocked review-started publication and provider execution', async () => {
  const orderingVisibilityTimeoutMs = 60_000;
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'blocked-outbox-session', turn_id: 'blocked-outbox-turn', cwd: root };
  await captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Spend before publishing the presentation event.'
  }, { modeDataDir, runtimeDataDir });
  await writeFile(path.join(root, 'app.js'), 'const value = 24;\n');

  let modeLockHeld;
  const modeHeld = new Promise((resolve) => { modeLockHeld = resolve; });
  let releaseModeLock;
  const releaseMode = new Promise((resolve) => { releaseModeLock = resolve; });
  const holdingMode = withFileLock(modeFile(root, modeDataDir), async () => {
    modeLockHeld();
    await releaseMode;
  }, { timeoutMs: 10_000, staleMs: 10_000 });
  await modeHeld;

  let lockHeld;
  const held = new Promise((resolve) => { lockHeld = resolve; });
  let releaseLock;
  const release = new Promise((resolve) => { releaseLock = resolve; });
  const outboxLockTarget = path.join(
    runtimeDataDir,
    'outbox',
    workspaceKey(root),
    '_protocol',
    'workspace-state'
  );
  let holding = Promise.resolve();

  let providerEntered = false;
  let releaseReview;
  const reviewRelease = new Promise((resolve) => { releaseReview = resolve; });
  const stopping = reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Implemented the durable-spend ordering fixture.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async (evidence) => {
      const registry = await readEgressRegistry({ root, dataDir: modeDataDir });
      assert.equal(registry.active.length, 1);
      assert.equal(registry.active[0].state, 'consumed');
      providerEntered = true;
      await reviewRelease;
      return {
        evidence,
        provider: 'ollama',
        model: 'glm-5.2:cloud',
        result: {
          schema_version: '2', status: 'no_findings', summary: 'No validated defects.', findings: [], comments: []
        }
      };
    }
  });
  let stopped;
  try {
    await waitFor(async () => {
      const read = await readSequencedOutboxEvents({ repositoryRoot: root, runtimeDataDir });
      return read.events.some((item) => item.event.event_type === 'turn_finished');
    }, 'turn-finished publication before authorization', orderingVisibilityTimeoutMs);
    holding = withFileLock(outboxLockTarget, async () => {
      lockHeld();
      await release;
    }, { timeoutMs: 10_000, staleMs: 10_000 });
    await held;
    releaseModeLock();
    await holdingMode;

    await waitFor(async () => {
      const registry = await readEgressRegistry({ root, dataDir: modeDataDir });
      return registry.active.length === 1
        && registry.active[0].state === 'consumed';
    }, 'capability spend to become durably visible', orderingVisibilityTimeoutMs);
    await waitFor(
      () => providerEntered,
      'provider execution while review-started publication remains blocked',
      orderingVisibilityTimeoutMs
    );
  } finally {
    releaseModeLock();
    releaseLock();
    releaseReview();
    [stopped] = await Promise.all([stopping, holding, holdingMode]);
  }

  assert.equal(stopped.result.status, 'no_findings');
  assert.deepEqual((await readEgressRegistry({ root, dataDir: modeDataDir })).active, []);
});

test('post-dispatch capability settlement failures do not increment the provider circuit', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  const mode = await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const firstIdentity = {
    session_id: 'settlement-circuit-session', turn_id: 'settlement-failure', cwd: root
  };
  await captureTurnStart({
    ...firstIdentity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Exercise capability settlement failure accounting.'
  }, { modeDataDir, runtimeDataDir });
  await writeFile(path.join(root, 'app.js'), 'const value = 25;\n');

  let reviewCalls = 0;
  const failed = await reviewTurnStop({
    ...firstIdentity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Implemented the settlement accounting fixture.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async (evidence) => {
      reviewCalls += 1;
      const file = path.join(modeDataDir, 'egress', workspaceKey(root), 'active.json');
      const registry = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(registry.active.length, 1);
      assert.equal(registry.active[0].state, 'consumed');
      registry.active = [];
      await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`);
      return {
        evidence,
        provider: mode.provider,
        model: mode.model,
        result: {
          schema_version: '2', status: 'no_findings', summary: 'Provider completed.', findings: [], comments: []
        }
      };
    }
  });
  assert.equal(reviewCalls, 1);
  assert.equal(failed.error.egressCapabilityStage, 'settlement');
  const failedReceipt = JSON.parse(await readFile(failed.receipt, 'utf8'));
  assert.equal(failedReceipt.failure_code, 'egress_settlement_error');

  const circuitFile = path.join(
    runtimeDataDir,
    'circuits',
    workspaceKey(root),
    `${opaqueKey(`${mode.provider}\0${mode.model}`)}.json`
  );
  await assert.rejects(access(circuitFile));

  const secondIdentity = {
    session_id: 'settlement-circuit-session', turn_id: 'provider-success', cwd: root
  };
  await captureTurnStart({
    ...secondIdentity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Confirm the provider circuit remains available.'
  }, { modeDataDir, runtimeDataDir });
  await writeFile(path.join(root, 'app.js'), 'const value = 26;\n');
  const recovered = await reviewTurnStop({
    ...secondIdentity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Confirmed the settlement accounting fixture.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async (evidence) => {
      reviewCalls += 1;
      return {
        evidence,
        provider: mode.provider,
        model: mode.model,
        result: {
          schema_version: '2', status: 'no_findings', summary: 'Provider completed.', findings: [], comments: []
        }
      };
    }
  });
  assert.equal(reviewCalls, 2);
  assert.equal(recovered.result.status, 'no_findings');
  assert.equal(JSON.parse(await readFile(circuitFile, 'utf8')).consecutive_failures, 0);
});

test('intentional provider cancellation never increments the provider circuit', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  const mode = await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'cancelled-circuit-session', turn_id: 'cancelled-turn', cwd: root };
  await captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Exercise the neutral cancellation boundary.'
  }, { modeDataDir, runtimeDataDir });
  await writeFile(path.join(root, 'app.js'), 'const value = 119;\n');
  const stopped = await reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'The review was intentionally cancelled.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async () => {
      const error = new Error('synthetic intentional cancellation');
      error.failureCode = 'cancelled';
      throw error;
    }
  });
  assert.match(stopped.output.systemMessage, /could not complete/u);
  const circuitFile = path.join(
    runtimeDataDir,
    'circuits',
    workspaceKey(root),
    `${opaqueKey(`${mode.provider}\0${mode.model}`)}.json`
  );
  await assert.rejects(access(circuitFile));
  const receipt = JSON.parse(await readFile(stopped.receipt, 'utf8'));
  assert.equal(receipt.failure_code, 'cancelled');
});

test('late start publication and Stop share one turn lease', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'late-start-session', turn_id: 'late-start-turn', cwd: root };
  let baselineCaptured;
  const captured = new Promise((resolve) => { baselineCaptured = resolve; });
  let releaseStart;
  const release = new Promise((resolve) => { releaseStart = resolve; });
  const starting = captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Publish this baseline atomically with Stop.'
  }, {
    modeDataDir,
    runtimeDataDir,
    captureSnapshot: async (snapshotOptions) => {
      const snapshot = await captureTurnSnapshot(snapshotOptions);
      baselineCaptured();
      await release;
      await writeFile(path.join(root, 'app.js'), 'const value = 23;\n');
      return snapshot;
    }
  });
  await captured;
  let reviewCalls = 0;
  let stopSettled = false;
  const stopping = reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Finished after the delayed baseline.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async (evidence) => {
      reviewCalls += 1;
      assert.match(evidence.patch, /\+const value = 23;/);
      return {
        evidence,
        provider: 'ollama',
        model: 'glm-5.2:cloud',
        result: {
          schema_version: '2', status: 'no_findings', summary: 'No validated defects.', findings: [], comments: []
        }
      };
    }
  }).finally(() => { stopSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(stopSettled, false);
  releaseStart();
  const [started, stopped] = await Promise.all([starting, stopping]);
  assert.equal(started.snapshot !== null, true);
  assert.equal(stopped.result.status, 'no_findings');
  assert.equal(reviewCalls, 1);
});

test('separately consented summary advisory shares one review call and cosmetic profile changes do not revoke the turn', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  await changeSummaryClaimGuardConsent({
    root,
    dataDir: modeDataDir,
    action: 'enable',
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    confirmSummaryEgress: true
  });
  const identity = { session_id: 'guard-session', turn_id: 'guard-turn', cwd: root };
  await captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Implement the guarded change.'
  }, { modeDataDir, runtimeDataDir });
  const modeRevision = (await readMode({ root, dataDir: modeDataDir })).config_revision;
  await changePresentationProfile({
    root,
    dataDir: modeDataDir,
    petId: 'buddy-lupo',
    personality: 'warm'
  });
  assert.equal((await readMode({ root, dataDir: modeDataDir })).config_revision, modeRevision);
  await writeFile(path.join(root, 'app.js'), 'const value = 3;\n');

  const workerSummary = 'GUARD_SUMMARY_UNIQUE: implemented the change and ran the focused tests.';
  let calls = 0;
  const stopped = await reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: workerSummary
  }, {
    modeDataDir,
    runtimeDataDir,
      review: async (evidence, options) => {
        calls += 1;
        const approval = inspectApprovedProviderReviewRequest(options.approvedRequest);
        assert.equal(approval.summaryConsentRevision, options.summaryGuardPacket.consent_revision);
        assert.equal(approval.summarySha256, options.summaryGuardPacket.summary_sha256);
        assert.equal(Object.isFrozen(options.summaryGuardPacket), true);
      assert.equal(options.summaryGuardPacket.summary, workerSummary);
      assert.equal(options.summaryGuardPacket.purpose, 'worker_summary_claim_advisory');
      return {
        evidence,
        provider: 'ollama',
        model: 'glm-5.2:cloud',
        result: {
          schema_version: '2', status: 'no_findings', summary: 'No validated defects.', findings: [], comments: []
        },
        summaryAdvisory: {
          schema_version: '1', status: 'no_notes', advisory: 'The bounded summary claims are proportionate.', notes: []
        }
      };
    }
  });
  assert.equal(calls, 1);
  const boundaryLine = stopped.output.reason.split('\n').find((line) => line.endsWith('_START'));
  const payload = JSON.parse(stopped.output.reason.split('\n')[
    stopped.output.reason.split('\n').indexOf(boundaryLine) + 1
  ]);
  assert.deepEqual(Object.keys(payload).sort(), ['review_key', 'schema_version', 'visible_review']);
  assert.match(payload.visible_review, /no actionable correctness defect/u);
  assert.deepEqual(await readCompletedReviewKeys({ root, dataDir: modeDataDir }), [stopped.reviewKey]);
  const receiptText = await readFile(stopped.receipt, 'utf8');
  assert.doesNotMatch(receiptText, /GUARD_SUMMARY_UNIQUE/);
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.summary_claim_guard.summary_sha256.length, 64);
  assert.equal(receipt.summary_claim_advisory.status, 'no_notes');
  const outbox = await readSequencedOutboxEvents({ repositoryRoot: root, runtimeDataDir });
  const completed = outbox.events.find((item) => item.event.event_type === 'review_completed');
  assert.equal(completed.event.payload.companion.pet_id, 'buddy-lupo');
  assert.equal(completed.event.payload.companion.personality, 'warm');
  assert.equal(completed.event.payload.companion.xp, 10);
});

test('real summary lifecycle dispatches the spent immutable packet through the Ollama boundary', {
  skip: process.platform === 'win32'
}, async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  const fakeBin = await temporaryDirectory('codex-buddy-fake-ollama-');
  const promptFile = path.join(fakeBin, 'prompt.txt');
  const callsFile = path.join(fakeBin, 'calls.txt');
  const providerOutput = {
    technical_review: {
      schema_version: '2',
      status: 'no_findings',
      summary: 'The local provider-boundary fixture found no validated defects.',
      findings: [],
      comments: []
    },
    summary_advisory: {
      schema_version: '1',
      status: 'no_notes',
      advisory: 'The bounded worker summary is proportionate.',
      notes: []
    }
  };
  const fakeOllama = path.join(fakeBin, 'ollama');
  await writeFile(fakeOllama, `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(promptFile)}, readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(callsFile)}, 'call\\n');
process.stdout.write(${JSON.stringify(JSON.stringify(providerOutput))});
`);
  await chmod(fakeOllama, 0o755);

  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  await changeSummaryClaimGuardConsent({
    root,
    dataDir: modeDataDir,
    action: 'enable',
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    confirmSummaryEgress: true
  });
  const identity = { session_id: 'real-guard-session', turn_id: 'real-guard-turn', cwd: root };
  await captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Exercise the real summary dispatcher.'
  }, { modeDataDir, runtimeDataDir });
  await writeFile(path.join(root, 'app.js'), 'const value = 92;\n');

  const workerSummary = 'REAL_GUARD_SUMMARY_UNIQUE: implemented and verified the change.';
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ''}`;
  let stopped;
  try {
    stopped = await reviewTurnStop({
      ...identity,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: workerSummary
    }, { modeDataDir, runtimeDataDir });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  assert.equal(stopped.error, undefined);
  assert.equal(stopped.result.status, 'no_findings');
  assert.equal((await readFile(callsFile, 'utf8')).trim(), 'call');
  assert.match(await readFile(promptFile, 'utf8'), /REAL_GUARD_SUMMARY_UNIQUE/);
  const receipt = JSON.parse(await readFile(stopped.receipt, 'utf8'));
  assert.equal(receipt.summary_claim_advisory.status, 'no_notes');
  assert.match(receipt.egress_capability.summary_packet_sha256, /^[0-9a-f]{64}$/);
});

test('summary privacy suppression preserves one technical-only provider review', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  const mode = await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  await changeSummaryClaimGuardConsent({
    root,
    dataDir: modeDataDir,
    action: 'enable',
    provider: mode.provider,
    model: mode.model,
    confirmSummaryEgress: true
  });
  const identity = { session_id: 'private-summary-session', turn_id: 'private-summary-turn', cwd: root };
  await captureTurnStart({
    ...identity,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Keep accidental summary credentials local.'
  }, { modeDataDir, runtimeDataDir });
  await writeFile(path.join(root, 'app.js'), 'const value = 93;\n');

  const secret = `sk-proj-${'A9_bC7-dE5_fG3-hJ1_kL8'}`;
  let providerCalls = 0;
  const stopped = await reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: `Updated .env using ${secret} and verified the change.`
  }, {
    modeDataDir,
    runtimeDataDir,
      review: async (evidence, options) => {
        providerCalls += 1;
        assert.equal(options.summaryGuardPacket, null);
        const approval = inspectApprovedProviderReviewRequest(options.approvedRequest);
        assert.equal(approval.summaryPacketSha256, null);
        assert.deepEqual(approval.channelInventory, ['technical_evidence']);
        assert.doesNotMatch(evidence.patch, /sk-proj|\.env/u);
      return {
        evidence,
        provider: mode.provider,
        model: mode.model,
        result: {
          schema_version: '2',
          status: 'no_findings',
          summary: 'Technical evidence contained no validated defects.',
          findings: [],
          comments: []
        }
      };
    }
  });

  assert.equal(providerCalls, 1);
  assert.equal(stopped.result.status, 'no_findings');
  const receipt = JSON.parse(await readFile(stopped.receipt, 'utf8'));
  assert.equal(receipt.summary_claim_guard, null);
  assert.equal(receipt.summary_claim_advisory, null);
  assert.equal(receipt.egress_capability.summary_consent_revision, null);
  assert.equal(receipt.egress_capability.summary_sha256, null);
  assert.equal(receipt.egress_capability.summary_packet_sha256, null);
  assert.doesNotMatch(JSON.stringify(receipt), /sk-proj|A9_bC7|\.env/u);
});

test('summary consent disable before authorization omits the summary but still runs technical review', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  await changeSummaryClaimGuardConsent({
    root,
    dataDir: modeDataDir,
    action: 'enable',
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    confirmSummaryEgress: true
  });
  const identity = { session_id: 'guard-disable-session', turn_id: 'guard-disable-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it.' }, {
    modeDataDir, runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 71;\n');
  let captureEntered;
  const entered = new Promise((resolve) => { captureEntered = resolve; });
  let releaseCapture;
  const released = new Promise((resolve) => { releaseCapture = resolve; });
  let calls = 0;
  const stopping = reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'SUMMARY_MUST_NOT_EGRESS after revocation.'
  }, {
    modeDataDir,
    runtimeDataDir,
    captureSnapshot: async (snapshotOptions) => {
      captureEntered();
      await released;
      return captureTurnSnapshot(snapshotOptions);
    },
    review: async (evidence, options) => {
      calls += 1;
      assert.equal(options.summaryGuardPacket, null);
      return {
        evidence,
        provider: 'ollama',
        model: 'glm-5.2:cloud',
        result: {
          schema_version: '2', status: 'no_findings', summary: 'Technical review completed.', findings: [], comments: []
        }
      };
    }
  });
  await entered;
  await changeSummaryClaimGuardConsent({ root, dataDir: modeDataDir, action: 'disable' });
  releaseCapture();
  const stopped = await stopping;
  assert.equal(calls, 1);
  assert.equal(stopped.result.status, 'no_findings');
  assert.equal(JSON.parse(await readFile(stopped.receipt, 'utf8')).summary_claim_guard, null);
});

test('summary consent disable commits visibly, then waits for an issued summary capability to drain', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  await changeSummaryClaimGuardConsent({
    root,
    dataDir: modeDataDir,
    action: 'enable',
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    confirmSummaryEgress: true
  });
  const identity = { session_id: 'guard-wait-session', turn_id: 'guard-wait-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it.' }, {
    modeDataDir, runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 72;\n');
  let reviewEntered;
  const entered = new Promise((resolve) => { reviewEntered = resolve; });
  let releaseReview;
  const released = new Promise((resolve) => { releaseReview = resolve; });
  const stopping = reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'AUTHORIZED_SUMMARY may egress during this call.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async (evidence, options) => {
      assert.equal(options.summaryGuardPacket.summary, 'AUTHORIZED_SUMMARY may egress during this call.');
      reviewEntered();
      await released;
      return {
        evidence,
        provider: 'ollama',
        model: 'glm-5.2:cloud',
        result: {
          schema_version: '2', status: 'no_findings', summary: 'Technical review completed.', findings: [], comments: []
        }
      };
    }
  });
  await entered;
  let disableSettled = false;
  const disabling = changeSummaryClaimGuardConsent({ root, dataDir: modeDataDir, action: 'disable' })
    .then((value) => {
      disableSettled = true;
      return value;
    });
  try {
    await waitFor(
      async () => !(await readSummaryClaimGuardConsent({ root, dataDir: modeDataDir })).enabled,
      'summary consent revocation to become visible',
      CONCURRENT_STATE_VISIBILITY_TIMEOUT_MS
    );
    assert.equal(disableSettled, false);
  } finally {
    releaseReview();
  }
  const [stopped, disabled] = await Promise.all([stopping, disabling]);
  assert.equal(stopped.result.status, 'no_findings');
  assert.equal(disabled.enabled, false);
  assert.equal(JSON.parse(await readFile(stopped.receipt, 'utf8')).summary_claim_guard !== null, true);
});

test('summary consent provider mismatch omits summary and preserves technical review', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  await changeSummaryClaimGuardConsent({
    root,
    dataDir: modeDataDir,
    action: 'enable',
    provider: 'grok',
    model: 'glm-5.2:cloud',
    confirmSummaryEgress: true
  });
  const identity = { session_id: 'guard-mismatch-session', turn_id: 'guard-mismatch-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it.' }, {
    modeDataDir, runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 73;\n');
  let calls = 0;
  const stopped = await reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'MISMATCHED_SUMMARY must not egress.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async (evidence, options) => {
      calls += 1;
      assert.equal(options.summaryGuardPacket, null);
      return {
        evidence,
        provider: 'ollama',
        model: 'glm-5.2:cloud',
        result: {
          schema_version: '2', status: 'no_findings', summary: 'Technical review completed.', findings: [], comments: []
        }
      };
    }
  });
  assert.equal(calls, 1);
  assert.equal(stopped.result.status, 'no_findings');
  assert.equal(JSON.parse(await readFile(stopped.receipt, 'utf8')).summary_claim_guard, null);
});

test('baseline capture budget failure terminalizes the turn with zero provider egress', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'baseline-budget-session', turn_id: 'baseline-budget-turn', cwd: root };
  const started = await captureTurnStart({
    ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it'
  }, {
    modeDataDir,
    runtimeDataDir,
    captureSnapshot: async () => { throw new CaptureBudgetError('capture_file_bytes_exceeded'); }
  });
  assert.equal(started.skipped, 'baseline_capture_error');
  assert.match(started.output.hookSpecificOutput.additionalContext, /will abstain/);

  let reviewCalls = 0;
  const stopped = await reviewTurnStop({
    ...identity, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async () => { reviewCalls += 1; }
  });
  assert.equal(stopped.skipped, 'duplicate');
  assert.equal(reviewCalls, 0);
  const completed = (await filesBelow(runtimeDataDir)).find(
    (file) => path.basename(file) === 'completed.json'
  );
  const terminal = JSON.parse(await readFile(completed, 'utf8'));
  assert.equal(terminal.terminal_status, 'baseline_capture_error');
  assert.equal(JSON.stringify(terminal).includes('file_bytes'), false);
});

test('final capture budget failure is durable and never launches or replays a provider', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'final-budget-session', turn_id: 'final-budget-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 2;\n');
  let reviewCalls = 0;
  const stop = { ...identity, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' };
  const failed = await reviewTurnStop(stop, {
    modeDataDir,
    runtimeDataDir,
    captureSnapshot: async () => { throw new CaptureBudgetError('capture_deadline_exceeded'); },
    review: async () => { reviewCalls += 1; }
  });
  assert.equal(failed.reviewKey, null);
  assert.equal(failed.receipt, null);
  assert.match(failed.output.systemMessage, /snapshot stage/);
  assert.equal(reviewCalls, 0);
  const duplicate = await reviewTurnStop(stop, {
    modeDataDir,
    runtimeDataDir,
    captureSnapshot: async () => { throw new Error('terminal replay must not recapture'); },
    review: async () => { reviewCalls += 1; }
  });
  assert.equal(duplicate.skipped, 'duplicate');
  assert.equal(reviewCalls, 0);
});

test('expired turn attempts terminalize before pruning and can never replay provider egress', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'expired-session', turn_id: 'expired-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  const baselineFile = (await filesBelow(runtimeDataDir)).find(
    (file) => path.basename(file) === 'baseline.json'
  );
  const baseline = JSON.parse(await readFile(baselineFile, 'utf8'));
  baseline.snapshot.captured_at = '2020-01-01T00:00:00.000Z';
  await writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
  const attemptFile = path.join(path.dirname(baselineFile), 'attempt.json');
  await writeFile(attemptFile, `${JSON.stringify({ review_key: 'b'.repeat(64) })}\n`);
  const pruned = await pruneWorkspaceTurns({
    runtimeDataDir, root, now: Date.parse('2020-01-03T00:00:00Z')
  });
  assert.equal(pruned.pruned, 1);

  const duplicateStart = await captureTurnStart({
    ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Try again'
  }, { modeDataDir, runtimeDataDir });
  assert.equal(duplicateStart.skipped, 'terminal_turn');
  let reviewCalls = 0;
  const stopped = await reviewTurnStop({
    ...identity, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async () => { reviewCalls += 1; }
  });
  assert.equal(stopped.skipped, 'duplicate');
  assert.equal(reviewCalls, 0);
});

test('simultaneous Stop deliveries make exactly one provider call and one continuation', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'parallel-session', turn_id: 'parallel-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 33;\n');
  let calls = 0;
  const review = async (evidence) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      evidence, provider: 'ollama', model: 'glm-5.2:cloud',
      result: { schema_version: '1', status: 'no_findings', summary: 'No issue.', findings: [], comments: [] }
    };
  };
  const stop = { ...identity, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' };
  const results = await Promise.all([
    reviewTurnStop(stop, { modeDataDir, runtimeDataDir, review }),
    reviewTurnStop({ ...stop, last_assistant_message: 'A distinct duplicate delivery.' }, {
      modeDataDir, runtimeDataDir, review
    })
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter((item) => item.output?.decision === 'block').length, 1);
  assert.equal(results.filter((item) => item.skipped === 'delivery_in_progress').length, 1);
});

test('mode disable after the early Stop check prevents provider launch', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'reauth-session', turn_id: 'reauth-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 44;\n');
  let captureEntered;
  const entered = new Promise((resolve) => { captureEntered = resolve; });
  let releaseCapture;
  const released = new Promise((resolve) => { releaseCapture = resolve; });
  let calls = 0;
  const stopPromise = reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Done.'
  }, {
    modeDataDir,
    runtimeDataDir,
    captureSnapshot: async (snapshotOptions) => {
      captureEntered();
      await released;
      return captureTurnSnapshot(snapshotOptions);
    },
    review: async () => {
      calls += 1;
      throw new Error('provider must not be called after disable');
    }
  });
  await entered;
  const disabled = await changeMode({ root, action: 'disable', dataDir: modeDataDir });
  assert.equal(disabled.enabled, false);
  releaseCapture();
  const result = await stopPromise;
  assert.equal(calls, 0);
  assert.equal(result.result.status, 'abstain');
  assert.equal(result.output.decision, 'block');
});

test('mode disable commits visibly, then waits for an issued provider capability to drain', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'mode-wait-session', turn_id: 'mode-wait-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 45;\n');
  let reviewEntered;
  const entered = new Promise((resolve) => { reviewEntered = resolve; });
  let releaseReview;
  const released = new Promise((resolve) => { releaseReview = resolve; });
  const stopPromise = reviewTurnStop({
    ...identity, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async (evidence) => {
      reviewEntered();
      await released;
      return {
        evidence,
        provider: 'ollama',
        model: 'glm-5.2:cloud',
        result: { schema_version: '1', status: 'no_findings', summary: 'No issue.', findings: [], comments: [] }
      };
    }
  });
  await entered;
  let disableSettled = false;
  const disablePromise = changeMode({ root, action: 'disable', dataDir: modeDataDir }).then((mode) => {
    disableSettled = true;
    return mode;
  });
  try {
    await waitFor(
      async () => !(await readMode({ root, dataDir: modeDataDir })).enabled,
      'mode disable to become visible',
      CONCURRENT_STATE_VISIBILITY_TIMEOUT_MS
    );
    assert.equal(disableSettled, false);
  } finally {
    releaseReview();
  }
  const [stopResult, disabled] = await Promise.all([stopPromise, disablePromise]);
  assert.equal(stopResult.output.decision, 'block');
  assert.equal(disabled.enabled, false);
});

test('continuation acknowledgement and duplicate replay are serialized', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'ack-session', turn_id: 'ack-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 55;\n');
  const stop = { ...identity, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' };
  const review = async (evidence) => ({
    evidence,
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    result: { schema_version: '1', status: 'no_findings', summary: 'No issue.', findings: [], comments: [] }
  });
  const first = await reviewTurnStop(stop, { modeDataDir, runtimeDataDir, review });
  assert.equal(first.output.decision, 'block');
  const results = await Promise.all([
    reviewTurnStop({ ...stop, stop_hook_active: true }, { modeDataDir, runtimeDataDir }),
    reviewTurnStop(stop, { modeDataDir, runtimeDataDir, review })
  ]);
  assert.equal(results.some((item) => item.output?.decision === 'block'), false);
  assert.equal(results.some((item) => item.skipped === 'continuation'), true);
  assert.equal(results.some((item) => ['delivery_in_progress', 'duplicate'].includes(item.skipped)), true);
});

test('delivery tokens distinguish stdout transport flush from host observation', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'transport-session', turn_id: 'transport-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 77;\n');
  const stop = { ...identity, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' };
  let reviewCalls = 0;
  const review = async (evidence) => {
    reviewCalls += 1;
    return {
      evidence,
      provider: 'ollama',
      model: 'glm-5.2:cloud',
      result: { schema_version: '2', status: 'no_findings', summary: 'No issue.', findings: [], comments: [] }
    };
  };
  const first = await reviewTurnStop(stop, { modeDataDir, runtimeDataDir, review });
  assert.match(first.deliveryToken, /^[0-9a-f]{48}$/);
  assert.equal(await markContinuationStdoutWritten(stop, '0'.repeat(48), { runtimeDataDir }), false);
  assert.equal(await markContinuationStdoutWritten(stop, first.deliveryToken, { runtimeDataDir }), true);
  const completedFile = (await filesBelow(runtimeDataDir)).find(
    (file) => path.basename(file) === 'completed.json'
  );
  assert.equal(JSON.parse(await readFile(completedFile, 'utf8')).presentation_status, 'stdout_written');

  const duplicate = await reviewTurnStop(stop, {
    modeDataDir, runtimeDataDir, review, deliveryRetryMs: 0
  });
  assert.equal(duplicate.output, null);
  assert.equal(duplicate.skipped, 'duplicate');
  assert.equal(reviewCalls, 1);
  const observed = await reviewTurnStop({ ...stop, stop_hook_active: true }, { modeDataDir, runtimeDataDir });
  assert.equal(observed.skipped, 'continuation');
  assert.equal(JSON.parse(await readFile(completedFile, 'utf8')).presentation_status, 'observed');
});

test('hook transport resolves only from the write callback and rejects write errors', async () => {
  let payload = null;
  const written = await writeHookOutput({ decision: 'block' }, {
    write(value, callback) {
      payload = value;
      callback();
    }
  });
  assert.equal(written, true);
  assert.equal(payload, '{"decision":"block"}\n');
  await assert.rejects(
    writeHookOutput({ decision: 'block' }, {
      write(_value, callback) { callback(new Error('transport failed')); }
    }),
    /transport failed/
  );
});

test('a durable prior-attempt marker prevents provider replay after an interrupted turn', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'attempt-session', turn_id: 'attempt-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  const baselineFile = (await filesBelow(runtimeDataDir)).find(
    (file) => path.basename(file) === 'baseline.json'
  );
  assert.ok(baselineFile);
  await writeFile(path.join(path.dirname(baselineFile), 'attempt.json'), `${JSON.stringify({
    schema_version: '1', review_key: 'a'.repeat(64), started_at: new Date().toISOString()
  })}\n`);
  await writeFile(path.join(root, 'app.js'), 'const value = 66;\n');
  let calls = 0;
  const result = await reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Done.'
  }, {
    modeDataDir,
    runtimeDataDir,
    review: async () => {
      calls += 1;
      throw new Error('provider must not replay after a durable attempt marker');
    }
  });
  assert.equal(calls, 0);
  assert.equal(result.skipped, 'prior_attempt_incomplete');
  assert.match(result.output.systemMessage, /will not be repeated/);
  await assert.rejects(access(baselineFile));
  await assert.rejects(access(path.join(path.dirname(baselineFile), 'attempt.json')));
});

test('an exact durable receipt from a prior attempt replays only after current evidence validation', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'attempt-receipt-session', turn_id: 'attempt-receipt-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  const baselineFile = (await filesBelow(runtimeDataDir)).find(
    (file) => path.basename(file) === 'baseline.json'
  );
  assert.ok(baselineFile);
  await writeFile(path.join(root, 'app.js'), 'const value = 67;\n');
  const mode = await readMode({ root, dataDir: modeDataDir });
  await changeSummaryClaimGuardConsent({
    root,
    dataDir: modeDataDir,
    action: 'enable',
    provider: mode.provider,
    model: mode.model,
    confirmSummaryEgress: true
  });
  const baseline = JSON.parse(await readFile(baselineFile, 'utf8')).snapshot;
  const final = { ...baseline, tree: 'f'.repeat(40), captured_at: '2026-07-20T00:00:00.000Z' };
  const evidence = {
    schema_version: '1',
    repository_root: root,
    changed_paths: ['app.js'],
    excluded_paths: [],
    sensitive_change_count: 0,
    ignored_change_count: 0,
    path_evidence: [{ path: 'app.js', transmitted: true, disposition: 'complete' }],
    hunk_ranges: { 'app.js': [{ side: 'new', start: 1, end: 1, kind: 'changed' }] },
    line_counts: { 'app.js': 1 },
    old_line_counts: { 'app.js': 1 },
    patch_hash: '9'.repeat(64)
  };
  const stopInput = {
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'A summary that is not part of the technical-only review key.'
  };
  const summaryGuardConsent = await readSummaryClaimGuardConsent({ root, dataDir: modeDataDir });
  const attemptedReviewKey = reviewKeyFor({
    input: stopInput,
    mode,
    baseline,
    final,
    evidence,
    summaryGuardConsent
  });
  await writeFile(path.join(path.dirname(baselineFile), 'attempt.json'), `${JSON.stringify({
    schema_version: '1', review_key: attemptedReviewKey, started_at: new Date().toISOString()
  })}\n`);
  const receiptDirectory = path.join(runtimeDataDir, 'automatic-reviews', workspaceKey(root));
  await mkdir(receiptDirectory, { recursive: true });
  const receipt = path.join(receiptDirectory, `${attemptedReviewKey}.json`);
  await writeFile(receipt, `${JSON.stringify(successfulReceipt(mode, attemptedReviewKey, {
    root,
    input: stopInput,
    baseline,
    final,
    evidence
  }, 'Recovered prior result.', {
    summaryGuardConsent,
    workerSummary: stopInput.last_assistant_message
  }))}\n`);
  let calls = 0;
  const result = await reviewTurnStop(stopInput, {
    modeDataDir,
    runtimeDataDir,
    captureSnapshot: async () => final,
    buildEvidence: async () => evidence,
    review: async () => {
      calls += 1;
      throw new Error('provider must not replay after a durable receipt');
    }
  });
  assert.equal(calls, 0);
  assert.equal(result.skipped, 'replayed');
  assert.equal(result.reviewKey, attemptedReviewKey);
  assert.equal(result.receipt, receipt);
  assert.equal(result.output.decision, 'block');
  assert.match(result.output.reason, /no actionable correctness defect/u);
  await assert.rejects(access(baselineFile));
  await assert.rejects(access(path.join(path.dirname(baselineFile), 'attempt.json')));
});

test('a stale legacy receipt with a credential-shaped model is never replayed or echoed', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'unsafe-receipt-session', turn_id: 'unsafe-receipt-turn', cwd: root };
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  const baselineFile = (await filesBelow(runtimeDataDir)).find(
    (file) => path.basename(file) === 'baseline.json'
  );
  assert.ok(baselineFile);
  const reviewKey = 'd'.repeat(64);
  await writeFile(path.join(path.dirname(baselineFile), 'attempt.json'), `${JSON.stringify({
    schema_version: '1', review_key: reviewKey, started_at: new Date().toISOString()
  })}\n`);
  const model = ['sk-ant-oat01-', 'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'].join('');
  const receiptDirectory = path.join(runtimeDataDir, 'automatic-reviews', workspaceKey(root));
  await mkdir(receiptDirectory, { recursive: true });
  await writeFile(path.join(receiptDirectory, `${reviewKey}.json`), `${JSON.stringify({
    schema_version: '1',
    review_key: reviewKey,
    terminal_status: 'no_findings',
    provider: 'claude',
    model,
    result: noFindings('Recovered prior result.'),
    created_at: new Date().toISOString()
  })}\n`);
  const stopped = await reviewTurnStop({
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Done.'
  }, { modeDataDir, runtimeDataDir });
  assert.equal(stopped.skipped, 'prior_attempt_incomplete');
  assert.match(stopped.output.systemMessage, /does not match the current final repository state/u);
  assert.equal(JSON.stringify(stopped).includes(model), false);
});

test('a forged legacy receipt pair is never replayed (H07 regression)', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'forged-replay-session', turn_id: 'forged-replay-turn', cwd: root };
  const stopInput = {
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Done.'
  };
  const reviewKey = 'd'.repeat(64);
  const directory = automaticTurnDirectory(runtimeDataDir, root, identity.session_id, identity.turn_id);
  const receipt = automaticReceiptFile(runtimeDataDir, root, reviewKey);
  await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(receipt), { recursive: true });
  const forged = {
    schema_version: 'not-a-receipt-schema',
    review_key: reviewKey,
    terminal_status: 'no_findings',
    provider: 'claude',
    model: 'claude-opus-4-8',
    result: {
      schema_version: '2',
      status: 'findings',
      summary: 'forged',
      findings: [{
        severity: 'high',
        title: 'FORGED LEGACY RECEIPT WAS PRESENTED',
        path: 'src/example.mjs',
        line_start: 1,
        recommendation: 'Do not trust this receipt.'
      }],
      comments: []
    },
    created_at: 'not-a-timestamp'
  };
  await writeFile(receipt, `${JSON.stringify(forged)}\n`);
  await writeFile(path.join(directory, 'completed.json'), `${JSON.stringify({
    schema_version: '1',
    review_key: reviewKey,
    receipt_sha256: automaticReceiptDigest(forged),
    presentation_status: 'prepared',
    completed_at: new Date().toISOString()
  })}\n`);

  const replay = await reviewTurnStop(stopInput, { modeDataDir, runtimeDataDir });
  // The forged receipt must not be presented: no replay output may carry the
  // forged finding title, and the completion record must be marked invalid.
  assert.notEqual(replay.skipped, 'replayed');
  assert.equal(replay.output, null);
  assert.equal(JSON.stringify(replay).includes('FORGED LEGACY RECEIPT WAS PRESENTED'), false);
  const completed = JSON.parse(await readFile(path.join(directory, 'completed.json'), 'utf8'));
  assert.equal(completed.terminal_status, 'invalid_pre_review_receipt');
  assert.equal(completed.failure_code, 'invalid_pre_review_receipt');
});

test('a valid legacy receipt still replays after structural validation', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  const mode = await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'valid-replay-session', turn_id: 'valid-replay-turn', cwd: root };
  const stopInput = {
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'No repository changes were needed.'
  };
  const reviewKey = 'e'.repeat(64);
  const directory = automaticTurnDirectory(runtimeDataDir, root, identity.session_id, identity.turn_id);
  const receipt = automaticReceiptFile(runtimeDataDir, root, reviewKey);
  await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(receipt), { recursive: true });
  const terminal = {
    schema_version: '1',
    review_key: reviewKey,
    terminal_status: 'no_findings',
    provider: mode.provider,
    model: mode.model,
    baseline_tree: 'a'.repeat(40),
    final_tree: 'b'.repeat(40),
    patch_hash: 'c'.repeat(64),
    changed_path_count: 1,
    excluded_path_count: 0,
    result: noFindings('No validated defects.'),
    reviews: [],
    review_failures: [],
    review_sources: null,
    reviewer_runs: [],
    summary_claim_guard: null,
    summary_claim_advisory: null,
    provider_run: null,
    egress_capability: null,
    created_at: new Date().toISOString()
  };
  await writeFile(receipt, `${JSON.stringify(terminal)}\n`);
  await writeFile(path.join(directory, 'completed.json'), `${JSON.stringify({
    schema_version: '1',
    review_key: reviewKey,
    receipt_sha256: automaticReceiptDigest(terminal),
    presentation_status: 'prepared',
    completed_at: new Date().toISOString()
  })}\n`);

  const replay = await reviewTurnStop(stopInput, {
    modeDataDir,
    runtimeDataDir,
    captureSnapshot: async () => { throw new Error('replay must not recapture'); },
    review: async () => { throw new Error('replay must not call a provider'); }
  });
  assert.equal(replay.skipped, 'replayed');
  assert.equal(replay.output.decision, 'block');
  assert.match(replay.output.reason, /no actionable correctness defect/u);
});

test('a structurally valid receipt with a tampered stored digest is never replayed', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  const mode = await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const identity = { session_id: 'tampered-digest-session', turn_id: 'tampered-digest-turn', cwd: root };
  const stopInput = {
    ...identity,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'No repository changes were needed.'
  };
  const reviewKey = 'f'.repeat(64);
  const directory = automaticTurnDirectory(runtimeDataDir, root, identity.session_id, identity.turn_id);
  const receipt = automaticReceiptFile(runtimeDataDir, root, reviewKey);
  await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(receipt), { recursive: true });
  const terminal = {
    schema_version: '1',
    review_key: reviewKey,
    terminal_status: 'no_findings',
    provider: mode.provider,
    model: mode.model,
    baseline_tree: 'a'.repeat(40),
    final_tree: 'b'.repeat(40),
    patch_hash: 'c'.repeat(64),
    changed_path_count: 1,
    excluded_path_count: 0,
    result: noFindings('No validated defects.'),
    reviews: [],
    review_failures: [],
    review_sources: null,
    reviewer_runs: [],
    summary_claim_guard: null,
    summary_claim_advisory: null,
    provider_run: null,
    egress_capability: null,
    created_at: new Date().toISOString()
  };
  await writeFile(receipt, `${JSON.stringify(terminal)}\n`);
  // Structurally valid receipt, but the stored digest does NOT match it.
  await writeFile(path.join(directory, 'completed.json'), `${JSON.stringify({
    schema_version: '1',
    review_key: reviewKey,
    receipt_sha256: '0'.repeat(64),
    presentation_status: 'prepared',
    completed_at: new Date().toISOString()
  })}\n`);

  const replay = await reviewTurnStop(stopInput, { modeDataDir, runtimeDataDir });
  assert.notEqual(replay.skipped, 'replayed');
  assert.equal(replay.output, null);
  const completed = JSON.parse(await readFile(path.join(directory, 'completed.json'), 'utf8'));
  assert.equal(completed.terminal_status, 'invalid_pre_review_receipt');
});

test('automatic provider failures write only an error hash and never loop on duplicate Stop', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const baseInput = { session_id: 'failure-session', turn_id: 'failure-turn', cwd: root };
  await captureTurnStart({ ...baseInput, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 7;\n');
  let calls = 0;
  const stopInput = {
    ...baseInput,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Changed it.'
  };
  const first = await reviewTurnStop(stopInput, {
    modeDataDir,
    runtimeDataDir,
    review: async () => {
      calls += 1;
      throw new Error('sensitive provider diagnostic');
    }
  });
  assert.match(first.output.systemMessage, /could not complete/);
  const receiptText = await readFile(first.receipt, 'utf8');
  assert.doesNotMatch(receiptText, /sensitive provider diagnostic/);
  assert.match(receiptText, /"error_hash": "[0-9a-f]{64}"/);
  const failureReceipt = JSON.parse(receiptText);
  assert.match(failureReceipt.egress_capability.capability_id, /^[0-9a-f]{64}$/);
  assert.equal(failureReceipt.egress_capability.review_key, first.reviewKey);
  assert.doesNotMatch(
    JSON.stringify(failureReceipt.egress_capability),
    /Changed it|const value|sensitive provider diagnostic/
  );
  const duplicate = await reviewTurnStop(stopInput, {
    modeDataDir,
    runtimeDataDir,
    review: async () => { throw new Error('must not rerun'); },
    captureSnapshot: async () => { throw new Error('must not recapture'); }
  });
  assert.equal(duplicate.skipped, 'duplicate');
  assert.equal(calls, 1);
});

test('automatic review abstains without egress when mode changes during a turn', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  const identity = { session_id: 'mode-session', turn_id: 'mode-turn', cwd: root };
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  await changeMode({ root, action: 'enable', provider: 'grok', dataDir: modeDataDir });
  await writeFile(path.join(root, 'app.js'), 'const value = 8;\n');
  let calls = 0;
  const stopped = await reviewTurnStop({
    ...identity, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.'
  }, {
    modeDataDir, runtimeDataDir, review: async () => { calls += 1; throw new Error('must not run'); }
  });
  assert.equal(stopped.skipped, 'mode_changed');
  assert.match(stopped.output.systemMessage, /configuration changed/);
  assert.equal(calls, 0);
  assert.equal((await filesBelow(runtimeDataDir)).some((file) => /baseline\.json$/.test(file)), false);
});

test('disabling during a turn revokes review and cleans the private snapshot', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  const identity = { session_id: 'disabled-session', turn_id: 'disabled-turn', cwd: root };
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
    modeDataDir, runtimeDataDir
  });
  await changeMode({ root, action: 'disable', dataDir: modeDataDir });
  const stopped = await reviewTurnStop({
    ...identity, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.'
  }, { modeDataDir, runtimeDataDir, review: async () => { throw new Error('must not run'); } });
  assert.equal(stopped.skipped, 'disabled');
  const files = await filesBelow(runtimeDataDir);
  assert.equal(files.some((file) => /baseline\.json$/.test(file)), false);
  assert.equal(files.some((file) => /\/snapshot\//.test(file)), false);
});

test('three consecutive provider failures open the workspace circuit before a fourth call', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  let calls = 0;
  const failingReview = async () => {
    calls += 1;
    throw new Error('provider unavailable');
  };

  for (let index = 1; index <= 3; index += 1) {
    const identity = { session_id: 'circuit-session', turn_id: `failure-${index}`, cwd: root };
    await captureTurnStart({ ...identity, hook_event_name: 'UserPromptSubmit', prompt: 'Change it' }, {
      modeDataDir, runtimeDataDir
    });
    await writeFile(path.join(root, 'app.js'), `const value = ${index + 1};\n`);
    await reviewTurnStop({
      ...identity, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.'
    }, { modeDataDir, runtimeDataDir, review: failingReview });
  }
  assert.equal(calls, 3);

  const noChange = { session_id: 'circuit-session', turn_id: 'no-change', cwd: root };
  await captureTurnStart({ ...noChange, hook_event_name: 'UserPromptSubmit', prompt: 'Inspect only' }, {
    modeDataDir, runtimeDataDir
  });
  const local = await reviewTurnStop({
    ...noChange, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'No changes.'
  }, { modeDataDir, runtimeDataDir });
  assert.equal(local.output.decision, 'block');
  assert.equal(local.result.status, 'no_findings');
  assert.equal(JSON.parse(await readFile(local.receipt, 'utf8')).provider, 'none');
  assert.equal(calls, 3);

  const fourth = { session_id: 'circuit-session', turn_id: 'failure-4', cwd: root };
  await captureTurnStart({ ...fourth, hook_event_name: 'UserPromptSubmit', prompt: 'One more' }, {
    modeDataDir, runtimeDataDir
  });
  await writeFile(path.join(root, 'app.js'), 'const value = 5;\n');
  const stopped = await reviewTurnStop({
    ...fourth, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done again.'
  }, { modeDataDir, runtimeDataDir, review: failingReview });
  assert.match(stopped.output.systemMessage, /circuit is temporarily open/);
  assert.equal(calls, 3);
});

test('provider circuit state is isolated by the exact configured model', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  const modelA = 'grok-circuit-a';
  const modelB = 'grok-circuit-b';
  await changeMode({ root, action: 'enable', provider: 'grok', model: modelA, dataDir: modeDataDir });
  let failedCalls = 0;
  const failingReview = async () => {
    failedCalls += 1;
    throw new Error('model A unavailable');
  };
  const runChangedTurn = async (turnId, value, review) => {
    const identity = { session_id: 'model-circuit-session', turn_id: turnId, cwd: root };
    await captureTurnStart({
      ...identity, hook_event_name: 'UserPromptSubmit', prompt: `Change to ${value}`
    }, { modeDataDir, runtimeDataDir });
    await writeFile(path.join(root, 'app.js'), `const value = ${value};\n`);
    return reviewTurnStop({
      ...identity, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.'
    }, { modeDataDir, runtimeDataDir, review });
  };

  for (let index = 0; index < 3; index += 1) {
    await runChangedTurn(`model-a-failure-${index}`, 20 + index, failingReview);
  }
  assert.equal(failedCalls, 3);

  await changeMode({ root, action: 'enable', provider: 'grok', model: modelB, dataDir: modeDataDir });
  let modelBCalls = 0;
  const modelBResult = await runChangedTurn('model-b-success', 30, async (evidence) => {
    modelBCalls += 1;
    return {
      evidence,
      provider: 'grok',
      model: modelB,
      result: {
        schema_version: '1', status: 'no_findings', summary: 'Model B completed.', findings: [], comments: []
      }
    };
  });
  assert.equal(modelBCalls, 1);
  assert.equal(modelBResult.result.status, 'no_findings');

  await changeMode({ root, action: 'enable', provider: 'grok', model: modelA, dataDir: modeDataDir });
  const modelAStillOpen = await runChangedTurn('model-a-still-open', 31, async () => {
    throw new Error('model A circuit must remain open');
  });
  assert.match(modelAStillOpen.output.systemMessage, /circuit is temporarily open/);
  assert.equal(failedCalls, 3);
});

test('automatic lifecycle abstains rather than falling back when the baseline is missing', async () => {
  const root = await makeRepository();
  const modeDataDir = await temporaryDirectory('codex-buddy-mode-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-runtime-');
  await changeMode({ root, action: 'enable', dataDir: modeDataDir });
  const stopped = await reviewTurnStop({
    hook_event_name: 'Stop',
    session_id: 'missing-session',
    turn_id: 'missing-turn',
    cwd: root,
    stop_hook_active: false,
    last_assistant_message: 'Done.'
  }, { modeDataDir, runtimeDataDir });
  assert.equal(stopped.skipped, 'missing_baseline');
  assert.match(stopped.output.systemMessage, /exact start snapshot/);
  assert.match(stopped.output.systemMessage, /Mode enable does not capture a baseline/);
  assert.match(stopped.output.systemMessage, /next full turn establishes one at prompt submit/);
  assert.match(stopped.output.systemMessage, /No provider was called/);
});

test('pet outbox is immutable, deduplicated, bounded, and omits raw review evidence', async () => {
  const root = await makeRepository();
  const runtimeDataDir = await temporaryDirectory('codex-buddy-outbox-');
  const options = {
    runtimeDataDir,
    repositoryRoot: root,
    sessionId: 'session-private-value',
    turnId: 'turn-private-value',
    reviewKey: 'a'.repeat(64),
    type: 'review_completed',
    state: 'findings',
    headline: 'Review complete\u001b]52;c;payload\u0007',
    workerSummary: 'PRIVATE_WORKER_SUMMARY_SENTINEL',
    result: {
      schema_version: '1',
      status: 'findings',
      summary: 'One issue.',
      findings: [{
        severity: 'high', confidence: 0.9, title: 'Issue', body: 'Body', impact: 'Impact',
        path: 'app.js', line_start: 1, line_end: 1, evidence: 'Evidence', recommendation: 'Fix it.'
      }],
      comments: []
    },
    provider: 'ollama',
    model: 'glm-5.2:cloud'
  };
  const first = await appendOutboxEvent(options);
  const second = await appendOutboxEvent(options);
  assert.equal(first.file, second.file);
  const text = await readFile(first.file, 'utf8');
  assert.doesNotMatch(
    text,
    /session-private-value|turn-private-value|patch|stderr|Evidence|Impact|PRIVATE_WORKER_SUMMARY_SENTINEL/
  );
  assert.match(text, /\\u\{001b\}/);
  assert.equal(JSON.parse(text).event_id, first.event.event_id);
  assert.equal(JSON.parse(text).payload.worker_summary, null);
});
