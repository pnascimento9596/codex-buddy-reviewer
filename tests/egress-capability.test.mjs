import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  drainEgressCapabilities,
  egressConfigurationHash,
  issueEgressCapability,
  issueEgressCapabilityBatch,
  readEgressRegistry,
  snapshotActiveEgressCapabilities,
  spendEgressCapability
} from '../src/egress-capability.mjs';
import { changeMode, readMode } from '../src/mode.mjs';
import {
  approveProviderReviewRequest,
  inspectApprovedProviderReviewRequest
} from '../src/provider-registry.mjs';
import {
  changeSummaryClaimGuardConsent,
  readSummaryClaimGuardConsent
} from '../src/summary-claim-guard.mjs';
import { withFileLock, workspaceKey } from '../src/state.mjs';

const temporaryPaths = [];
const REVIEW_KEY = 'c'.repeat(64);

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture(label) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `codex-buddy-egress-${label}-`));
  temporaryPaths.push(directory);
  const root = path.join(directory, 'workspace');
  const dataDir = path.join(directory, 'state');
  await mkdir(root);
  return { root, dataDir };
}

function configuration(overrides = {}) {
  return {
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    effort: 'high',
    timeout_ms: 2_000,
    min_confidence: 0.75,
    max_patch_bytes: 256 * 1024,
    ...overrides
  };
}

test('capability configuration rejects credential-shaped model identifiers', () => {
  const model = ['xai-', 'A9_bC7-dE5_fG3-hJ1_kL8'].join('');
  assert.throws(
    () => egressConfigurationHash(configuration({ model })),
    /egress configuration is invalid/
  );
});

function binding(overrides = {}) {
  const { configuration: configurationOverrides, ...bindingOverrides } = overrides;
  const config = configuration(configurationOverrides);
  return {
    sessionKey: 'a'.repeat(24),
    turnKey: 'b'.repeat(24),
    reviewKey: REVIEW_KEY,
    modeRevision: 1,
    provider: config.provider,
    model: config.model,
    effort: config.effort,
    timeoutMs: config.timeout_ms,
    configurationSha256: egressConfigurationHash(config),
    summaryConsentRevision: null,
    summarySha256: null,
    ...bindingOverrides
  };
}

function technicalRequest(prompt = 'PRIVATE_PROVIDER_PROMPT') {
  return {
    prompt,
    responseSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string' } }
    },
    summaryGuardPacket: null
  };
}

function approveRequest(scope, requestBinding, request, purpose = 'technical_review') {
  return approveProviderReviewRequest(requestBinding.provider, {
    root: scope.root,
    prompt: request.prompt,
    model: requestBinding.model,
    effort: requestBinding.effort,
    timeoutMs: requestBinding.timeoutMs,
    responseSchema: request.responseSchema
  }, {
    purpose,
    summaryGuardPacket: request.summaryGuardPacket
  });
}

function summaryRequest(summary = 'PRIVATE_WORKER_SUMMARY') {
  const packet = {
    schema_version: '1',
    purpose: 'worker_summary_claim_advisory',
    policy_version: '1',
    consent_revision: 2,
    review_key: REVIEW_KEY,
    offset_unit: 'utf16_code_unit',
    summary,
    summary_sha256: sha256(summary),
    summary_truncated: false
  };
  return {
    request: {
      prompt: `PRIVATE_PROVIDER_PROMPT\n${JSON.stringify(packet)}`,
      responseSchema: {
        type: 'object',
        properties: { technical_review: { type: 'object' } }
      },
      summaryGuardPacket: packet
    },
    binding: binding({
      summaryConsentRevision: packet.consent_revision,
      summarySha256: packet.summary_sha256
    })
  };
}

function registryFile({ root, dataDir }) {
  return path.join(dataDir, 'egress', workspaceKey(root), 'active.json');
}

function registryRecord(scope, {
  capabilityId = '1'.repeat(64),
  state = 'issued',
  expired = true,
  legacy = false,
  overrides = {}
} = {}) {
  const nowMs = Date.now();
  const issuedAtMs = state === 'issued'
    ? nowMs + (expired ? -60_000 : 0)
    : nowMs + (expired ? -60_000 : -5_000);
  const consumedAtMs = state === 'consumed' ? issuedAtMs + 4_000 : null;
  const record = {
    capability_id: capabilityId,
    token_sha256: '2'.repeat(64),
    workspace_key: workspaceKey(scope.root),
    session_key: 'a'.repeat(24),
    turn_key: 'b'.repeat(24),
    review_key: REVIEW_KEY,
    mode_revision: 1,
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    effort: 'high',
    timeout_ms: 2_000,
    configuration_sha256: '3'.repeat(64),
    prompt_sha256: '4'.repeat(64),
    prompt_bytes: 128,
    response_schema_sha256: '5'.repeat(64),
    summary_consent_revision: null,
    summary_sha256: null,
    summary_packet_sha256: null,
    owner_pid: process.pid,
    owner_nonce: '6'.repeat(32),
    issued_at: new Date(issuedAtMs).toISOString(),
    spend_deadline_at: new Date(issuedAtMs + 30_000).toISOString(),
    deadline_at: consumedAtMs === null
      ? null
      : new Date(consumedAtMs + 12_000).toISOString(),
    state,
    consumed_at: consumedAtMs === null ? null : new Date(consumedAtMs).toISOString(),
    ...overrides
  };
  if (legacy) return record;
  return {
    ...record,
    approval_sha256: '7'.repeat(64),
    content_policy_version: '1',
    channel_inventory_sha256: '8'.repeat(64)
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error('condition was not reached before timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('issuance snapshots immutable bindings and request data without persisting private payloads', async () => {
  const scope = await fixture('immutable');
  const prepared = summaryRequest();
  const originalPrompt = prepared.request.prompt;
  const originalSummary = prepared.request.summaryGuardPacket.summary;
  const approvedRequest = approveRequest(scope, prepared.binding, prepared.request);
  const capability = await issueEgressCapability({
    ...scope,
    binding: prepared.binding,
    approvedRequest
  });

  prepared.binding.provider = 'grok';
  prepared.request.prompt = 'MUTATED_PROMPT';
  prepared.request.responseSchema.type = 'array';
  prepared.request.summaryGuardPacket.summary = 'MUTATED_SUMMARY';

  const rawRegistry = await readFile(registryFile(scope), 'utf8');
  assert.doesNotMatch(rawRegistry, /PRIVATE_PROVIDER_PROMPT|PRIVATE_WORKER_SUMMARY|MUTATED_/);
  assert.doesNotMatch(rawRegistry, /summaryGuardPacket|responseSchema/);

  const spent = await spendEgressCapability({ ...scope, capability }, async (boundApproval) => {
    assert.equal(boundApproval, approvedRequest);
    const metadata = inspectApprovedProviderReviewRequest(boundApproval);
    assert.equal(metadata.promptSha256, sha256(originalPrompt));
    assert.equal(metadata.summarySha256, sha256(originalSummary));
    return 'review-complete';
  });

  assert.equal(spent.value, 'review-complete');
  assert.equal(spent.audit.provider, 'ollama');
  assert.equal(spent.audit.model, 'glm-5.2:cloud');
  assert.equal(spent.audit.review_key, REVIEW_KEY);
  assert.equal(spent.audit.summary_sha256, sha256(originalSummary));
  assert.equal(spent.audit.prompt_sha256, sha256(originalPrompt));
  assert.equal(spent.audit.content_policy_version, '1');
  assert.match(spent.audit.approval_sha256, /^[0-9a-f]{64}$/u);
  assert.match(spent.audit.channel_inventory_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.values(spent.audit).includes(originalPrompt), false);
  assert.equal((await readEgressRegistry(scope)).active.length, 0);
});

test('batch issuance is atomic and each reviewer receives only its exact immutable request', async () => {
  const scope = await fixture('atomic-batch');
  const summary = summaryRequest('BATCH_PRIVATE_SUMMARY');
  const technical = technicalRequest('SECOND_PRIVATE_PROVIDER_PROMPT');
  const grokBinding = binding({
    configuration: { provider: 'grok', model: 'grok-4.5' }
  });
  const capabilities = await issueEgressCapabilityBatch({
    ...scope,
    entries: [
      { binding: summary.binding, approvedRequest: approveRequest(scope, summary.binding, summary.request) },
      { binding: grokBinding, approvedRequest: approveRequest(scope, grokBinding, technical) }
    ]
  });

  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(capabilities.length, 2);
  const registryText = await readFile(registryFile(scope), 'utf8');
  assert.doesNotMatch(registryText, /BATCH_PRIVATE_SUMMARY|PRIVATE_PROVIDER_PROMPT|SECOND_PRIVATE_PROVIDER_PROMPT/);
  const registry = await readEgressRegistry(scope);
  assert.equal(registry.active.length, 2);
  assert.equal(registry.active[0].issued_at, registry.active[1].issued_at);

  const [first, second] = await Promise.all([
    spendEgressCapability({ ...scope, capability: capabilities[0] }, async (approvedRequest) => {
      assert.equal(inspectApprovedProviderReviewRequest(approvedRequest).summarySha256, sha256('BATCH_PRIVATE_SUMMARY'));
      return 'summary reviewer';
    }),
    spendEgressCapability({ ...scope, capability: capabilities[1] }, async (approvedRequest) => {
      const metadata = inspectApprovedProviderReviewRequest(approvedRequest);
      assert.equal(metadata.promptSha256, sha256('SECOND_PRIVATE_PROVIDER_PROMPT'));
      assert.equal(metadata.summaryPacketSha256, null);
      return 'technical reviewer';
    })
  ]);
  assert.equal(first.value, 'summary reviewer');
  assert.equal(second.value, 'technical reviewer');
  assert.equal((await readEgressRegistry(scope)).active.length, 0);

  const invalidScope = await fixture('atomic-batch-invalid');
  await assert.rejects(
    issueEgressCapabilityBatch({
      ...invalidScope,
      entries: [
        {
          binding: binding(),
          approvedRequest: approveRequest(invalidScope, binding(), technicalRequest('valid first request'))
        },
        { binding: grokBinding, approvedRequest: Object.freeze({}) }
      ]
    }),
    /not an approved local handle/
  );
  assert.equal((await readEgressRegistry(invalidScope)).active.length, 0);
});

test('empty v1 registries upgrade safely', async () => {
  const emptyScope = await fixture('schema-upgrade-empty');
  await mkdir(path.dirname(registryFile(emptyScope)), { recursive: true });
  await writeFile(registryFile(emptyScope), JSON.stringify({
    schema_version: '1',
    workspace_key: workspaceKey(emptyScope.root),
    active: []
  }));
  assert.equal((await readEgressRegistry(emptyScope)).schema_version, '2');
  assert.equal(JSON.parse(await readFile(registryFile(emptyScope), 'utf8')).schema_version, '2');
});

test('expired issued and consumed v1 capabilities migrate only by being discarded', async () => {
  const scope = await fixture('schema-upgrade-expired');
  await mkdir(path.dirname(registryFile(scope)), { recursive: true });
  await writeFile(registryFile(scope), JSON.stringify({
    schema_version: '1',
    workspace_key: workspaceKey(scope.root),
    active: [
      registryRecord(scope, {
        capabilityId: '1'.repeat(64),
        state: 'issued',
        expired: true,
        legacy: true
      }),
      registryRecord(scope, {
        capabilityId: '2'.repeat(64),
        state: 'consumed',
        expired: true,
        legacy: true
      })
    ]
  }));

  const migrated = await readEgressRegistry(scope);
  assert.equal(migrated.schema_version, '2');
  assert.deepEqual(migrated.active, []);
  assert.deepEqual(JSON.parse(await readFile(registryFile(scope), 'utf8')), migrated);
});

test('unexpired v1 capabilities fail closed and are not rewritten', async () => {
  for (const state of ['issued', 'consumed']) {
    const scope = await fixture(`schema-upgrade-unexpired-${state}`);
    const file = registryFile(scope);
    await mkdir(path.dirname(file), { recursive: true });
    const original = {
      schema_version: '1',
      workspace_key: workspaceKey(scope.root),
      active: [registryRecord(scope, { state, expired: false, legacy: true })]
    };
    await writeFile(file, JSON.stringify(original));

    await assert.rejects(
      readEgressRegistry(scope),
      /active legacy capabilities expire/
    );
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
  }
});

test('malformed v1 capabilities fail closed and are not rewritten', async () => {
  const scope = await fixture('schema-upgrade-malformed');
  const file = registryFile(scope);
  await mkdir(path.dirname(file), { recursive: true });
  const original = {
    schema_version: '1',
    workspace_key: workspaceKey(scope.root),
    active: [registryRecord(scope, {
      expired: true,
      legacy: true,
      overrides: { prompt_sha256: 'malformed' }
    })]
  };
  await writeFile(file, JSON.stringify(original));

  await assert.rejects(readEgressRegistry(scope), /capability record is invalid/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
});

test('v2 registry recovery retains expired capabilities until positive settlement', async () => {
  const scope = await fixture('schema-v2-expiry-recovery');
  const file = registryFile(scope);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    schema_version: '2',
    workspace_key: workspaceKey(scope.root),
    active: [
      registryRecord(scope, {
        capabilityId: '1'.repeat(64),
        state: 'issued',
        expired: true
      }),
      registryRecord(scope, {
        capabilityId: '2'.repeat(64),
        state: 'consumed',
        expired: true
      }),
      registryRecord(scope, {
        capabilityId: '3'.repeat(64),
        state: 'issued',
        expired: false
      }),
      registryRecord(scope, {
        capabilityId: '4'.repeat(64),
        state: 'consumed',
        expired: false
      })
    ]
  }));

  const recovered = await readEgressRegistry(scope);
  assert.deepEqual(
    recovered.active.map(({ capability_id: capabilityId, state }) => ({ capabilityId, state })),
    [
      { capabilityId: '1'.repeat(64), state: 'issued' },
      { capabilityId: '2'.repeat(64), state: 'consumed' },
      { capabilityId: '3'.repeat(64), state: 'issued' },
      { capabilityId: '4'.repeat(64), state: 'consumed' }
    ]
  );
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), recovered);
});

test('issuance starts its spend window only after registry-lock contention clears', async () => {
  const scope = await fixture('issuance-lock-deadline');
  const registryLock = path.join(scope.dataDir, 'egress', workspaceKey(scope.root), 'registry');
  let lockHeld;
  const held = new Promise((resolve) => { lockHeld = resolve; });
  let releaseLock;
  const release = new Promise((resolve) => { releaseLock = resolve; });
  const holding = withFileLock(registryLock, async () => {
    lockHeld();
    await release;
  }, { timeoutMs: 2_000, staleMs: 2_000 });
  await held;

  const issuing = issueEgressCapability({
    ...scope,
    binding: binding(),
    approvedRequest: approveRequest(scope, binding(), technicalRequest())
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const lockReleasedAt = Date.now();
  releaseLock();
  await holding;
  await issuing;

  const [record] = (await readEgressRegistry(scope)).active;
  const issuedAt = Date.parse(record.issued_at);
  assert.equal(issuedAt >= lockReleasedAt, true);
  assert.equal(Date.parse(record.spend_deadline_at) - issuedAt, 30_000);
});

test('registry tampering and forged capabilities cannot alter or spend an issued binding', async () => {
  const scope = await fixture('tamper');
  const capability = await issueEgressCapability({
    ...scope,
    binding: binding(),
    approvedRequest: approveRequest(scope, binding(), technicalRequest())
  });
  const promptBoundCapability = await issueEgressCapability({
    ...scope,
    binding: binding({ reviewKey: 'd'.repeat(64) }),
    approvedRequest: approveRequest(
      scope,
      binding({ reviewKey: 'd'.repeat(64) }),
      technicalRequest('second exact prompt')
    )
  });
  const forged = Object.freeze({ capability_id: capability.capability_id });
  let calls = 0;
  await assert.rejects(
    spendEgressCapability({ ...scope, capability: forged }, async () => { calls += 1; }),
    /unknown or non-local capability/
  );

  const file = registryFile(scope);
  const registry = JSON.parse(await readFile(file, 'utf8'));
  registry.active[0].provider = 'grok';
  registry.active[0].model = 'grok-4.5';
  registry.active[1].prompt_sha256 = 'e'.repeat(64);
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`);
  await assert.rejects(
    spendEgressCapability({ ...scope, capability }, async () => { calls += 1; }),
    /binding does not match/
  );
  await assert.rejects(
    spendEgressCapability({ ...scope, capability: promptBoundCapability }, async () => { calls += 1; }),
    /binding does not match/
  );
  assert.equal(calls, 0);
});

test('deadline corruption is rejected and drain options fail closed on invalid selectors and waits', async () => {
  const scope = await fixture('validation');
  const first = await issueEgressCapability({
    ...scope,
    binding: binding({ modeRevision: 1 }),
    approvedRequest: approveRequest(scope, binding({ modeRevision: 1 }), technicalRequest('first prompt'))
  });
  const summary = summaryRequest('SECOND_PRIVATE_SUMMARY');
  const second = await issueEgressCapability({
    ...scope,
    binding: { ...summary.binding, modeRevision: 3 },
    approvedRequest: approveRequest(scope, summary.binding, summary.request)
  });

  assert.deepEqual(await snapshotActiveEgressCapabilities({ ...scope, modeRevision: 1 }), [first.capability_id]);
  assert.deepEqual(await snapshotActiveEgressCapabilities({ ...scope, summaryConsentRevision: 2 }), [second.capability_id]);
  assert.deepEqual(
    await snapshotActiveEgressCapabilities({ ...scope, modeRevision: 3 }),
    [first.capability_id, second.capability_id].sort()
  );
  await assert.rejects(
    snapshotActiveEgressCapabilities({ ...scope }),
    /unsupported or missing fields|exactly one revision selector/
  );
  await assert.rejects(
    snapshotActiveEgressCapabilities({ ...scope, modeRevision: 1, summaryConsentRevision: 2 }),
    /unsupported or missing fields|exactly one revision selector/
  );
  await assert.rejects(snapshotActiveEgressCapabilities({ ...scope, modeRevision: -1 }), /non-negative/);
  await assert.rejects(snapshotActiveEgressCapabilities({ ...scope, summaryConsentRevision: 0 }), /positive/);
  for (const timeoutMs of [-1, Number.NaN, 570_001]) {
    await assert.rejects(
      drainEgressCapabilities({ ...scope, capabilityIds: [first.capability_id], timeoutMs }),
      /drain timeout/
    );
  }
  await assert.rejects(
    drainEgressCapabilities({
      ...scope,
      capabilityIds: [first.capability_id, first.capability_id],
      timeoutMs: 0
    }),
    /must be unique/
  );

  const file = registryFile(scope);
  const registry = JSON.parse(await readFile(file, 'utf8'));
  registry.active[0].spend_deadline_at = new Date(Date.parse(registry.active[0].spend_deadline_at) + 1).toISOString();
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`);
  await assert.rejects(readEgressRegistry(scope), /capability record is invalid/);
});

test('a capability can be spent once under concurrent contention', async () => {
  const scope = await fixture('single-use');
  const capability = await issueEgressCapability({
    ...scope,
    binding: binding(),
    approvedRequest: approveRequest(scope, binding(), technicalRequest())
  });
  let entered;
  const executorEntered = new Promise((resolve) => { entered = resolve; });
  let release;
  const executorReleased = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const first = spendEgressCapability({ ...scope, capability }, async () => {
    calls += 1;
    entered();
    await executorReleased;
    return 'only result';
  });
  await executorEntered;
  await assert.rejects(
    spendEgressCapability({ ...scope, capability }, async () => { calls += 1; }),
    /already been consumed/
  );
  release();
  assert.equal((await first).value, 'only result');
  await assert.rejects(
    spendEgressCapability({ ...scope, capability }, async () => { calls += 1; }),
    /unknown or non-local capability/
  );
  assert.equal(calls, 1);
});

test('executor failures retain capability audit metadata and still settle exactly once', async () => {
  const scope = await fixture('executor-error');
  const capability = await issueEgressCapability({
    ...scope,
    binding: binding(),
    approvedRequest: approveRequest(scope, binding(), technicalRequest())
  });
  const providerError = new Error('bounded provider failure');
  providerError.failureCode = 'deadline_exceeded';
  let caught;
  try {
    await spendEgressCapability({ ...scope, capability }, async () => { throw providerError; });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, providerError);
  assert.equal(caught.failureCode, 'deadline_exceeded');
  assert.equal(caught.egressCapabilityStage, 'executor');
  assert.equal(caught.egressCapabilityAudit.capability_id, capability.capability_id);
  assert.equal(caught.egressCapabilityAudit.prompt_sha256, sha256('PRIVATE_PROVIDER_PROMPT'));
  assert.equal((await readEgressRegistry(scope)).active.length, 0);
  await assert.rejects(
    spendEgressCapability({ ...scope, capability }, async () => 'must not run'),
    /unknown or non-local capability/
  );

  const frozenCapability = await issueEgressCapability({
    ...scope,
    binding: binding({ reviewKey: 'f'.repeat(64) }),
    approvedRequest: approveRequest(
      scope,
      binding({ reviewKey: 'f'.repeat(64) }),
      technicalRequest('frozen-error prompt')
    )
  });
  const frozenError = new Error('frozen provider failure');
  frozenError.failureCode = 'transport_exit';
  Object.freeze(frozenError);
  let wrapped;
  try {
    await spendEgressCapability({ ...scope, capability: frozenCapability }, async () => { throw frozenError; });
  } catch (error) {
    wrapped = error;
  }
  assert.notEqual(wrapped, frozenError);
  assert.equal(wrapped.cause, frozenError);
  assert.equal(wrapped.failureCode, 'transport_exit');
  assert.equal(wrapped.egressCapabilityStage, 'executor');
  assert.equal(wrapped.egressCapabilityAudit.capability_id, frozenCapability.capability_id);
});

test('settlement failures are distinguished and dual failures preserve both stages', async () => {
  const scope = await fixture('settlement-error');
  const removeConsumedRecord = async () => {
    const registry = JSON.parse(await readFile(registryFile(scope), 'utf8'));
    assert.equal(registry.active.length, 1);
    assert.equal(registry.active[0].state, 'consumed');
    registry.active = [];
    await writeFile(registryFile(scope), `${JSON.stringify(registry, null, 2)}\n`);
  };

  const settlementOnlyCapability = await issueEgressCapability({
    ...scope,
    binding: binding(),
    approvedRequest: approveRequest(scope, binding(), technicalRequest('settlement-only prompt'))
  });
  let settlementOnly;
  try {
    await spendEgressCapability({ ...scope, capability: settlementOnlyCapability }, async () => {
      await removeConsumedRecord();
      return 'provider succeeded';
    });
  } catch (error) {
    settlementOnly = error;
  }
  assert.equal(settlementOnly.egressCapabilityStage, 'settlement');
  assert.equal(
    settlementOnly.egressCapabilityAudit.capability_id,
    settlementOnlyCapability.capability_id
  );
  assert.match(settlementOnly.message, /disappeared before positive settlement/);

  const dualCapability = await issueEgressCapability({
    ...scope,
    binding: binding({ reviewKey: 'd'.repeat(64) }),
    approvedRequest: approveRequest(
      scope,
      binding({ reviewKey: 'd'.repeat(64) }),
      technicalRequest('dual-failure prompt')
    )
  });
  const providerError = new Error('provider failed before settlement');
  providerError.failureCode = 'transport_exit';
  let dual;
  try {
    await spendEgressCapability({ ...scope, capability: dualCapability }, async () => {
      await removeConsumedRecord();
      throw providerError;
    });
  } catch (error) {
    dual = error;
  }
  assert.equal(dual, providerError);
  assert.equal(dual.egressCapabilityStage, 'executor');
  assert.equal(dual.failureCode, 'transport_exit');
  assert.equal(dual.egressCapabilityAudit.capability_id, dualCapability.capability_id);
  assert.equal(dual.egressCapabilitySettlementError.egressCapabilityStage, 'settlement');
  assert.equal(
    dual.egressCapabilitySettlementError.egressCapabilityAudit.capability_id,
    dualCapability.capability_id
  );
  assert.match(dual.egressCapabilitySettlementError.message, /disappeared before positive settlement/);
});

test('drain waits for positive executor settlement and never infers completion from time or ownership', async () => {
  const scope = await fixture('drain');
  const capability = await issueEgressCapability({
    ...scope,
    binding: binding(),
    approvedRequest: approveRequest(scope, binding(), technicalRequest())
  });
  let entered;
  const executorEntered = new Promise((resolve) => { entered = resolve; });
  let release;
  const executorReleased = new Promise((resolve) => { release = resolve; });
  const spending = spendEgressCapability({ ...scope, capability }, async () => {
    entered();
    await executorReleased;
    return 'settled';
  });
  await executorEntered;
  const realDateNow = Date.now;
  let ids;
  try {
    Date.now = () => realDateNow() + 120_000;
    ids = await snapshotActiveEgressCapabilities({ ...scope, modeRevision: 1 });
    assert.deepEqual(ids, [capability.capability_id]);
    await assert.rejects(
      drainEgressCapabilities({ ...scope, capabilityIds: ids, timeoutMs: 0 }),
      /drain timed out/
    );
    assert.equal((await readEgressRegistry(scope)).active[0].state, 'consumed');
  } finally {
    Date.now = realDateNow;
  }

  let drained = false;
  const draining = drainEgressCapabilities({ ...scope, capabilityIds: ids, timeoutMs: 1_000 })
    .then((value) => {
      drained = true;
      return value;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  assert.equal((await spending).value, 'settled');
  assert.deepEqual(await draining, { drained: 1 });
});

test('mode disable commits under its short lock but returns only after prior-mode capability drain', async () => {
  const scope = await fixture('mode-drain');
  const enabled = await changeMode({ ...scope, action: 'enable', timeoutMs: 2_000 });
  const config = configuration({
    provider: enabled.provider,
    model: enabled.model,
    effort: enabled.effort,
    timeout_ms: enabled.timeout_ms,
    min_confidence: enabled.min_confidence,
    max_patch_bytes: enabled.max_patch_bytes
  });
  const enabledBinding = binding({
    modeRevision: enabled.config_revision,
    provider: enabled.provider,
    model: enabled.model,
    effort: enabled.effort,
    timeoutMs: enabled.timeout_ms,
    configurationSha256: egressConfigurationHash(config)
  });
  const capability = await issueEgressCapability({
    ...scope,
    binding: enabledBinding,
    approvedRequest: approveRequest(scope, enabledBinding, technicalRequest())
  });
  let entered;
  const executorEntered = new Promise((resolve) => { entered = resolve; });
  let release;
  const executorReleased = new Promise((resolve) => { release = resolve; });
  const spending = spendEgressCapability({ ...scope, capability }, async () => {
    entered();
    await executorReleased;
    return true;
  });
  await executorEntered;

  let disableSettled = false;
  const disabling = changeMode({ ...scope, action: 'disable' }).then((value) => {
    disableSettled = true;
    return value;
  });
  await waitFor(async () => (await readMode(scope)).enabled === false);
  assert.equal(disableSettled, false);
  release();
  await spending;
  assert.equal((await disabling).enabled, false);
});

test('overlapping summary disables both drain unresolved capabilities from older revisions', async () => {
  const scope = await fixture('summary-drain');
  const consent = await changeSummaryClaimGuardConsent({
    ...scope,
    action: 'enable',
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    confirmSummaryEgress: true
  });
  const summary = summaryRequest('SUMMARY_REVOCATION_PRIVATE_TEXT');
  summary.request.summaryGuardPacket.consent_revision = consent.configuration_revision;
  summary.binding.summaryConsentRevision = consent.configuration_revision;
  const capability = await issueEgressCapability({
    ...scope,
    binding: summary.binding,
    approvedRequest: approveRequest(scope, summary.binding, summary.request)
  });
  let entered;
  const executorEntered = new Promise((resolve) => { entered = resolve; });
  let release;
  const executorReleased = new Promise((resolve) => { release = resolve; });
  const spending = spendEgressCapability({ ...scope, capability }, async () => {
    entered();
    await executorReleased;
    return true;
  });
  await executorEntered;

  let disableSettled = false;
  const disabling = changeSummaryClaimGuardConsent({ ...scope, action: 'disable' }).then((value) => {
    disableSettled = true;
    return value;
  });
  await waitFor(async () => (await readSummaryClaimGuardConsent(scope)).enabled === false);
  assert.equal(disableSettled, false);
  let overlappingDisableSettled = false;
  const overlappingDisable = changeSummaryClaimGuardConsent({ ...scope, action: 'disable' })
    .then((value) => {
      overlappingDisableSettled = true;
      return value;
    });
  await waitFor(async () => (await readSummaryClaimGuardConsent(scope)).configuration_revision
    > consent.configuration_revision + 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overlappingDisableSettled, false);
  release();
  await spending;
  assert.equal((await disabling).enabled, false);
  assert.equal((await overlappingDisable).enabled, false);

  const reenabled = await changeSummaryClaimGuardConsent({
    ...scope,
    action: 'enable',
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    confirmSummaryEgress: true
  });
  assert.equal(reenabled.enabled, true);
  const technicalCapability = await issueEgressCapability({
    ...scope,
    binding: binding(),
    approvedRequest: approveRequest(scope, binding(), technicalRequest('technical-only prompt'))
  });
  let technicalEntered;
  const enteredTechnical = new Promise((resolve) => { technicalEntered = resolve; });
  let releaseTechnical;
  const releasedTechnical = new Promise((resolve) => { releaseTechnical = resolve; });
  const technicalSpend = spendEgressCapability({ ...scope, capability: technicalCapability }, async () => {
    technicalEntered();
    await releasedTechnical;
  });
  await enteredTechnical;
  const technicalUnaffected = await Promise.race([
    changeSummaryClaimGuardConsent({ ...scope, action: 'disable' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('technical call blocked summary disable')), 1_000))
  ]);
  assert.equal(technicalUnaffected.enabled, false);
  releaseTechnical();
  await technicalSpend;
});
