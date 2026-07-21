import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { PROVIDER_CONTENT_POLICY_VERSION } from './approved-provider-request.mjs';
import { inspectApprovedProviderReviewRequest } from './provider-registry.mjs';
import { assessProviderModelIdentifier } from './secret-scan.mjs';

import {
  canonicalJson,
  ensurePrivateStatePath,
  readPrivateJson,
  resolveDataDir,
  withFileLock,
  workspaceKey,
  writePrivateJsonAtomic
} from './state.mjs';

const REGISTRY_SCHEMA_VERSION = '2';
const CAPABILITY_ID_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const REVIEW_KEY_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_KEY_PATTERN = /^[0-9a-f]{24}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const PROVIDERS = new Set(['claude', 'grok', 'ollama', 'opencode']);
const STATES = new Set(['issued', 'consumed']);
const REGISTRY_LOCK_TIMEOUT_MS = 30_000;
const PROVIDER_LANE_TIMEOUT_MS = 570_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 570_000;
const CAPABILITY_SPEND_WINDOW_MS = 30_000;
const CAPABILITY_DEADLINE_GRACE_MS = 10_000;
const MAX_ACTIVE_CAPABILITIES = 1_024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const PRIVATE_CAPABILITIES = new WeakMap();
const LEGACY_RECORD_FIELDS = Object.freeze([
  'capability_id',
  'token_sha256',
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
  'prompt_sha256',
  'prompt_bytes',
  'response_schema_sha256',
  'summary_consent_revision',
  'summary_sha256',
  'summary_packet_sha256',
  'owner_pid',
  'owner_nonce',
  'issued_at',
  'spend_deadline_at',
  'deadline_at',
  'state',
  'consumed_at'
]);

function fail(message) {
  throw new Error(`Buddy egress capability: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain data object`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) fail(`${label} contains unsupported symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (ownKeys.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    fail(`${label} contains unsupported accessors or hidden fields`);
  }
  const actual = ownKeys.sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateRecord(record, expectedWorkspaceKey) {
  exactKeys(record, [
    'capability_id',
    'token_sha256',
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
    'owner_pid',
    'owner_nonce',
    'issued_at',
    'spend_deadline_at',
    'deadline_at',
    'state',
    'consumed_at'
  ], 'capability record');
  const issuedAtMs = Date.parse(record.issued_at);
  const spendDeadlineAtMs = Date.parse(record.spend_deadline_at);
  const consumedAtMs = record.consumed_at === null ? null : Date.parse(record.consumed_at);
  const deadlineAtMs = record.deadline_at === null ? null : Date.parse(record.deadline_at);
  if (!CAPABILITY_ID_PATTERN.test(record.capability_id)
      || !TOKEN_HASH_PATTERN.test(record.token_sha256)
      || record.workspace_key !== expectedWorkspaceKey
      || !OPAQUE_KEY_PATTERN.test(record.session_key)
      || !OPAQUE_KEY_PATTERN.test(record.turn_key)
      || !REVIEW_KEY_PATTERN.test(record.review_key)
      || !Number.isSafeInteger(record.mode_revision) || record.mode_revision < 0
      || !PROVIDERS.has(record.provider)
      || !assessProviderModelIdentifier(record.model).allowed
      || !EFFORTS.has(record.effort)
      || !Number.isInteger(record.timeout_ms) || record.timeout_ms < 1_000 || record.timeout_ms > 480_000
      || !TOKEN_HASH_PATTERN.test(record.configuration_sha256)
      || !TOKEN_HASH_PATTERN.test(record.approval_sha256)
      || record.content_policy_version !== PROVIDER_CONTENT_POLICY_VERSION
      || !TOKEN_HASH_PATTERN.test(record.channel_inventory_sha256)
      || !TOKEN_HASH_PATTERN.test(record.prompt_sha256)
      || !Number.isSafeInteger(record.prompt_bytes) || record.prompt_bytes < 1
      || record.prompt_bytes > MAX_PROMPT_BYTES
      || !TOKEN_HASH_PATTERN.test(record.response_schema_sha256)
      || (record.summary_consent_revision !== null
        && (!Number.isSafeInteger(record.summary_consent_revision) || record.summary_consent_revision < 1))
      || (record.summary_sha256 !== null && !TOKEN_HASH_PATTERN.test(record.summary_sha256))
      || (record.summary_packet_sha256 !== null && !TOKEN_HASH_PATTERN.test(record.summary_packet_sha256))
      || !((record.summary_consent_revision === null) === (record.summary_sha256 === null)
        && (record.summary_sha256 === null) === (record.summary_packet_sha256 === null))
      || !Number.isSafeInteger(record.owner_pid) || record.owner_pid < 1
      || typeof record.owner_nonce !== 'string' || !/^[0-9a-f]{32}$/.test(record.owner_nonce)
      || !validTimestamp(record.issued_at) || !validTimestamp(record.spend_deadline_at)
      || spendDeadlineAtMs !== issuedAtMs + CAPABILITY_SPEND_WINDOW_MS
      || !STATES.has(record.state)
      || (record.state === 'issued'
        ? record.consumed_at !== null || record.deadline_at !== null
        : !validTimestamp(record.consumed_at) || !validTimestamp(record.deadline_at)
          || consumedAtMs < issuedAtMs || consumedAtMs > spendDeadlineAtMs
          || deadlineAtMs !== consumedAtMs + record.timeout_ms + CAPABILITY_DEADLINE_GRACE_MS)) {
    fail('capability record is invalid');
  }
  return Object.freeze({ ...record });
}

function emptyRegistry(key) {
  return { schema_version: REGISTRY_SCHEMA_VERSION, workspace_key: key, active: [] };
}

function validateLegacyRecord(record, expectedWorkspaceKey) {
  exactKeys(record, LEGACY_RECORD_FIELDS, 'legacy capability record');
  return validateRecord({
    ...record,
    approval_sha256: '0'.repeat(64),
    content_policy_version: PROVIDER_CONTENT_POLICY_VERSION,
    channel_inventory_sha256: '0'.repeat(64)
  }, expectedWorkspaceKey);
}

function releaseAtMs(record) {
  return record.state === 'issued'
    ? Date.parse(record.spend_deadline_at)
    : Date.parse(record.deadline_at);
}

function validateUniqueRecords(records, key, validator) {
  const seen = new Set();
  return records.map((record) => {
    const validated = validator(record, key);
    if (seen.has(validated.capability_id)) fail('egress registry has a duplicate capability id');
    seen.add(validated.capability_id);
    return validated;
  });
}

function validateRegistry(value, key, nowMs = Date.now()) {
  if (value === null) return { registry: emptyRegistry(key), persist: false };
  exactKeys(value, ['schema_version', 'workspace_key', 'active'], 'egress registry');
  if (value.workspace_key !== key || !Array.isArray(value.active)) {
    fail('egress registry has an invalid schema or workspace');
  }
  if (value.schema_version === '1') {
    const legacy = validateUniqueRecords(value.active, key, validateLegacyRecord);
    if (legacy.some((record) => releaseAtMs(record) > nowMs)) {
      fail('egress registry requires a safe schema migration after active legacy capabilities expire');
    }
    return { registry: emptyRegistry(key), persist: true };
  }
  if (value.schema_version !== REGISTRY_SCHEMA_VERSION) fail('egress registry requires a safe schema migration');
  const active = validateUniqueRecords(value.active, key, validateRecord);
  return {
    registry: { schema_version: REGISTRY_SCHEMA_VERSION, workspace_key: key, active },
    persist: false
  };
}

function pathsFor(root, dataDir) {
  if (typeof root !== 'string' || !root) fail('workspace root must be non-empty text');
  if (dataDir !== undefined && (typeof dataDir !== 'string' || !dataDir)) {
    fail('data directory must be non-empty text when provided');
  }
  const dataRoot = resolveDataDir(dataDir);
  const key = workspaceKey(root);
  const directory = path.join(dataRoot, 'egress', key);
  return {
    dataRoot,
    key,
    directory,
    registry: path.join(directory, 'active.json'),
    registryLock: path.join(directory, 'registry'),
    providerLane: path.join(directory, 'provider-lane')
  };
}

async function withRegistry({ root, dataDir }, callback) {
  const paths = pathsFor(root, dataDir);
  await ensurePrivateStatePath(paths.dataRoot, paths.directory);
  return withFileLock(paths.registryLock, async () => {
    const validated = validateRegistry(await readPrivateJson(paths.registry), paths.key);
    if (validated.persist) await writePrivateJsonAtomic(paths.registry, validated.registry);
    return callback(validated.registry, paths);
  }, { timeoutMs: REGISTRY_LOCK_TIMEOUT_MS, staleMs: REGISTRY_LOCK_TIMEOUT_MS });
}

function validateBinding(binding) {
  exactKeys(binding, [
    'sessionKey',
    'turnKey',
    'reviewKey',
    'modeRevision',
    'provider',
    'model',
    'effort',
    'timeoutMs',
    'configurationSha256',
    'summaryConsentRevision',
    'summarySha256'
  ], 'capability binding');
  const snapshot = Object.freeze({
    sessionKey: binding.sessionKey,
    turnKey: binding.turnKey,
    reviewKey: binding.reviewKey,
    modeRevision: binding.modeRevision,
    provider: binding.provider,
    model: binding.model,
    effort: binding.effort,
    timeoutMs: binding.timeoutMs,
    configurationSha256: binding.configurationSha256,
    summaryConsentRevision: binding.summaryConsentRevision,
    summarySha256: binding.summarySha256
  });
  const recordShape = {
    capability_id: '0'.repeat(64),
    token_sha256: '0'.repeat(64),
    workspace_key: '0'.repeat(16),
    session_key: snapshot.sessionKey,
    turn_key: snapshot.turnKey,
    review_key: snapshot.reviewKey,
    mode_revision: snapshot.modeRevision,
    provider: snapshot.provider,
    model: snapshot.model,
    effort: snapshot.effort,
    timeout_ms: snapshot.timeoutMs,
    configuration_sha256: snapshot.configurationSha256,
    approval_sha256: '0'.repeat(64),
    content_policy_version: PROVIDER_CONTENT_POLICY_VERSION,
    channel_inventory_sha256: '0'.repeat(64),
    prompt_sha256: '0'.repeat(64),
    prompt_bytes: 1,
    response_schema_sha256: '0'.repeat(64),
    summary_consent_revision: snapshot.summaryConsentRevision,
    summary_sha256: snapshot.summarySha256,
    summary_packet_sha256: snapshot.summarySha256,
    owner_pid: 1,
    owner_nonce: '0'.repeat(32),
    issued_at: new Date(0).toISOString(),
    spend_deadline_at: new Date(CAPABILITY_SPEND_WINDOW_MS).toISOString(),
    deadline_at: null,
    state: 'issued',
    consumed_at: null
  };
  validateRecord(recordShape, recordShape.workspace_key);
  return snapshot;
}

function recordMatchesPrivate(record, privateState) {
  const tokenDigest = Buffer.from(record.token_sha256, 'hex');
  const actualDigest = Buffer.from(sha256(privateState.token), 'hex');
  if (tokenDigest.length !== actualDigest.length || !timingSafeEqual(tokenDigest, actualDigest)) return false;
  const approval = inspectApprovedProviderReviewRequest(privateState.approvedRequest);
  return canonicalJson(record) === canonicalJson(privateState.record)
    && record.approval_sha256 === approval.approvalSha256
    && record.content_policy_version === approval.policyVersion
    && record.channel_inventory_sha256 === approval.channelInventorySha256
    && record.prompt_sha256 === approval.promptSha256
    && record.prompt_bytes === approval.promptBytes
    && record.response_schema_sha256 === approval.responseSchemaSha256
    && record.summary_packet_sha256 === approval.summaryPacketSha256;
}

export function egressConfigurationHash(configuration) {
  exactKeys(configuration, [
    'provider',
    'model',
    'effort',
    'timeout_ms',
    'min_confidence',
    'max_patch_bytes'
  ], 'egress configuration');
  if (!PROVIDERS.has(configuration.provider)
      || !assessProviderModelIdentifier(configuration.model).allowed
      || !EFFORTS.has(configuration.effort)
      || !Number.isSafeInteger(configuration.timeout_ms)
      || configuration.timeout_ms < 1_000 || configuration.timeout_ms > 480_000
      || !Number.isFinite(configuration.min_confidence)
      || configuration.min_confidence < 0 || configuration.min_confidence > 1
      || !Number.isSafeInteger(configuration.max_patch_bytes)
      || configuration.max_patch_bytes < 4_096) {
    fail('egress configuration is invalid');
  }
  return sha256(canonicalJson(configuration));
}

export async function withProviderLane(options, callback) {
  exactKeys(options, ['root', 'dataDir'], 'provider lane options');
  const { root, dataDir } = options;
  if (typeof callback !== 'function') throw new TypeError('provider lane callback must be a function');
  const paths = pathsFor(root, dataDir);
  await ensurePrivateStatePath(paths.dataRoot, paths.directory);
  return withFileLock(paths.providerLane, callback, {
    timeoutMs: PROVIDER_LANE_TIMEOUT_MS,
    staleMs: PROVIDER_LANE_TIMEOUT_MS
  });
}

function prepareIssuanceEntry(entry, index, root) {
  exactKeys(entry, ['approvedRequest', 'binding'], `capability issuance entry ${index}`);
  const { binding, approvedRequest } = entry;
  const bindingSnapshot = validateBinding(binding);
  const approval = inspectApprovedProviderReviewRequest(approvedRequest);
  if (approval.purpose !== 'technical_review'
      || approval.rootSha256 !== sha256(path.resolve(root))
      || approval.provider !== bindingSnapshot.provider
      || approval.model !== bindingSnapshot.model
      || approval.effort !== bindingSnapshot.effort
      || approval.timeoutMs !== bindingSnapshot.timeoutMs) {
    fail('approved provider request does not match its capability binding');
  }
  if (approval.summaryPacketSha256 === null) {
    if (bindingSnapshot.summaryConsentRevision !== null || bindingSnapshot.summarySha256 !== null) {
      fail('technical-only request must not carry summary consent bindings');
    }
  } else {
    if (approval.summaryConsentRevision !== bindingSnapshot.summaryConsentRevision
        || approval.summarySha256 !== bindingSnapshot.summarySha256
        || approval.summaryReviewKey !== bindingSnapshot.reviewKey) {
      fail('summary request does not match its consent, summary, and review bindings');
    }
  }
  return Object.freeze({
    bindingSnapshot,
    approvedRequest,
    approval,
    capabilityId: randomBytes(32).toString('hex'),
    token: randomBytes(32)
  });
}

export async function issueEgressCapabilityBatch(options) {
  exactKeys(options, ['root', 'dataDir', 'entries'], 'batch capability issuance options');
  const { root, dataDir, entries } = options;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 2) {
    fail('batch capability issuance requires one or two entries');
  }
  const prepared = entries.map((entry, index) => prepareIssuanceEntry(entry, index, root));
  const newIds = new Set(prepared.map((entry) => entry.capabilityId));
  if (newIds.size !== prepared.length) fail('capability id collision');

  const records = await withRegistry({ root, dataDir }, async (registry, paths) => {
    if (registry.active.length + prepared.length > MAX_ACTIVE_CAPABILITIES) {
      fail('active capability registry is full');
    }
    if (registry.active.some((item) => newIds.has(item.capability_id))) fail('capability id collision');
    const issuedAtMs = Date.now();
    const nextRecords = prepared.map(({ bindingSnapshot, approval, capabilityId, token }) => (
      validateRecord({
        capability_id: capabilityId,
        token_sha256: sha256(token),
        workspace_key: paths.key,
        session_key: bindingSnapshot.sessionKey,
        turn_key: bindingSnapshot.turnKey,
        review_key: bindingSnapshot.reviewKey,
        mode_revision: bindingSnapshot.modeRevision,
        provider: bindingSnapshot.provider,
        model: bindingSnapshot.model,
        effort: bindingSnapshot.effort,
        timeout_ms: bindingSnapshot.timeoutMs,
        configuration_sha256: bindingSnapshot.configurationSha256,
        approval_sha256: approval.approvalSha256,
        content_policy_version: approval.policyVersion,
        channel_inventory_sha256: approval.channelInventorySha256,
        prompt_sha256: approval.promptSha256,
        prompt_bytes: approval.promptBytes,
        response_schema_sha256: approval.responseSchemaSha256,
        summary_consent_revision: bindingSnapshot.summaryConsentRevision,
        summary_sha256: bindingSnapshot.summarySha256,
        summary_packet_sha256: approval.summaryPacketSha256,
        owner_pid: process.pid,
        owner_nonce: randomBytes(16).toString('hex'),
        issued_at: new Date(issuedAtMs).toISOString(),
        spend_deadline_at: new Date(issuedAtMs + CAPABILITY_SPEND_WINDOW_MS).toISOString(),
        deadline_at: null,
        state: 'issued',
        consumed_at: null
      }, paths.key)
    ));
    await writePrivateJsonAtomic(paths.registry, {
      ...registry,
      active: [...registry.active, ...nextRecords]
    });
    return nextRecords;
  });

  return Object.freeze(prepared.map((entry, index) => {
    const capability = Object.freeze({ capability_id: entry.capabilityId });
    PRIVATE_CAPABILITIES.set(capability, Object.freeze({
      token: Buffer.from(entry.token),
      approvedRequest: entry.approvedRequest,
      record: records[index]
    }));
    return capability;
  }));
}

export async function issueEgressCapability(options) {
  exactKeys(options, ['root', 'dataDir', 'binding', 'approvedRequest'], 'capability issuance options');
  const [capability] = await issueEgressCapabilityBatch({
    root: options.root,
    dataDir: options.dataDir,
    entries: [{ binding: options.binding, approvedRequest: options.approvedRequest }]
  });
  return capability;
}

function capabilityAudit(record) {
  return Object.freeze({
    schema_version: '1',
    capability_id: record.capability_id,
    workspace_key: record.workspace_key,
    session_key: record.session_key,
    turn_key: record.turn_key,
    review_key: record.review_key,
    mode_revision: record.mode_revision,
    provider: record.provider,
    model: record.model,
    effort: record.effort,
    timeout_ms: record.timeout_ms,
    configuration_sha256: record.configuration_sha256,
    approval_sha256: record.approval_sha256,
    content_policy_version: record.content_policy_version,
    channel_inventory_sha256: record.channel_inventory_sha256,
    prompt_sha256: record.prompt_sha256,
    prompt_bytes: record.prompt_bytes,
    response_schema_sha256: record.response_schema_sha256,
    summary_consent_revision: record.summary_consent_revision,
    summary_sha256: record.summary_sha256,
    summary_packet_sha256: record.summary_packet_sha256,
    issued_at: record.issued_at,
    consumed_at: record.consumed_at,
    deadline_at: record.deadline_at
  });
}

function errorWithCapabilityAudit(error, audit, stage) {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    try {
      Object.defineProperties(error, {
        egressCapabilityAudit: {
          value: audit,
          enumerable: false,
          writable: false,
          configurable: false
        },
        egressCapabilityStage: {
          value: stage,
          enumerable: false,
          writable: false,
          configurable: false
        }
      });
      return error;
    } catch {
      // Frozen foreign errors are wrapped below while preserving safe provider metadata.
    }
  }
  const wrapped = new Error(`Buddy egress capability: ${stage} failed`, {
    cause: error instanceof Error ? error : undefined
  });
  for (const key of ['failureCode', 'run', 'provider', 'model']) {
    if (error && Object.hasOwn(error, key)) wrapped[key] = error[key];
  }
  Object.defineProperties(wrapped, {
    egressCapabilityAudit: { value: audit, enumerable: false },
    egressCapabilityStage: { value: stage, enumerable: false }
  });
  return wrapped;
}

function errorWithSettlementEvidence(executionError, settlementError, audit) {
  const primary = errorWithCapabilityAudit(executionError, audit, 'executor');
  const settlement = errorWithCapabilityAudit(settlementError, audit, 'settlement');
  try {
    Object.defineProperty(primary, 'egressCapabilitySettlementError', {
      value: settlement,
      enumerable: false,
      writable: false,
      configurable: false
    });
    return primary;
  } catch {
    const wrapped = new Error('Buddy egress capability: executor and settlement failed', {
      cause: primary
    });
    for (const key of ['failureCode', 'run', 'provider', 'model']) {
      if (Object.hasOwn(primary, key)) wrapped[key] = primary[key];
    }
    Object.defineProperties(wrapped, {
      egressCapabilityAudit: { value: audit, enumerable: false },
      egressCapabilityStage: { value: 'executor', enumerable: false },
      egressCapabilitySettlementError: { value: settlement, enumerable: false }
    });
    return wrapped;
  }
}

export async function spendEgressCapability(options, executor) {
  exactKeys(options, ['root', 'dataDir', 'capability'], 'capability spend options');
  const { root, dataDir, capability } = options;
  if (typeof executor !== 'function') throw new TypeError('egress executor must be a function');
  const privateState = PRIVATE_CAPABILITIES.get(capability);
  if (!privateState || capability?.capability_id !== privateState.record.capability_id) {
    fail('unknown or non-local capability');
  }
  const consumed = await withRegistry({ root, dataDir }, async (registry, paths) => {
    const index = registry.active.findIndex((record) => record.capability_id === capability.capability_id);
    if (index < 0) fail('capability is not active');
    const current = registry.active[index];
    if (current.state !== 'issued') fail('capability has already been consumed');
    if (!recordMatchesPrivate(current, privateState)) fail('capability binding does not match its private token');
    const consumedAtMs = Date.now();
    if (consumedAtMs > Date.parse(current.spend_deadline_at)) fail('capability spend deadline has elapsed');
    const nextRecord = validateRecord({
      ...current,
      state: 'consumed',
      consumed_at: new Date(consumedAtMs).toISOString(),
      deadline_at: new Date(
        consumedAtMs + current.timeout_ms + CAPABILITY_DEADLINE_GRACE_MS
      ).toISOString()
    }, paths.key);
    const active = [...registry.active];
    active[index] = nextRecord;
    await writePrivateJsonAtomic(paths.registry, { ...registry, active });
    return nextRecord;
  });
  const audit = capabilityAudit(consumed);
  let value;
  let executionError = null;
  try {
    const approval = inspectApprovedProviderReviewRequest(privateState.approvedRequest);
    if (approval.approvalSha256 !== consumed.approval_sha256
        || approval.policyVersion !== consumed.content_policy_version
        || approval.channelInventorySha256 !== consumed.channel_inventory_sha256
        || approval.promptSha256 !== consumed.prompt_sha256
        || approval.promptBytes !== consumed.prompt_bytes
        || approval.responseSchemaSha256 !== consumed.response_schema_sha256
        || approval.provider !== consumed.provider
        || approval.model !== consumed.model
        || approval.effort !== consumed.effort
        || approval.timeoutMs !== consumed.timeout_ms
        || approval.summaryPacketSha256 !== consumed.summary_packet_sha256) {
      fail('approved provider request changed before dispatch');
    }
    value = await executor(privateState.approvedRequest);
  } catch (error) {
    executionError = error;
  }
  let settlementError = null;
  try {
    await withRegistry({ root, dataDir }, async (registry, paths) => {
      const index = registry.active.findIndex((record) => record.capability_id === consumed.capability_id);
      if (index < 0) fail('consumed capability disappeared before positive settlement');
      if (canonicalJson(registry.active[index]) !== canonicalJson(consumed)) {
        fail('consumed capability binding changed before positive settlement');
      }
      const active = [...registry.active];
      active.splice(index, 1);
      await writePrivateJsonAtomic(paths.registry, { ...registry, active });
    });
  } catch (error) {
    settlementError = error;
  } finally {
    PRIVATE_CAPABILITIES.delete(capability);
  }
  if (executionError && settlementError) {
    throw errorWithSettlementEvidence(executionError, settlementError, audit);
  }
  if (settlementError) throw errorWithCapabilityAudit(settlementError, audit, 'settlement');
  if (executionError) throw errorWithCapabilityAudit(executionError, audit, 'executor');
  return Object.freeze({
    value,
    audit
  });
}

export async function snapshotActiveEgressCapabilities(options) {
  exactKeys(
    options,
    Object.hasOwn(options ?? {}, 'modeRevision')
      ? ['root', 'dataDir', 'modeRevision']
      : ['root', 'dataDir', 'summaryConsentRevision'],
    'egress snapshot options'
  );
  const { root, dataDir } = options;
  const hasModeRevision = Object.hasOwn(options, 'modeRevision');
  const hasSummaryRevision = Object.hasOwn(options, 'summaryConsentRevision');
  if (hasModeRevision === hasSummaryRevision) fail('snapshot requires exactly one revision selector');
  if (hasModeRevision
      && (!Number.isSafeInteger(options.modeRevision) || options.modeRevision < 0)) {
    fail('mode revision selector must be a non-negative safe integer');
  }
  if (hasSummaryRevision
      && (!Number.isSafeInteger(options.summaryConsentRevision) || options.summaryConsentRevision < 1)) {
    fail('summary consent revision selector must be a positive safe integer');
  }
  return withRegistry({ root, dataDir }, async (registry) => Object.freeze(
    registry.active
      .filter((record) => hasModeRevision
        ? record.mode_revision <= options.modeRevision
        : record.summary_consent_revision !== null
          && record.summary_consent_revision <= options.summaryConsentRevision)
      .map((record) => record.capability_id)
      .sort()
  ));
}

export async function drainEgressCapabilities(options) {
  exactKeys(
    options,
    Object.hasOwn(options ?? {}, 'timeoutMs')
      ? ['root', 'dataDir', 'capabilityIds', 'timeoutMs']
      : ['root', 'dataDir', 'capabilityIds'],
    'egress drain options'
  );
  const {
    root,
    dataDir,
    capabilityIds,
    timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS
  } = options;
  if (!Array.isArray(capabilityIds) || capabilityIds.some((id) => !CAPABILITY_ID_PATTERN.test(id))) {
    fail('drain requires valid capability ids');
  }
  if (new Set(capabilityIds).size !== capabilityIds.length) {
    fail('drain capability ids must be unique');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > DEFAULT_DRAIN_TIMEOUT_MS) {
    fail(`drain timeout must be an integer from 0 through ${DEFAULT_DRAIN_TIMEOUT_MS}`);
  }
  if (capabilityIds.length === 0) return Object.freeze({ drained: 0 });
  const wanted = new Set(capabilityIds);
  const started = performance.now();
  while (true) {
    const remaining = await withRegistry({ root, dataDir }, async (registry) => registry.active
      .filter((record) => wanted.has(record.capability_id))
      .map((record) => record.capability_id));
    if (remaining.length === 0) return Object.freeze({ drained: wanted.size });
    if (performance.now() - started >= timeoutMs) {
      fail(`drain timed out with ${remaining.length} unresolved capability record(s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function readEgressRegistry(options) {
  exactKeys(options, ['root', 'dataDir'], 'read egress registry options');
  const { root, dataDir } = options;
  return withRegistry({ root, dataDir }, async (registry) => Object.freeze({
    ...registry,
    active: Object.freeze(registry.active.map((record) => Object.freeze({ ...record })))
  }));
}
