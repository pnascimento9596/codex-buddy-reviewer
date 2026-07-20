import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from 'node:fs/promises';
import path from 'node:path';

import { inspectPetStateReadOnly, inspectPetTransactionsReadOnly, readPluginManifest } from './doctor.mjs';
import {
  changeMode,
  providerDefaultEffort,
  providerDefaultModel,
  readMode,
  resolveRepositoryRoot,
  reviewersForMode,
  validateReviewerConfiguration
} from './mode.mjs';
import {
  installPet,
  reconcilePetTransactions,
  removePet,
  restorePet,
  updatePet
} from './pet-catalog.mjs';
import {
  canonicalJson,
  acquireFileLease,
  ensurePrivateStatePath,
  releaseFileLease,
  resolveDataDir,
  withFileLock,
  writePrivateJsonExclusive
} from './state.mjs';
import { readStableRegularFile } from './stable-source-read.mjs';

const DEFAULT_PLAN_TTL_MS = 15 * 60_000;
const MAX_PLAN_TTL_MS = 24 * 60 * 60_000;
export const SETUP_TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
export const SETUP_PLAN_SCAN_LIMIT = 128;
const SETUP_PLAN_SCAN_DEADLINE_MS = 250;
const SETUP_PLAN_TREE_LIMIT = 32;
const SETUP_RECORD_MAX_BYTES = 1024 * 1024;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAN_ID_PATTERN = /^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUARANTINE_PLAN_PATTERN = /^\.quarantine-([0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCK_CLAIM_PATTERN = /^claim-[0-9]{12}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PLAN_FILES = Object.freeze({
  plan: '00-plan.json',
  apply_intent: '10-apply-intent.json',
  pet_applied: '20-pet-applied.json',
  mode_applied: '25-mode-applied.json',
  applied: '30-applied.json',
  rollback_intent: '40-rollback-intent.json',
  mode_rolled_back: '50-mode-rolled-back.json',
  pet_rolled_back: '60-pet-rolled-back.json',
  rolled_back: '70-rolled-back.json'
});
const PLAN_KIND_BY_FILE = new Map(
  Object.entries(PLAN_FILES).map(([kind, file]) => [file, kind])
);
const PLAN_RECORD_KEYS = Object.freeze(['kind', 'payload', 'plan_id', 'recorded_at', 'schema_version']);

function setupFailure(message) {
  throw new Error(`Buddy setup: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function canonicalExistingPath(requested) {
  const resolved = path.resolve(requested);
  let cursor = resolved;
  const missingSegments = [];
  while (true) {
    try {
      return path.join(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function detailsOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function setupRoot(dataDir) {
  return path.join(resolveDataDir(dataDir), 'setup');
}

function setupPlansRoot(dataDir) {
  return path.join(setupRoot(dataDir), 'plans');
}

function setupIndexLockTarget(dataDir) {
  return path.join(setupRoot(dataDir), 'plans-index');
}

function planDirectory(dataDir, planId) {
  if (typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId)) setupFailure('invalid plan id');
  return path.join(setupPlansRoot(dataDir), planId);
}

function planFile(dataDir, planId, kind) {
  if (!PLAN_FILES[kind]) setupFailure(`unknown plan record ${String(kind)}`);
  return path.join(planDirectory(dataDir, planId), PLAN_FILES[kind]);
}

function exactMode(details, expected) {
  return (Number(details.mode) & 0o777) === expected;
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function ownedByCurrentUser(details, uid = currentUid()) {
  return uid === null || Number(details.uid) === uid;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return milliseconds;
}

function containsNeedsAttention(value, seen = new Set()) {
  if (value === 'needs_attention') return true;
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsNeedsAttention(item, seen));
  return Object.entries(value).some(
    ([key, item]) => key === 'needs_attention' || containsNeedsAttention(item, seen)
  );
}

function emptyPruneSummary(workspaceRoot, overrides = {}) {
  return Object.freeze({
    workspace_root: workspaceRoot,
    scanned: 0,
    removed: 0,
    preserved: 0,
    refused: 0,
    limited: false,
    ...overrides
  });
}

async function privateSetupPlansRootDetails(dataDir, { optional = false } = {}) {
  const dataRoot = path.resolve(resolveDataDir(dataDir));
  const components = [
    [dataRoot, 'configured data root'],
    [path.join(dataRoot, 'setup'), 'setup state root'],
    [path.join(dataRoot, 'setup', 'plans'), 'setup plans root']
  ];
  let plansDetails = null;
  for (const [directory, label] of components) {
    const details = await detailsOrNull(directory);
    if (!details) {
      if (optional) return null;
      setupFailure(`${label} does not exist`);
    }
    if (!details.isDirectory() || details.isSymbolicLink() || !ownedByCurrentUser(details)
        || (process.platform !== 'win32' && !exactMode(details, 0o700))) {
      setupFailure(`${label} must be a private owned non-symlink directory`);
    }
    plansDetails = details;
  }
  return plansDetails;
}

async function cleanupRecord(directory, planId, kind) {
  const file = path.join(directory, PLAN_FILES[kind]);
  const details = await detailsOrNull(file);
  if (!details) return { status: 'absent', record: null };
  if (!details.isFile() || details.isSymbolicLink() || !ownedByCurrentUser(details)
      || details.size < 2 || details.size > SETUP_RECORD_MAX_BYTES
      || (process.platform !== 'win32' && !exactMode(details, 0o600))) {
    return { status: 'invalid', record: null };
  }
  const source = await readStableRegularFile(file, { maxBytes: SETUP_RECORD_MAX_BYTES });
  if (source.status !== 'complete') return { status: 'invalid', record: null };
  let record;
  try {
    record = JSON.parse(source.bytes.toString('utf8'));
  } catch {
    return { status: 'invalid', record: null };
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)
      || !Object.keys(record).sort().every((key, index, keys) => (
        keys.length === PLAN_RECORD_KEYS.length && key === PLAN_RECORD_KEYS[index]
      ))
      || record.schema_version !== '1' || record.plan_id !== planId || record.kind !== kind
      || canonicalIsoTimestamp(record.recorded_at) === null
      || record.payload === null || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
    return { status: 'invalid', record: null };
  }
  return { status: 'valid', record };
}

async function inspectPlanTree(directory, ownLeaseFile = null, allowQuarantineClaims = false) {
  let count = 0;
  const names = await readdir(directory);
  for (const name of names) {
    count += 1;
    if (count > SETUP_PLAN_TREE_LIMIT) return false;
    const target = path.join(directory, name);
    const details = await detailsOrNull(target);
    if (!details || details.isSymbolicLink() || !ownedByCurrentUser(details)) return false;
    if (PLAN_KIND_BY_FILE.has(name)) {
      if (!details.isFile() || (process.platform !== 'win32' && !exactMode(details, 0o600))) return false;
      continue;
    }
    if (name !== `${PLAN_FILES.plan}.lock` || !details.isDirectory()
        || (process.platform !== 'win32' && !exactMode(details, 0o700))) {
      return false;
    }
    const claims = await readdir(target);
    count += claims.length;
    if (count > SETUP_PLAN_TREE_LIMIT) return false;
    for (const claimName of claims) {
      const claimFile = path.join(target, claimName);
      const isOwnLease = ownLeaseFile !== null && claimFile === ownLeaseFile;
      if (!isOwnLease && !(allowQuarantineClaims && LOCK_CLAIM_PATTERN.test(claimName))) return false;
      const claim = await detailsOrNull(claimFile);
      if (!claim || !claim.isFile() || claim.isSymbolicLink() || !ownedByCurrentUser(claim)
          || (process.platform !== 'win32' && !exactMode(claim, 0o600))) {
        return false;
      }
    }
  }
  return true;
}

function recordSetEquals(records, kinds) {
  if (records.size !== kinds.length) return false;
  return kinds.every((kind) => records.has(kind));
}

function terminalRecord(records) {
  const appliedKinds = ['plan', 'apply_intent', 'pet_applied', 'mode_applied', 'applied'];
  if (recordSetEquals(records, appliedKinds)) {
    return records.get('applied')?.payload?.outcome === 'applied' ? records.get('applied') : null;
  }
  if (recordSetEquals(records, ['plan', 'rolled_back'])) {
    return records.get('rolled_back')?.payload?.outcome === 'rolled_back'
      ? records.get('rolled_back')
      : null;
  }
  const requiredRollback = [
    'plan',
    'apply_intent',
    'rollback_intent',
    'mode_rolled_back',
    'pet_rolled_back',
    'rolled_back'
  ];
  const allowedRollback = new Set([...requiredRollback, 'pet_applied', 'mode_applied', 'applied']);
  if (requiredRollback.every((kind) => records.has(kind))
      && [...records.keys()].every((kind) => allowedRollback.has(kind))
      && records.get('rolled_back')?.payload?.outcome === 'rolled_back') {
    return records.get('rolled_back');
  }
  return null;
}

async function classifyPlanDirectory({
  directory,
  planId,
  workspaceRoot,
  nowMs,
  ownLeaseFile = null,
  quarantined = false
}) {
  const directoryDetails = await detailsOrNull(directory);
  if (!directoryDetails || !directoryDetails.isDirectory() || directoryDetails.isSymbolicLink()
      || !ownedByCurrentUser(directoryDetails)
      || (process.platform !== 'win32' && !exactMode(directoryDetails, 0o700))) {
    return { action: 'refused', identity: null };
  }
  if (!await inspectPlanTree(directory, ownLeaseFile, quarantined)) {
    return { action: 'refused', identity: directoryDetails };
  }

  const records = new Map();
  for (const kind of Object.keys(PLAN_FILES)) {
    const result = await cleanupRecord(directory, planId, kind);
    if (result.status === 'invalid') return { action: 'refused', identity: directoryDetails };
    if (result.status === 'valid') records.set(kind, result.record);
  }
  const planRecord = records.get('plan');
  if (!planRecord) return { action: 'refused', identity: directoryDetails };
  let plan;
  try {
    plan = validateStoredPlan(planRecord);
  } catch {
    return { action: 'refused', identity: directoryDetails };
  }
  if (plan.workspace_root !== workspaceRoot || containsNeedsAttention([...records.values()])) {
    return { action: 'preserved', identity: directoryDetails };
  }
  for (const [kind, record] of records) {
    if (kind !== 'plan' && record.payload.plan_digest !== plan.plan_digest) {
      return { action: 'refused', identity: directoryDetails };
    }
  }

  if (records.size === 1) {
    const expiresAt = canonicalIsoTimestamp(plan.expires_at);
    if (expiresAt === null) return { action: 'refused', identity: directoryDetails };
    return {
      action: nowMs > expiresAt ? 'remove' : 'preserved',
      identity: directoryDetails
    };
  }

  const terminal = terminalRecord(records);
  if (!terminal) return { action: 'preserved', identity: directoryDetails };
  const terminalAt = canonicalIsoTimestamp(terminal.recorded_at);
  if (terminalAt === null || terminalAt > nowMs) {
    return { action: 'refused', identity: directoryDetails };
  }
  return {
    action: nowMs - terminalAt >= SETUP_TERMINAL_RETENTION_MS ? 'remove' : 'preserved',
    identity: directoryDetails
  };
}

async function removeQuarantinedDirectory({ directory, expectedIdentity, removeImpl }) {
  const moved = await detailsOrNull(directory);
  if (!moved || !moved.isDirectory() || moved.isSymbolicLink()
      || !sameIdentity(moved, expectedIdentity) || !ownedByCurrentUser(moved)
      || (process.platform !== 'win32' && !exactMode(moved, 0o700))
      || !await inspectPlanTree(directory, null, true)) {
    return false;
  }
  try {
    await removeImpl(directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
    return true;
  } catch {
    return false;
  }
}

async function sweepSetupPlansLocked({
  dataDir,
  workspaceRoot,
  excludePlanId,
  nowMs,
  scanLimit,
  deadlineMs,
  randomUUIDImpl,
  renameImpl,
  removeImpl
}) {
  const plansRoot = path.resolve(setupPlansRoot(dataDir));
  const rootDetails = await privateSetupPlansRootDetails(dataDir, { optional: true });
  if (!rootDetails) return emptyPruneSummary(workspaceRoot);
  const startedAt = Date.now();
  const summary = { scanned: 0, removed: 0, preserved: 0, refused: 0, limited: false };
  const directory = await opendir(plansRoot);
  try {
    for await (const entry of directory) {
      if (summary.scanned >= scanLimit || Date.now() - startedAt >= deadlineMs) {
        summary.limited = true;
        break;
      }
      summary.scanned += 1;
      const quarantineMatch = QUARANTINE_PLAN_PATTERN.exec(entry.name);
      const planId = quarantineMatch?.[1] ?? (PLAN_ID_PATTERN.test(entry.name) ? entry.name : null);
      if (!planId || planId === excludePlanId) {
        summary.refused += 1;
        continue;
      }
      const candidate = path.join(plansRoot, entry.name);
      const classified = await classifyPlanDirectory({
        directory: candidate,
        planId,
        workspaceRoot,
        nowMs,
        quarantined: quarantineMatch !== null
      });
      if (classified.action !== 'remove') {
        summary[classified.action] += 1;
        continue;
      }
      if (quarantineMatch) {
        const removed = await removeQuarantinedDirectory({
          directory: candidate,
          expectedIdentity: classified.identity,
          removeImpl
        });
        summary[removed ? 'removed' : 'preserved'] += 1;
        continue;
      }

      const lease = await acquireFileLease(path.join(candidate, PLAN_FILES.plan), { wait: false });
      if (!lease) {
        summary.preserved += 1;
        continue;
      }
      let renamed = false;
      try {
        const rechecked = await classifyPlanDirectory({
          directory: candidate,
          planId,
          workspaceRoot,
          nowMs,
          ownLeaseFile: lease.file
        });
        if (rechecked.action !== 'remove' || !sameIdentity(classified.identity, rechecked.identity)) {
          summary[rechecked.action === 'remove' ? 'refused' : rechecked.action] += 1;
          continue;
        }
        const plansRootAfter = await privateSetupPlansRootDetails(dataDir);
        if (!sameIdentity(rootDetails, plansRootAfter)) {
          summary.refused += 1;
          continue;
        }
        const quarantineId = randomUUIDImpl();
        if (typeof quarantineId !== 'string' || !UUID_V4_PATTERN.test(quarantineId)) {
          summary.refused += 1;
          continue;
        }
        const quarantine = path.join(plansRoot, `.quarantine-${planId}-${quarantineId}`);
        if (await detailsOrNull(quarantine)) {
          summary.refused += 1;
          continue;
        }
        await renameImpl(candidate, quarantine);
        renamed = true;
        const movedLease = path.join(quarantine, path.relative(candidate, lease.file));
        await rm(movedLease, { force: true }).catch(() => {});
        const removed = await removeQuarantinedDirectory({
          directory: quarantine,
          expectedIdentity: rechecked.identity,
          removeImpl
        });
        summary[removed ? 'removed' : 'preserved'] += 1;
      } catch {
        summary[renamed ? 'preserved' : 'refused'] += 1;
      } finally {
        if (!renamed) await releaseFileLease(lease);
      }
    }
  } finally {
    await directory.close().catch(() => {});
  }
  const plansRootAfter = await privateSetupPlansRootDetails(dataDir);
  if (!sameIdentity(rootDetails, plansRootAfter)) setupFailure('setup plans root changed during cleanup');
  return emptyPruneSummary(workspaceRoot, summary);
}

export async function pruneSetupPlansForWorkspace({
  root,
  cwd,
  resolveRoot,
  dataDir,
  nowMs = Date.now(),
  scanLimit = SETUP_PLAN_SCAN_LIMIT,
  deadlineMs = SETUP_PLAN_SCAN_DEADLINE_MS,
  excludePlanId,
  randomUUIDImpl = randomUUID,
  renameImpl = rename,
  removeImpl = rm
} = {}) {
  if (!Number.isFinite(nowMs)) setupFailure('cleanup time must be finite');
  if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > SETUP_PLAN_SCAN_LIMIT) {
    setupFailure(`cleanup scan limit must be between 1 and ${SETUP_PLAN_SCAN_LIMIT}`);
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > SETUP_PLAN_SCAN_DEADLINE_MS) {
    setupFailure(`cleanup deadline must be between 1 and ${SETUP_PLAN_SCAN_DEADLINE_MS} milliseconds`);
  }
  if (excludePlanId !== undefined && !PLAN_ID_PATTERN.test(excludePlanId)) setupFailure('invalid excluded plan id');
  for (const [label, implementation] of Object.entries({ randomUUIDImpl, renameImpl, removeImpl })) {
    if (typeof implementation !== 'function') setupFailure(`${label} must be callable`);
  }
  const workspaceRoot = await resolveWorkspace({ root, cwd, resolveRoot });
  const plans = await privateSetupPlansRootDetails(dataDir, { optional: true });
  if (!plans) return emptyPruneSummary(workspaceRoot);
  return withFileLock(setupIndexLockTarget(dataDir), () => sweepSetupPlansLocked({
    dataDir,
    workspaceRoot,
    excludePlanId,
    nowMs,
    scanLimit,
    deadlineMs,
    randomUUIDImpl,
    renameImpl,
    removeImpl
  }));
}

async function withLoadedSetupPlanLock(options, callback) {
  const indexLease = await acquireFileLease(setupIndexLockTarget(options.dataDir));
  let planLease = null;
  let plan;
  try {
    plan = await loadPlan(options);
    planLease = await acquireFileLease(planFile(options.dataDir, plan.plan_id, 'plan'));
  } finally {
    await releaseFileLease(indexLease);
  }
  try {
    await pruneSetupPlansForWorkspace({
      root: options.root,
      cwd: options.cwd,
      resolveRoot: options.resolveRoot,
      dataDir: options.dataDir,
      nowMs: options.nowMs ?? Date.now(),
      excludePlanId: plan.plan_id
    });
    return await callback(plan);
  } finally {
    await releaseFileLease(planLease);
  }
}

async function readRegularJson(file, label) {
  const details = await detailsOrNull(file);
  if (!details) return null;
  if (details.isSymbolicLink() || !details.isFile()) setupFailure(`${label} must be a regular non-symlink file`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) setupFailure(`${label} is not valid JSON`);
    throw error;
  }
}

async function writeImmutablePlanRecord(dataDir, planId, kind, payload) {
  const root = setupRoot(dataDir);
  const directory = planDirectory(dataDir, planId);
  await ensurePrivateStatePath(root, directory);
  const file = planFile(dataDir, planId, kind);
  const record = {
    schema_version: '1',
    plan_id: planId,
    kind,
    recorded_at: new Date().toISOString(),
    payload
  };
  const written = await writePrivateJsonExclusive(file, record);
  if (written) return record;
  const existing = await readRegularJson(file, `${kind} record`);
  if (existing?.schema_version !== '1' || existing.plan_id !== planId || existing.kind !== kind
      || canonicalJson(existing.payload) !== canonicalJson(payload)) {
    setupFailure(`${kind} record is immutable and already contains different data`);
  }
  return existing;
}

async function readPlanRecord(dataDir, planId, kind) {
  const record = await readRegularJson(planFile(dataDir, planId, kind), `${kind} record`);
  if (record === null) return null;
  if (record.schema_version !== '1' || record.plan_id !== planId || record.kind !== kind
      || !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
    setupFailure(`${kind} record has an unsupported shape`);
  }
  return record;
}

function planDigest(planWithoutDigest) {
  // Hash the exact JSON shape that is persisted. JavaScript objects can retain
  // `undefined` properties that JSON serialization drops; normalizing first
  // keeps a freshly-created plan and its on-disk representation digest-identical.
  return sha256(canonicalJson(cloneJson(planWithoutDigest)));
}

function validateStoredPlan(record, suppliedDigest) {
  const plan = record?.payload;
  if (!plan || plan.schema_version !== '1' || plan.plan_id !== record.plan_id
      || !DIGEST_PATTERN.test(plan.plan_digest)) {
    setupFailure('stored plan has an unsupported shape');
  }
  const { plan_digest: storedDigest, ...body } = plan;
  if (planDigest(body) !== storedDigest) setupFailure('stored plan digest does not match its immutable body');
  if (suppliedDigest !== undefined && suppliedDigest !== storedDigest) setupFailure('supplied plan digest does not match');
  try {
    validateReviewerConfiguration(plan.mode_before, { allowLegacyTimeout: true });
    reviewersForMode(plan.mode_before);
    validateReviewerConfiguration(plan.desired_mode);
    reviewersForMode(plan.desired_mode);
  } catch (error) {
    setupFailure(`stored plan reviewer configuration is invalid: ${error.message}`);
  }
  return plan;
}

async function resolveWorkspace(options) {
  const resolved = await (options.resolveRoot ?? resolveRepositoryRoot)(
    options.root ?? options.cwd ?? process.cwd()
  );
  return canonicalExistingPath(resolved);
}

function modeComparable(mode) {
  return {
    workspace_root: mode.workspace_root,
    config_revision: mode.config_revision,
    enabled: mode.enabled,
    provider: mode.provider,
    model: mode.model,
    effort: mode.effort,
    secondary_provider: mode.secondary_provider,
    secondary_model: mode.secondary_model,
    secondary_effort: mode.secondary_effort,
    min_confidence: mode.min_confidence,
    max_patch_bytes: mode.max_patch_bytes,
    timeout_ms: mode.timeout_ms
  };
}

function packageComparable(value) {
  if (value === null) return null;
  return {
    exists: value.exists,
    safe: value.safe,
    manifest_sha256: value.manifest_sha256,
    spritesheet_sha256: value.spritesheet_sha256
  };
}

function ownedComparable(value) {
  if (value === null) return null;
  return {
    id: value.id,
    scope: value.scope,
    target: value.target,
    manifest_sha256: value.manifest_sha256,
    spritesheet_sha256: value.spritesheet_sha256
  };
}

function observedPetSnapshot(state) {
  const pet = state.pets[0];
  return {
    codex_home: state.codex_home,
    id: pet.id,
    scope: pet.scope,
    target: pet.target,
    status: pet.status,
    catalog_current: pet.catalog_current,
    current: packageComparable(pet.current),
    owned: ownedComparable(pet.owned)
  };
}

function fullPetSnapshot(state) {
  return {
    ...observedPetSnapshot(state),
    catalog_file: state.catalog_file,
    desired: state.pets[0].desired
  };
}

function observedPetBefore(plan) {
  const { catalog_file: _catalogFile, desired: _desired, ...observed } = plan.pet_before;
  return observed;
}

function backupComparable(record) {
  return {
    backup_id: record.backup_id,
    id: record.id,
    scope: record.scope,
    path: record.path,
    original_target: record.original_target,
    manifest_sha256: record.manifest_sha256,
    spritesheet_sha256: record.spritesheet_sha256
  };
}

function expectedPetAfter(state, choice) {
  const before = observedPetSnapshot(state);
  if (!['install', 'update'].includes(choice.action)) return before;
  const desired = state.pets[0].desired;
  return {
    ...before,
    status: 'owned',
    catalog_current: true,
    current: {
      exists: true,
      safe: true,
      manifest_sha256: desired.manifest_sha256,
      spritesheet_sha256: desired.spritesheet_sha256
    },
    owned: {
      id: before.id,
      scope: before.scope,
      target: before.target,
      manifest_sha256: desired.manifest_sha256,
      spritesheet_sha256: desired.spritesheet_sha256
    }
  };
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sortedBackups(records) {
  return records.map(backupComparable).sort((left, right) => left.backup_id.localeCompare(right.backup_id));
}

function assertUnchangedPriorBackups(plan, petState) {
  const beforeById = new Map(plan.pet_backups_before.map((record) => [record.backup_id, record]));
  const current = sortedBackups(petState.backups);
  for (const expected of beforeById.values()) {
    const actual = current.find((record) => record.backup_id === expected.backup_id);
    if (!actual || !sameJson(actual, expected)) {
      setupFailure(`pet backup ${expected.backup_id} changed during setup`);
    }
  }
  return current.filter((record) => !beforeById.has(record.backup_id));
}

function matchingBackup(record, expectedPackage, plan) {
  return record.id === plan.pet_id
    && record.scope === plan.pet_before.scope
    && record.original_target === plan.pet_before.target
    && record.manifest_sha256 === expectedPackage.manifest_sha256
    && record.spritesheet_sha256 === expectedPackage.spritesheet_sha256;
}

function recoverAppliedPetResult(plan, petState, actualResult = null) {
  const step = plan.steps.find((item) => item.kind === 'pet');
  const additions = assertUnchangedPriorBackups(plan, petState);
  if (step.action === 'update') {
    const candidates = additions.filter((record) => matchingBackup(record, plan.pet_before.current, plan));
    if (additions.length !== 1 || candidates.length !== 1) {
      setupFailure('updated pet rollback backup is missing or ambiguous');
    }
    const backup = candidates[0];
    if (actualResult?.backupId !== undefined && actualResult.backupId !== backup.backup_id) {
      setupFailure('updated pet returned a different rollback backup than the registry');
    }
    return actualResult ?? {
      action: 'updated',
      id: plan.pet_id,
      target: plan.pet_before.target,
      scope: plan.pet_before.scope,
      backupId: backup.backup_id,
      backup: backup.path
    };
  }
  if (additions.length !== 0) setupFailure('pet backups changed unexpectedly during setup');
  if (step.action === 'install') {
    if (actualResult && actualResult.action !== 'installed') {
      setupFailure('pet appeared concurrently during installation; refusing to claim it as setup-owned');
    }
    return actualResult ?? {
      action: 'installed',
      id: plan.pet_id,
      target: plan.pet_before.target,
      scope: plan.pet_before.scope
    };
  }
  return actualResult ?? { action: step.action, id: plan.pet_id, preexisting: step.preexisting };
}

function choosePetAction(pet) {
  if (pet.status === 'unsafe' || pet.status === 'modified') {
    setupFailure(`refusing setup because ${pet.id} is ${pet.status}`);
  }
  if (pet.status === 'unowned') {
    if (!pet.catalog_current) setupFailure(`refusing setup because unowned ${pet.id} differs from the catalog`);
    return { action: 'none_preexisting', preexisting: true };
  }
  if (pet.status === 'missing') {
    setupFailure(`refusing setup because owned ${pet.id} is missing; reconcile it explicitly first`);
  }
  if (pet.status === 'not_installed') return { action: 'install', preexisting: false };
  if (pet.status === 'owned' && !pet.catalog_current) return { action: 'update', preexisting: true };
  return { action: 'none', preexisting: true };
}

function desiredMode(mode, options) {
  const secondaryOverrides = [
    options.secondaryProvider,
    options.secondaryModel,
    options.secondaryEffort
  ];
  if (secondaryOverrides.some((value) => value === null)) {
    setupFailure('use singleReviewer to clear the secondary reviewer connection');
  }
  if (options.singleReviewer === true
      && secondaryOverrides.some((value) => value !== undefined)) {
    setupFailure('cannot configure and clear the secondary reviewer in one plan');
  }
  const provider = options.provider ?? mode.provider;
  const providerChanged = provider !== mode.provider;
  let secondaryProvider = mode.secondary_provider;
  let secondaryModel = mode.secondary_model;
  let secondaryEffort = mode.secondary_effort;
  if (options.singleReviewer === true) {
    secondaryProvider = null;
    secondaryModel = null;
    secondaryEffort = null;
  } else {
    const secondaryProviderChanged = options.secondaryProvider !== undefined
      && options.secondaryProvider !== mode.secondary_provider;
    secondaryProvider = options.secondaryProvider ?? mode.secondary_provider;
    secondaryModel = options.secondaryModel
      ?? (secondaryProviderChanged ? providerDefaultModel(secondaryProvider) : mode.secondary_model);
    secondaryEffort = options.secondaryEffort
      ?? (secondaryProviderChanged ? providerDefaultEffort(secondaryProvider) : mode.secondary_effort);
  }
  const desired = validateReviewerConfiguration({
    enabled: true,
    provider,
    model: options.model ?? (providerChanged ? providerDefaultModel(provider) : mode.model),
    effort: options.effort ?? mode.effort,
    secondary_provider: secondaryProvider,
    secondary_model: secondaryModel,
    secondary_effort: secondaryEffort,
    min_confidence: options.minConfidence ?? mode.min_confidence,
    max_patch_bytes: options.maxPatchBytes ?? mode.max_patch_bytes,
    timeout_ms: options.timeoutMs ?? mode.timeout_ms
  });
  reviewersForMode(desired);
  return desired;
}

function modeRequiresChange(mode, desired) {
  return !desired.enabled || !mode.enabled
    || mode.provider !== desired.provider
    || mode.model !== desired.model
    || mode.effort !== desired.effort
    || mode.secondary_provider !== desired.secondary_provider
    || mode.secondary_model !== desired.secondary_model
    || mode.secondary_effort !== desired.secondary_effort
    || mode.min_confidence !== desired.min_confidence
    || mode.max_patch_bytes !== desired.max_patch_bytes
    || mode.timeout_ms !== desired.timeout_ms;
}

function assertNoUnresolvedTransactions(transactionState) {
  const unresolved = transactionState.transactions.find(
    (transaction) => ['pending', 'needs_attention'].includes(transaction.status)
  );
  if (unresolved) setupFailure(`pet transaction ${unresolved.id ?? 'unknown'} is ${unresolved.status}`);
}

export async function createSetupPlan(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_PLAN_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_PLAN_TTL_MS) {
    setupFailure(`plan TTL must be between 1 and ${MAX_PLAN_TTL_MS} milliseconds`);
  }
  const workspaceRoot = await resolveWorkspace(options);
  const plugin = await readPluginManifest(options);
  const petId = options.petId ?? 'buddy-byte';
  const petState = await inspectPetStateReadOnly({
    petId,
    catalogFile: options.catalogFile,
    codexHome: options.codexHome,
    dataDir: options.dataDir
  });
  const transactionState = await inspectPetTransactionsReadOnly({
    codexHome: petState.codex_home,
    dataDir: options.dataDir
  });
  assertNoUnresolvedTransactions(transactionState);
  const mode = await readMode({ root: workspaceRoot, dataDir: options.dataDir });
  const petChoice = choosePetAction(petState.pets[0]);
  const desired = desiredMode(mode, options);
  const modeAction = modeRequiresChange(mode, desired) ? 'enable' : 'none';
  const planId = options.planId ?? `${nowMs}-${randomUUID()}`;
  if (!PLAN_ID_PATTERN.test(planId)) setupFailure('invalid generated plan id');
  const body = {
    schema_version: '1',
    plan_id: planId,
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttlMs).toISOString(),
    workspace_root: workspaceRoot,
    codex_home: petState.codex_home,
    plugin_root: plugin.plugin_root,
    plugin_version: plugin.manifest.version,
    catalog_file: petState.catalog_file,
    pet_id: petId,
    pet_before: fullPetSnapshot(petState),
    pet_backups_before: petState.backups.map(backupComparable),
    pet_expected_after: expectedPetAfter(petState, petChoice),
    mode_before: modeComparable(mode),
    desired_mode: desired,
    desired_presentation: {
      pet_id: petId,
      selection: 'manual_host'
    },
    steps: [
      { order: 10, kind: 'pet', action: petChoice.action, preexisting: petChoice.preexisting },
      { order: 20, kind: 'review', action: modeAction }
    ],
    manual_host_steps: [
      'Review and approve Codex hook trust.',
      'Confirm Buddy Review appears in the command menu.',
      'Select the pet in Settings, refresh if needed, and run /pet once to wake it.'
    ]
  };
  const plan = { ...body, plan_digest: planDigest(body) };
  await withFileLock(setupIndexLockTarget(options.dataDir), async () => {
    await sweepSetupPlansLocked({
      dataDir: options.dataDir,
      workspaceRoot,
      excludePlanId: planId,
      nowMs,
      scanLimit: SETUP_PLAN_SCAN_LIMIT,
      deadlineMs: SETUP_PLAN_SCAN_DEADLINE_MS,
      randomUUIDImpl: randomUUID,
      renameImpl: rename,
      removeImpl: rm
    });
    await writeImmutablePlanRecord(options.dataDir, planId, 'plan', plan);
  });
  return cloneJson(plan);
}

async function loadPlan(options) {
  if (!DIGEST_PATTERN.test(options.planDigest ?? '')) setupFailure('a valid plan digest is required');
  const record = await readPlanRecord(options.dataDir, options.planId, 'plan');
  if (!record) setupFailure(`plan ${options.planId} does not exist`);
  return validateStoredPlan(record, options.planDigest);
}

async function currentPlanContext(plan, options) {
  const workspaceRoot = await resolveWorkspace(options);
  const plugin = await readPluginManifest({ ...options, pluginRoot: options.pluginRoot ?? plan.plugin_root });
  const petState = await inspectPetStateReadOnly({
    petId: plan.pet_id,
    catalogFile: options.catalogFile ?? plan.catalog_file,
    codexHome: options.codexHome ?? plan.codex_home,
    dataDir: options.dataDir
  });
  const mode = await readMode({ root: workspaceRoot, dataDir: options.dataDir });
  const transactions = await inspectPetTransactionsReadOnly({
    codexHome: petState.codex_home,
    dataDir: options.dataDir
  });
  return { workspaceRoot, plugin, petState, mode, transactions };
}

function assertFreshPlan(plan, context) {
  if (context.workspaceRoot !== plan.workspace_root) setupFailure('plan is stale because the workspace changed');
  if (context.petState.codex_home !== plan.codex_home) setupFailure('plan is stale because the Codex home changed');
  if (context.plugin.plugin_root !== plan.plugin_root || context.plugin.manifest.version !== plan.plugin_version) {
    setupFailure('plan is stale because the plugin version or root changed');
  }
  if (!sameJson(fullPetSnapshot(context.petState), plan.pet_before)) {
    setupFailure('plan is stale because pet hashes or ownership changed');
  }
  if (!sameJson(sortedBackups(context.petState.backups), sortedBackups(plan.pet_backups_before))) {
    setupFailure('plan is stale because pet backups changed');
  }
  if (!sameJson(modeComparable(context.mode), plan.mode_before)) {
    setupFailure('plan is stale because the mode revision changed');
  }
  assertNoUnresolvedTransactions(context.transactions);
}

function assertStaticPlanContext(plan, context) {
  if (context.workspaceRoot !== plan.workspace_root) setupFailure('plan is stale because the workspace changed');
  if (context.petState.codex_home !== plan.codex_home) setupFailure('plan is stale because the Codex home changed');
  if (context.plugin.plugin_root !== plan.plugin_root || context.plugin.manifest.version !== plan.plugin_version) {
    setupFailure('plan is stale because the plugin version or root changed');
  }
  assertNoUnresolvedTransactions(context.transactions);
}

function expectedModeAfter(plan) {
  const step = plan.steps.find((item) => item.kind === 'review');
  if (step.action === 'none') return plan.mode_before;
  return {
    workspace_root: plan.mode_before.workspace_root,
    config_revision: plan.mode_before.config_revision + 1,
    ...plan.desired_mode
  };
}

function expectedModeAfterRollback(plan) {
  const step = plan.steps.find((item) => item.kind === 'review');
  if (step.action === 'none') return plan.mode_before;
  return {
    ...plan.mode_before,
    config_revision: expectedModeAfter(plan).config_revision + 1
  };
}

function petOptions(plan, options) {
  return {
    catalogFile: options.catalogFile ?? plan.catalog_file,
    codexHome: options.codexHome ?? plan.codex_home,
    dataDir: options.dataDir
  };
}

async function applyPetStep(plan, options) {
  const step = plan.steps.find((item) => item.kind === 'pet');
  if (step.action === 'install') return installPet(plan.pet_id, petOptions(plan, options));
  if (step.action === 'update') return updatePet(plan.pet_id, petOptions(plan, options));
  return { action: step.action, id: plan.pet_id, preexisting: step.preexisting };
}

async function applyModeStep(plan, options) {
  const step = plan.steps.find((item) => item.kind === 'review');
  if (step.action === 'none') return readMode({ root: plan.workspace_root, dataDir: options.dataDir });
  return changeMode({
    root: plan.workspace_root,
    dataDir: options.dataDir,
    action: 'enable',
    provider: plan.desired_mode.provider,
    model: plan.desired_mode.model,
    effort: plan.desired_mode.effort,
    secondaryProvider: plan.desired_mode.secondary_provider ?? undefined,
    secondaryModel: plan.desired_mode.secondary_model ?? undefined,
    secondaryEffort: plan.desired_mode.secondary_effort ?? undefined,
    singleReviewer: plan.desired_mode.secondary_provider === null,
    minConfidence: plan.desired_mode.min_confidence,
    maxPatchBytes: plan.desired_mode.max_patch_bytes,
    timeoutMs: plan.desired_mode.timeout_ms,
    expectedRevision: plan.mode_before.config_revision
  });
}

export async function applySetupPlan(options = {}) {
  return withLoadedSetupPlanLock(options, async (plan) => {
    const rolledBack = await readPlanRecord(options.dataDir, plan.plan_id, 'rolled_back');
    if (rolledBack) setupFailure('plan has already been rolled back');
    const rollbackIntent = await readPlanRecord(options.dataDir, plan.plan_id, 'rollback_intent');
    if (rollbackIntent) setupFailure('plan rollback has already started');
    const applied = await readPlanRecord(options.dataDir, plan.plan_id, 'applied');
    if (applied) return { plan, ...cloneJson(applied.payload), idempotent: true };
    let applyIntent = await readPlanRecord(options.dataDir, plan.plan_id, 'apply_intent');
    let context;
    if (!applyIntent) {
      const nowMs = options.nowMs ?? Date.now();
      if (!Number.isFinite(Date.parse(plan.expires_at)) || nowMs > Date.parse(plan.expires_at)) {
        setupFailure('plan has expired; create a fresh plan');
      }
      context = await currentPlanContext(plan, options);
      assertFreshPlan(plan, context);
      applyIntent = await writeImmutablePlanRecord(options.dataDir, plan.plan_id, 'apply_intent', {
        plan_digest: plan.plan_digest,
        pet_before: observedPetBefore(plan),
        pet_expected_after: plan.pet_expected_after,
        mode_before: plan.mode_before,
        mode_expected_after: expectedModeAfter(plan)
      });
    } else {
      await reconcilePetTransactions(petOptions(plan, options));
      context = await currentPlanContext(plan, options);
      assertStaticPlanContext(plan, context);
    }

    let petApplied = await readPlanRecord(options.dataDir, plan.plan_id, 'pet_applied');
    if (!petApplied) {
      const before = observedPetSnapshot(context.petState);
      let actualResult = null;
      let mutated = false;
      if (sameJson(before, observedPetBefore(plan))) {
        actualResult = await applyPetStep(plan, options);
        mutated = !['none', 'none_preexisting'].includes(
          plan.steps.find((item) => item.kind === 'pet').action
        );
        if (mutated) await options.afterPetMutation?.({ plan: cloneJson(plan), result: cloneJson(actualResult) });
      } else if (!sameJson(before, plan.pet_expected_after)) {
        setupFailure('prior apply attempt left an unexpected pet state; run doctor');
      }
      const afterPetState = await inspectPetStateReadOnly({
        petId: plan.pet_id,
        ...petOptions(plan, options)
      });
      const petAfter = observedPetSnapshot(afterPetState);
      if (!sameJson(petAfter, plan.pet_expected_after)) {
        setupFailure('pet state did not reach the approved setup result');
      }
      const petResult = recoverAppliedPetResult(plan, afterPetState, actualResult);
      petApplied = await writeImmutablePlanRecord(options.dataDir, plan.plan_id, 'pet_applied', {
        plan_digest: plan.plan_digest,
        pet_action: plan.steps.find((item) => item.kind === 'pet'),
        pet_result: petResult,
        pet_after: petAfter
      });
    }

    const currentPet = await inspectPetStateReadOnly({ petId: plan.pet_id, ...petOptions(plan, options) });
    if (petApplied.payload.plan_digest !== plan.plan_digest
        || !sameJson(petApplied.payload.pet_action, plan.steps.find((item) => item.kind === 'pet'))
        || !sameJson(petApplied.payload.pet_after, plan.pet_expected_after)
        || !sameJson(observedPetSnapshot(currentPet), plan.pet_expected_after)) {
      setupFailure('pet state changed after setup applied its pet step');
    }
    const recoveredPetResult = recoverAppliedPetResult(plan, currentPet);
    if (plan.steps.find((item) => item.kind === 'pet').action === 'update'
        && recoveredPetResult.backupId !== petApplied.payload.pet_result?.backupId) {
      setupFailure('pet rollback backup changed after setup applied its pet step');
    }

    let modeApplied = await readPlanRecord(options.dataDir, plan.plan_id, 'mode_applied');
    const approvedMode = expectedModeAfter(plan);
    if (!modeApplied) {
      const currentMode = modeComparable(await readMode({ root: plan.workspace_root, dataDir: options.dataDir }));
      let modeAfter;
      let mutated = false;
      if (sameJson(currentMode, plan.mode_before)) {
        modeAfter = modeComparable(await applyModeStep(plan, options));
        mutated = plan.steps.find((item) => item.kind === 'review').action !== 'none';
        if (mutated) await options.afterModeMutation?.({ plan: cloneJson(plan), mode: cloneJson(modeAfter) });
      } else if (sameJson(currentMode, approvedMode)) {
        modeAfter = currentMode;
      } else {
        setupFailure('mode state changed before setup could enable review');
      }
      if (!sameJson(modeAfter, approvedMode)) setupFailure('mode did not reach the approved setup result');
      modeApplied = await writeImmutablePlanRecord(options.dataDir, plan.plan_id, 'mode_applied', {
        plan_digest: plan.plan_digest,
        mode_after: modeAfter
      });
    }
    const currentMode = modeComparable(await readMode({ root: plan.workspace_root, dataDir: options.dataDir }));
    if (modeApplied.payload.plan_digest !== plan.plan_digest
        || !sameJson(modeApplied.payload.mode_after, approvedMode)
        || !sameJson(currentMode, approvedMode)) {
      setupFailure('mode state changed after setup enabled review');
    }
    const result = {
      outcome: 'applied',
      plan_digest: plan.plan_digest,
      pet_result: petApplied.payload.pet_result,
      pet_after: petApplied.payload.pet_after,
      mode_after: modeApplied.payload.mode_after,
      manual_host_steps: plan.manual_host_steps
    };
    await writeImmutablePlanRecord(options.dataDir, plan.plan_id, 'applied', result);
    return { plan, ...cloneJson(result), idempotent: false };
  });
}

function updateRollbackIntermediate(plan, petApplied, currentPet) {
  if (petApplied?.payload?.pet_action?.action !== 'update') return null;
  const current = observedPetSnapshot(currentPet);
  if (current.status !== 'not_installed' || current.current.exists !== false || current.owned !== null) return null;
  const additions = assertUnchangedPriorBackups(plan, currentPet);
  const originalId = petApplied.payload.pet_result?.backupId;
  const original = additions.find((record) => record.backup_id === originalId);
  const preservedUpdate = additions.filter(
    (record) => record.backup_id !== originalId && matchingBackup(record, plan.pet_expected_after.current, plan)
  );
  if (!original || !matchingBackup(original, plan.pet_before.current, plan) || preservedUpdate.length !== 1
      || additions.length !== 2) return null;
  return { original, preservedUpdate: preservedUpdate[0] };
}

function assertRecoveredPetRollback(plan, petApplied, currentPet) {
  const step = petApplied?.payload?.pet_action ?? plan.steps.find((item) => item.kind === 'pet');
  const additions = assertUnchangedPriorBackups(plan, currentPet);
  if (step.action === 'install') {
    const preserved = additions.filter((record) => matchingBackup(record, plan.pet_expected_after.current, plan));
    if (additions.length !== 1 || preserved.length !== 1) {
      setupFailure('rollback pet recovery backup is missing or ambiguous');
    }
    return preserved[0];
  }
  if (step.action === 'update') {
    const originalId = petApplied.payload.pet_result?.backupId;
    const preserved = additions.filter(
      (record) => record.backup_id !== originalId && matchingBackup(record, plan.pet_expected_after.current, plan)
    );
    if (additions.some((record) => record.backup_id === originalId)
        || additions.length !== 1 || preserved.length !== 1) {
      setupFailure('rollback update recovery state is missing its preserved updated package');
    }
    return preserved[0];
  }
  if (additions.length !== 0) setupFailure('pet backups changed during no-op rollback');
  return null;
}

async function rollbackPetStep(plan, petApplied, options, intermediate = null) {
  if (!petApplied) return { action: 'none' };
  const action = petApplied.payload.pet_action.action;
  if (action === 'install') {
    if (petApplied.payload.pet_action.preexisting) setupFailure('rollback refused to remove a preexisting pet');
    return removePet(plan.pet_id, petOptions(plan, options));
  }
  if (action === 'update') {
    const backupId = petApplied.payload.pet_result?.backupId;
    if (typeof backupId !== 'string') setupFailure('update rollback backup id is unavailable');
    const removedUpdate = intermediate
      ? {
          action: 'removed_to_backup',
          id: plan.pet_id,
          target: plan.pet_before.target,
          backupId: intermediate.preservedUpdate.backup_id,
          backup: intermediate.preservedUpdate.path
        }
      : await removePet(plan.pet_id, petOptions(plan, options));
    if (!intermediate) {
      await options.afterPetRemovalMutation?.({ plan: cloneJson(plan), result: cloneJson(removedUpdate) });
    }
    const restoredPrior = await restorePet(backupId, petOptions(plan, options));
    return { action: 'update_rolled_back', removedUpdate, restoredPrior };
  }
  return { action: 'none_preexisting' };
}

async function rollbackModeStep(plan, options) {
  const before = plan.mode_before;
  return changeMode({
    root: plan.workspace_root,
    dataDir: options.dataDir,
    action: before.enabled ? 'enable' : 'disable',
    provider: before.provider,
    model: before.model,
    effort: before.effort,
    secondaryProvider: before.secondary_provider ?? undefined,
    secondaryModel: before.secondary_model ?? undefined,
    secondaryEffort: before.secondary_effort ?? undefined,
    singleReviewer: before.secondary_provider === null,
    minConfidence: before.min_confidence,
    maxPatchBytes: before.max_patch_bytes,
    timeoutMs: before.timeout_ms,
    expectedRevision: expectedModeAfter(plan).config_revision
  });
}

export async function rollbackSetupPlan(options = {}) {
  return withLoadedSetupPlanLock(options, async (plan) => {
    const existing = await readPlanRecord(options.dataDir, plan.plan_id, 'rolled_back');
    if (existing) return { plan, ...cloneJson(existing.payload), idempotent: true };
    const applyIntent = await readPlanRecord(options.dataDir, plan.plan_id, 'apply_intent');
    if (!applyIntent) {
      const result = { outcome: 'rolled_back', plan_digest: plan.plan_digest, pet_result: { action: 'none' }, mode_result: null };
      await writeImmutablePlanRecord(options.dataDir, plan.plan_id, 'rolled_back', result);
      return { plan, ...result, idempotent: false };
    }

    await reconcilePetTransactions(petOptions(plan, options));
    const context = await currentPlanContext(plan, options);
    assertStaticPlanContext(plan, context);
    let petApplied = await readPlanRecord(options.dataDir, plan.plan_id, 'pet_applied');
    let modeApplied = await readPlanRecord(options.dataDir, plan.plan_id, 'mode_applied');
    let currentPet = context.petState;
    let currentMode = modeComparable(context.mode);
    const approvedPet = plan.pet_expected_after;
    const approvedMode = expectedModeAfter(plan);

    if (!petApplied && sameJson(observedPetSnapshot(currentPet), approvedPet)) {
      const recovered = recoverAppliedPetResult(plan, currentPet);
      petApplied = await writeImmutablePlanRecord(options.dataDir, plan.plan_id, 'pet_applied', {
        plan_digest: plan.plan_digest,
        pet_action: plan.steps.find((item) => item.kind === 'pet'),
        pet_result: recovered,
        pet_after: approvedPet
      });
    }
    if (!modeApplied && sameJson(currentMode, approvedMode)
        && !sameJson(approvedMode, plan.mode_before)) {
      modeApplied = await writeImmutablePlanRecord(options.dataDir, plan.plan_id, 'mode_applied', {
        plan_digest: plan.plan_digest,
        mode_after: approvedMode
      });
    }

    let rollbackIntent = await readPlanRecord(options.dataDir, plan.plan_id, 'rollback_intent');
    if (!rollbackIntent) {
      if (petApplied && !sameJson(observedPetSnapshot(currentPet), approvedPet)) {
        setupFailure('rollback refused because pet hashes or ownership changed after apply');
      }
      if (!petApplied && !sameJson(observedPetSnapshot(currentPet), observedPetBefore(plan))) {
        setupFailure('rollback refused because the incomplete pet step is ambiguous');
      }
      if (modeApplied && !sameJson(currentMode, approvedMode)) {
        setupFailure('rollback refused because mode state changed after apply');
      }
      if (!modeApplied && !sameJson(currentMode, plan.mode_before)) {
        setupFailure('rollback refused because the incomplete mode step is ambiguous');
      }
      rollbackIntent = await writeImmutablePlanRecord(options.dataDir, plan.plan_id, 'rollback_intent', {
        plan_digest: plan.plan_digest,
        pet_was_applied: petApplied !== null,
        mode_was_applied: modeApplied !== null,
        pet_expected_after: approvedPet,
        mode_expected_after: approvedMode
      });
    }

    let modeRolledBack = await readPlanRecord(options.dataDir, plan.plan_id, 'mode_rolled_back');
    if (!modeRolledBack) {
      const rollbackMode = expectedModeAfterRollback(plan);
      const modeStep = plan.steps.find((item) => item.kind === 'review');
      let modeResult;
      let mutated = false;
      if (!modeApplied) {
        if (!sameJson(currentMode, plan.mode_before)) setupFailure('rollback mode state is ambiguous');
        modeResult = currentMode;
      } else if (modeStep.action === 'none') {
        if (!sameJson(currentMode, plan.mode_before)) setupFailure('rollback no-op mode state is ambiguous');
        modeResult = currentMode;
      } else if (sameJson(currentMode, approvedMode)) {
        modeResult = modeComparable(await rollbackModeStep(plan, options));
        mutated = true;
        if (mutated) await options.afterModeRollbackMutation?.({ plan: cloneJson(plan), mode: cloneJson(modeResult) });
      } else if (sameJson(currentMode, rollbackMode)) {
        modeResult = currentMode;
      } else {
        setupFailure('rollback refused because mode state is neither applied nor safely restored');
      }
      if (!sameJson(modeResult, modeApplied ? rollbackMode : plan.mode_before)) {
        setupFailure('mode rollback did not reach the approved prior settings');
      }
      modeRolledBack = await writeImmutablePlanRecord(options.dataDir, plan.plan_id, 'mode_rolled_back', {
        plan_digest: plan.plan_digest,
        mode_result: modeResult
      });
      currentMode = modeResult;
    } else {
      currentMode = modeComparable(await readMode({ root: plan.workspace_root, dataDir: options.dataDir }));
      const expectedResult = modeApplied ? expectedModeAfterRollback(plan) : plan.mode_before;
      if (modeRolledBack.payload.plan_digest !== plan.plan_digest
          || !sameJson(modeRolledBack.payload.mode_result, expectedResult)
          || !sameJson(currentMode, expectedResult)) {
        setupFailure('mode state changed after rollback restored it');
      }
    }

    let petRolledBack = await readPlanRecord(options.dataDir, plan.plan_id, 'pet_rolled_back');
    if (!petRolledBack) {
      currentPet = await inspectPetStateReadOnly({ petId: plan.pet_id, ...petOptions(plan, options) });
      const observed = observedPetSnapshot(currentPet);
      let petResult;
      let mutated = false;
      if (!petApplied) {
        if (!sameJson(observed, observedPetBefore(plan))) setupFailure('rollback pet state is ambiguous');
        petResult = { action: 'none' };
      } else if (sameJson(observed, approvedPet)) {
        petResult = await rollbackPetStep(plan, petApplied, options);
        mutated = !['none', 'none_preexisting'].includes(petApplied.payload.pet_action.action);
        if (mutated) await options.afterPetRollbackMutation?.({ plan: cloneJson(plan), result: cloneJson(petResult) });
      } else {
        const intermediate = updateRollbackIntermediate(plan, petApplied, currentPet);
        if (intermediate) {
          petResult = await rollbackPetStep(plan, petApplied, options, intermediate);
          mutated = true;
          await options.afterPetRollbackMutation?.({ plan: cloneJson(plan), result: cloneJson(petResult) });
        } else if (sameJson(observed, observedPetBefore(plan))) {
          assertRecoveredPetRollback(plan, petApplied, currentPet);
          petResult = { action: 'recovered_after_rollback', id: plan.pet_id };
        } else {
          setupFailure('rollback refused because pet state is neither applied nor safely restored');
        }
      }
      const afterPet = await inspectPetStateReadOnly({ petId: plan.pet_id, ...petOptions(plan, options) });
      if (!sameJson(observedPetSnapshot(afterPet), observedPetBefore(plan))) {
        setupFailure('pet rollback did not restore the approved prior state');
      }
      if (petApplied && mutated) assertRecoveredPetRollback(plan, petApplied, afterPet);
      petRolledBack = await writeImmutablePlanRecord(options.dataDir, plan.plan_id, 'pet_rolled_back', {
        plan_digest: plan.plan_digest,
        pet_result: petResult,
        pet_after: observedPetSnapshot(afterPet)
      });
    } else {
      currentPet = await inspectPetStateReadOnly({ petId: plan.pet_id, ...petOptions(plan, options) });
      if (petRolledBack.payload.plan_digest !== plan.plan_digest
          || !sameJson(petRolledBack.payload.pet_after, observedPetBefore(plan))
          || !sameJson(observedPetSnapshot(currentPet), observedPetBefore(plan))) {
        setupFailure('pet state changed after rollback restored it');
      }
    }

    const result = {
      outcome: 'rolled_back',
      plan_digest: plan.plan_digest,
      pet_result: petRolledBack.payload.pet_result,
      mode_result: modeRolledBack.payload.mode_result
    };
    await writeImmutablePlanRecord(options.dataDir, plan.plan_id, 'rolled_back', result);
    return { plan, ...cloneJson(result), idempotent: false };
  });
}

export async function readSetupPlan(options = {}) {
  const record = await readPlanRecord(options.dataDir, options.planId, 'plan');
  if (!record) return null;
  return validateStoredPlan(record, options.planDigest);
}
