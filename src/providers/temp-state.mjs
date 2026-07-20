import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  rm
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { workspaceKey } from '../state.mjs';

const LEGACY_TEMP_SCHEMA = 'codex-buddy-provider-temp-v1';
const TEMP_SCHEMA = 'codex-buddy-provider-temp-v2';
const TEMP_PARENT_PREFIX = 'codex-buddy-provider-v1-';
const RUN_PREFIX = 'run-';
const QUARANTINE_PREFIX = '.quarantine-';
const OWNER_MARKER = '.codex-buddy-owner.json';
const RUN_ID_PATTERN = /^[0-9a-f]{32}$/u;
const QUARANTINE_ID_PATTERN = /^[0-9a-f]{16}$/u;
const QUARANTINE_PATTERN = /^\.quarantine-([0-9a-f]{32})-[0-9a-f]{16}$/u;
const LEGACY_MARKER_KEYS = Object.freeze(['created_at', 'pid', 'run_id', 'schema']);
const MARKER_KEYS = Object.freeze([
  'created_at',
  'pid',
  'provider',
  'run_id',
  'schema',
  'workspace_key',
  'workspace_sha256'
]);
const WORKSPACE_KEY_PATTERN = /^[0-9a-f]{16}$/u;
const WORKSPACE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PROVIDERS = Object.freeze(['claude', 'grok', 'ollama', 'opencode']);
const PROVIDER_SET = new Set(PROVIDERS);

export const PROVIDER_TEMP_TTL_MS = 24 * 60 * 60 * 1_000;
export const PROVIDER_TEMP_SCAN_LIMIT = 128;
export const PROVIDER_TEMP_TREE_ENTRY_LIMIT = 4_096;
export const PROVIDER_TEMP_TREE_DEPTH_LIMIT = 32;
export const PROVIDER_TEMP_TREE_BYTE_LIMIT = 64 * 1024 * 1024;
export const PROVIDER_TEMP_INVENTORY_DEADLINE_MS = 2_000;

const issuedRuns = new WeakMap();

class ProviderTempInventoryIncomplete extends Error {}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function exactMode(stat, expected) {
  return (Number(stat.mode) & 0o777) === expected;
}

function hasStableCreationIdentity(stat) {
  return typeof stat?.birthtimeNs === 'bigint' && stat.birthtimeNs > 0n;
}

function requiresStableCreationIdentity(platform) {
  return ['darwin', 'freebsd', 'win32'].includes(platform);
}

export function providerTempIdentitiesMatch(left, right, platform = process.platform) {
  if (typeof left?.dev !== 'bigint' || typeof left?.ino !== 'bigint'
      || typeof right?.dev !== 'bigint' || typeof right?.ino !== 'bigint'
      || left.dev !== right.dev || left.ino !== right.ino) {
    return false;
  }
  // Node documents that an unavailable birth time may be reported as ctime or
  // the Unix epoch. Linux filesystems do not expose it consistently, so dev
  // and inode remain the portable identity there. Platforms with dependable
  // creation time get the stronger replacement check.
  if (!requiresStableCreationIdentity(platform)) return true;
  return hasStableCreationIdentity(left)
    && hasStableCreationIdentity(right)
    && left.birthtimeNs === right.birthtimeNs;
}

function ownedByCurrentUser(stat, uid = currentUid()) {
  return uid === null || Number(stat.uid) === uid;
}

function ownershipCanBeProven(platform = process.platform) {
  return platform !== 'win32' && currentUid() !== null;
}

function workspaceFingerprint(root) {
  return createHash('sha256').update(path.resolve(root)).digest('hex');
}

function stableUserKey() {
  if (typeof process.getuid === 'function') return `uid-${process.getuid()}`;
  return `user-${createHash('sha256')
    .update(`${os.homedir()}\0${os.userInfo().username}`)
    .digest('hex')
    .slice(0, 16)}`;
}

export function providerTempParent(tempBase = os.tmpdir()) {
  if (typeof tempBase !== 'string' || !path.isAbsolute(tempBase)) {
    throw new TypeError('Provider temporary base must be an absolute path');
  }
  return path.join(tempBase, `${TEMP_PARENT_PREFIX}${stableUserKey()}`);
}

async function secureParent(tempBase, platform = process.platform) {
  const parent = providerTempParent(tempBase);
  try {
    await mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const before = await lstat(parent, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || !ownedByCurrentUser(before)
      || (platform !== 'win32' && !exactMode(before, 0o700))) {
    throw new Error('Buddy provider temporary root is not a secured owned directory');
  }
  if (requiresStableCreationIdentity(platform) && !hasStableCreationIdentity(before)) {
    throw new Error('Buddy provider temporary filesystem does not expose stable creation identity');
  }
  return { parent, identity: before };
}

async function assertParentUnchanged(parent, expected, platform = process.platform) {
  const actual = await lstat(parent, { bigint: true });
  if (!actual.isDirectory() || actual.isSymbolicLink() || !ownedByCurrentUser(actual)
      || !providerTempIdentitiesMatch(actual, expected, platform)
      || (platform !== 'win32' && !exactMode(actual, 0o700))) {
    throw new Error('Buddy provider temporary root changed during use');
  }
}

function parseRunName(name) {
  if (name.startsWith(RUN_PREFIX)) {
    const runId = name.slice(RUN_PREFIX.length);
    return RUN_ID_PATTERN.test(runId) ? runId : null;
  }
  return QUARANTINE_PATTERN.exec(name)?.[1] ?? null;
}

function commonMarkerFieldsValid(value, runId) {
  if (value.run_id !== runId) return false;
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) return false;
  if (typeof value.created_at !== 'string') return false;
  const createdMs = Date.parse(value.created_at);
  return Number.isFinite(createdMs) && new Date(createdMs).toISOString() === value.created_at;
}

function validMarker(value, runId) {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== MARKER_KEYS.length
      || !keys.every((key, index) => key === MARKER_KEYS[index])) {
    return false;
  }
  return value.schema === TEMP_SCHEMA
    && WORKSPACE_KEY_PATTERN.test(value.workspace_key)
    && WORKSPACE_SHA256_PATTERN.test(value.workspace_sha256)
    && PROVIDER_SET.has(value.provider)
    && commonMarkerFieldsValid(value, runId);
}

function validLegacyMarker(value, runId) {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== LEGACY_MARKER_KEYS.length
      || !keys.every((key, index) => key === LEGACY_MARKER_KEYS[index])) {
    return false;
  }
  return value.schema === LEGACY_TEMP_SCHEMA && commonMarkerFieldsValid(value, runId);
}

async function readMarker(directory, runId, platform = process.platform) {
  const marker = path.join(directory, OWNER_MARKER);
  let before;
  try {
    before = await lstat(marker, { bigint: true });
  } catch {
    return null;
  }
  if (!before.isFile() || before.isSymbolicLink() || !ownedByCurrentUser(before)
      || before.size < 2n || before.size > 1_024n
      || (platform !== 'win32' && !exactMode(before, 0o600))) {
    return null;
  }

  let handle;
  try {
    handle = await open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !providerTempIdentitiesMatch(before, opened, platform) || opened.size !== before.size
        || !ownedByCurrentUser(opened)
        || (platform !== 'win32' && !exactMode(opened, 0o600))) {
      return null;
    }
    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!providerTempIdentitiesMatch(opened, after, platform) || opened.size !== after.size
        || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      return null;
    }
    if (validMarker(parsed, runId)) return Object.freeze({ ...parsed, legacy: false });
    if (validLegacyMarker(parsed, runId)) return Object.freeze({ ...parsed, legacy: true });
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function maybeRemoveStaleChild({
  parent,
  parentIdentity,
  name,
  platform,
  nowMs,
  ttlMs,
  processAliveImpl,
  randomBytesImpl,
  renameImpl,
  removeImpl
}) {
  const runId = parseRunName(name);
  if (!runId) return 'refused';
  // Node does not expose a dependable owner SID or effective DACL check for
  // this path. Never treat a Windows marker alone as deletion authority.
  if (!ownershipCanBeProven(platform)) return 'refused';
  const child = path.join(parent, name);
  let before;
  try {
    before = await lstat(child, { bigint: true });
  } catch {
    return 'refused';
  }
  if (!before.isDirectory() || before.isSymbolicLink() || !ownedByCurrentUser(before)
      || (platform !== 'win32' && !exactMode(before, 0o700))) {
    return 'refused';
  }
  const marker = await readMarker(child, runId, platform);
  if (!marker) return 'refused';
  const createdMs = Date.parse(marker.created_at);
  if (!(nowMs - createdMs > ttlMs) || processAliveImpl(marker.pid)) return 'preserved';

  await assertParentUnchanged(parent, parentIdentity, platform);
  const rechecked = await lstat(child, { bigint: true }).catch(() => null);
  if (!rechecked || !rechecked.isDirectory() || rechecked.isSymbolicLink()
      || !providerTempIdentitiesMatch(before, rechecked, platform) || !ownedByCurrentUser(rechecked)
      || (platform !== 'win32' && !exactMode(rechecked, 0o700))) {
    return 'refused';
  }
  const finalMarker = await readMarker(child, runId, platform);
  if (!finalMarker || finalMarker.pid !== marker.pid
      || finalMarker.created_at !== marker.created_at
      || finalMarker.schema !== marker.schema
      || finalMarker.workspace_key !== marker.workspace_key
      || finalMarker.workspace_sha256 !== marker.workspace_sha256
      || finalMarker.provider !== marker.provider) {
    return 'refused';
  }

  const quarantineId = randomBytesImpl(8).toString('hex');
  if (!QUARANTINE_ID_PATTERN.test(quarantineId)) return 'refused';
  const quarantine = path.join(
    parent,
    `${QUARANTINE_PREFIX}${runId}-${quarantineId}`
  );
  try {
    await renameImpl(child, quarantine);
  } catch {
    return 'refused';
  }
  const moved = await lstat(quarantine, { bigint: true }).catch(() => null);
  if (!moved || !moved.isDirectory() || moved.isSymbolicLink()
      || !providerTempIdentitiesMatch(before, moved, platform)
      || !ownedByCurrentUser(moved)
      || (platform !== 'win32' && !exactMode(moved, 0o700))) {
    return 'refused';
  }
  try {
    await removeImpl(quarantine, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
    return 'removed';
  } catch {
    return 'preserved';
  }
}

export async function sweepStaleProviderTempRuns({
  tempBase = os.tmpdir(),
  nowMs = Date.now(),
  ttlMs = PROVIDER_TEMP_TTL_MS,
  scanLimit = PROVIDER_TEMP_SCAN_LIMIT,
  processAliveImpl = defaultProcessAlive,
  randomBytesImpl = randomBytes,
  renameImpl = rename,
  removeImpl = rm,
  platform = process.platform
} = {}) {
  if (!Number.isFinite(nowMs)) throw new TypeError('Provider temporary sweep time must be finite');
  if (!Number.isSafeInteger(ttlMs) || ttlMs !== PROVIDER_TEMP_TTL_MS) {
    throw new TypeError('Provider temporary TTL must be exactly 24 hours');
  }
  if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > PROVIDER_TEMP_SCAN_LIMIT) {
    throw new TypeError(`Provider temporary scan limit must be 1-${PROVIDER_TEMP_SCAN_LIMIT}`);
  }
  for (const [label, implementation] of Object.entries({
    processAliveImpl, randomBytesImpl, renameImpl, removeImpl
  })) {
    if (typeof implementation !== 'function') throw new TypeError(`${label} must be callable`);
  }

  if (typeof platform !== 'string' || !platform) throw new TypeError('Provider platform must be non-empty text');
  const { parent, identity } = await secureParent(tempBase, platform);
  const summary = { scanned: 0, removed: 0, preserved: 0, refused: 0, limited: false };
  const directory = await opendir(parent);
  try {
    for await (const entry of directory) {
      if (summary.scanned >= scanLimit) {
        summary.limited = true;
        break;
      }
      summary.scanned += 1;
      const result = await maybeRemoveStaleChild({
        parent,
        parentIdentity: identity,
        name: entry.name,
        platform,
        nowMs,
        ttlMs,
        processAliveImpl,
        randomBytesImpl,
        renameImpl,
        removeImpl
      });
      summary[result] += 1;
    }
  } finally {
    await directory.close().catch(() => {});
  }
  await assertParentUnchanged(parent, identity, platform);
  return Object.freeze({ parent, ...summary });
}

function assertInventoryBudget(budget, depth) {
  if (depth > PROVIDER_TEMP_TREE_DEPTH_LIMIT
      || budget.entries > PROVIDER_TEMP_TREE_ENTRY_LIMIT
      || budget.bytes > PROVIDER_TEMP_TREE_BYTE_LIMIT
      || budget.monotonicNowImpl() - budget.startedAt >= PROVIDER_TEMP_INVENTORY_DEADLINE_MS) {
    throw new ProviderTempInventoryIncomplete('Provider temporary inventory budget was exhausted');
  }
}

async function countRunTree(directory, platform, budget, depth = 0) {
  assertInventoryBudget(budget, depth);
  let files = 0;
  let bytes = 0;
  const entries = await opendir(directory);
  try {
    for await (const entry of entries) {
      budget.entries += 1;
      assertInventoryBudget(budget, depth);
      const child = path.join(directory, entry.name);
      const details = await lstat(child, { bigint: true });
      if (details.isSymbolicLink() || !ownedByCurrentUser(details)) {
        throw new Error('Provider temporary run contains an untrusted filesystem entry');
      }
      if (details.isDirectory()) {
        const nested = await countRunTree(child, platform, budget, depth + 1);
        files += nested.files;
        bytes += nested.bytes;
      } else if (details.isFile()) {
        if (details.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('Provider temporary run exceeds the supported inventory size');
        }
        files += 1;
        bytes += Number(details.size);
        budget.bytes += Number(details.size);
        if (!Number.isSafeInteger(bytes)) {
          throw new Error('Provider temporary run inventory exceeds the supported byte count');
        }
        assertInventoryBudget(budget, depth);
      } else {
        throw new Error('Provider temporary run contains an unsupported filesystem entry');
      }
    }
  } finally {
    await entries.close().catch(() => {});
  }
  // A mode-0700 run root is the access boundary on POSIX. Provider CLIs may
  // create more permissive descendants inside it, so descendant mode bits are
  // inventoried through the secured root rather than treated as ownership.
  void platform;
  return { files, bytes };
}

async function collectProviderTempInventory({
  root,
  tempBase,
  scanLimit,
  processAliveImpl,
  platform,
  monotonicNowImpl
}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('Provider temporary inventory root must be an absolute path');
  }
  if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > PROVIDER_TEMP_SCAN_LIMIT) {
    throw new TypeError(`Provider temporary scan limit must be 1-${PROVIDER_TEMP_SCAN_LIMIT}`);
  }
  if (typeof processAliveImpl !== 'function') {
    throw new TypeError('Provider temporary process check must be callable');
  }
  if (typeof monotonicNowImpl !== 'function') {
    throw new TypeError('Provider temporary monotonic clock must be callable');
  }
  const { parent, identity } = await secureParent(tempBase, platform);
  const expectedWorkspace = workspaceKey(path.resolve(root));
  const expectedWorkspaceSha256 = workspaceFingerprint(root);
  const records = [];
  let scanned = 0;
  let limited = false;
  let refused = 0;
  let legacy = 0;
  let refusedAttributed = 0;
  const budget = {
    entries: 0,
    bytes: 0,
    startedAt: monotonicNowImpl(),
    monotonicNowImpl
  };
  const directory = await opendir(parent);
  try {
    for await (const entry of directory) {
      if (scanned >= scanLimit) {
        limited = true;
        break;
      }
      scanned += 1;
      const runId = parseRunName(entry.name);
      if (!runId) {
        refused += 1;
        continue;
      }
      const child = path.join(parent, entry.name);
      const before = await lstat(child, { bigint: true }).catch(() => null);
      if (!before || !before.isDirectory() || before.isSymbolicLink()
          || !ownedByCurrentUser(before)
          || (platform !== 'win32' && !exactMode(before, 0o700))) {
        refused += 1;
        continue;
      }
      const marker = await readMarker(child, runId, platform);
      if (!marker) {
        refused += 1;
        continue;
      }
      if (marker.legacy) {
        legacy += 1;
        continue;
      }
      if (marker.workspace_key !== expectedWorkspace
          || marker.workspace_sha256 !== expectedWorkspaceSha256) continue;
      let totals;
      try {
        totals = await countRunTree(child, platform, budget);
      } catch (error) {
        if (error instanceof ProviderTempInventoryIncomplete) {
          limited = true;
          break;
        }
        refused += 1;
        refusedAttributed += 1;
        continue;
      }
      const live = processAliveImpl(marker.pid);
      records.push(Object.freeze({
        name: entry.name,
        child,
        before,
        marker,
        live,
        files: totals.files,
        bytes: totals.bytes
      }));
    }
  } finally {
    await directory.close().catch(() => {});
  }
  await assertParentUnchanged(parent, identity, platform);
  return {
    parent,
    identity,
    expectedWorkspace,
    expectedWorkspaceSha256,
    records,
    scanned,
    limited,
    refused,
    refusedAttributed,
    legacy
  };
}

function summarizeProviderTempInventory(inventory, platform) {
  const providerTotals = new Map(PROVIDERS.map((provider) => [provider, {
    provider,
    runs: 0,
    live_runs: 0,
    removable_runs: 0,
    files: 0,
    bytes: 0
  }]));
  for (const record of inventory.records) {
    const totals = providerTotals.get(record.marker.provider);
    totals.runs += 1;
    totals.live_runs += record.live ? 1 : 0;
    totals.removable_runs += record.live ? 0 : 1;
    totals.files += record.files;
    totals.bytes += record.bytes;
  }
  const files = inventory.records.reduce((total, record) => total + record.files, 0);
  const bytes = inventory.records.reduce((total, record) => total + record.bytes, 0);
  return Object.freeze({
    schema_version: '1',
    workspace_key: inventory.expectedWorkspace,
    complete: !inventory.limited && inventory.refusedAttributed === 0,
    ownership_assurance: ownershipCanBeProven(platform)
      ? 'posix_uid_and_mode_verified'
      : 'windows_acl_unverified',
    purge_supported: ownershipCanBeProven(platform),
    scanned_entries: inventory.scanned,
    limited: inventory.limited,
    attributed_runs: inventory.records.length,
    live_runs: inventory.records.filter((record) => record.live).length,
    removable_runs: inventory.records.filter((record) => !record.live).length,
    files,
    bytes,
    providers: Object.freeze([...providerTotals.values()]
      .filter((item) => item.runs > 0)
      .map((item) => Object.freeze({ ...item }))),
    legacy_unattributed_runs: inventory.legacy,
    refused_attributed_runs: inventory.refusedAttributed,
    refused_entries: inventory.refused
  });
}

export async function workspaceProviderTempStatus({
  root,
  tempBase = os.tmpdir(),
  scanLimit = PROVIDER_TEMP_SCAN_LIMIT,
  processAliveImpl = defaultProcessAlive,
  platform = process.platform,
  monotonicNowImpl = () => performance.now()
} = {}) {
  const inventory = await collectProviderTempInventory({
    root,
    tempBase,
    scanLimit,
    processAliveImpl,
    platform,
    monotonicNowImpl
  });
  return summarizeProviderTempInventory(inventory, platform);
}

function sameMarker(left, right) {
  return left
    && left.schema === right.schema
    && left.run_id === right.run_id
    && left.pid === right.pid
    && left.created_at === right.created_at
    && left.workspace_key === right.workspace_key
    && left.workspace_sha256 === right.workspace_sha256
    && left.provider === right.provider
    && left.legacy === right.legacy;
}

async function removeAttributedTempRecord({
  inventory,
  record,
  platform,
  processAliveImpl,
  randomBytesImpl,
  renameImpl,
  removeImpl,
  inventoryBudget
}) {
  if (processAliveImpl(record.marker.pid)) return 'live';
  await assertParentUnchanged(inventory.parent, inventory.identity, platform);
  const rechecked = await lstat(record.child, { bigint: true }).catch(() => null);
  if (!rechecked || !rechecked.isDirectory() || rechecked.isSymbolicLink()
      || !providerTempIdentitiesMatch(record.before, rechecked, platform) || !ownedByCurrentUser(rechecked)
      || (platform !== 'win32' && !exactMode(rechecked, 0o700))) {
    return 'refused';
  }
  const marker = await readMarker(record.child, record.marker.run_id, platform);
  if (!sameMarker(marker, record.marker)
      || marker.workspace_key !== inventory.expectedWorkspace
      || marker.workspace_sha256 !== inventory.expectedWorkspaceSha256) {
    return 'refused';
  }
  try {
    await countRunTree(record.child, platform, inventoryBudget);
  } catch {
    return 'refused';
  }
  if (processAliveImpl(marker.pid)) return 'live';

  const quarantineId = randomBytesImpl(8).toString('hex');
  if (!QUARANTINE_ID_PATTERN.test(quarantineId)) return 'refused';
  const quarantine = path.join(
    inventory.parent,
    `${QUARANTINE_PREFIX}${record.marker.run_id}-${quarantineId}`
  );
  try {
    await renameImpl(record.child, quarantine);
  } catch {
    return 'refused';
  }
  const moved = await lstat(quarantine, { bigint: true }).catch(() => null);
  const movedMarker = moved
    ? await readMarker(quarantine, record.marker.run_id, platform)
    : null;
  if (!moved || !moved.isDirectory() || moved.isSymbolicLink()
      || !providerTempIdentitiesMatch(record.before, moved, platform) || !ownedByCurrentUser(moved)
      || (platform !== 'win32' && !exactMode(moved, 0o700))
      || !sameMarker(movedMarker, record.marker)) {
    return 'refused';
  }
  try {
    await removeImpl(quarantine, {
      recursive: true,
      force: false,
      maxRetries: 3,
      retryDelay: 50
    });
    return 'removed';
  } catch {
    return 'preserved';
  }
}

export async function purgeWorkspaceProviderTempRuns({
  root,
  tempBase = os.tmpdir(),
  scanLimit = PROVIDER_TEMP_SCAN_LIMIT,
  processAliveImpl = defaultProcessAlive,
  randomBytesImpl = randomBytes,
  renameImpl = rename,
  removeImpl = rm,
  platform = process.platform,
  monotonicNowImpl = () => performance.now()
} = {}) {
  for (const [label, implementation] of Object.entries({
    processAliveImpl, randomBytesImpl, renameImpl, removeImpl
  })) {
    if (typeof implementation !== 'function') throw new TypeError(`${label} must be callable`);
  }
  const inventory = await collectProviderTempInventory({
    root,
    tempBase,
    scanLimit,
    processAliveImpl,
    platform,
    monotonicNowImpl
  });
  const before = summarizeProviderTempInventory(inventory, platform);
  if (!before.complete) {
    throw new Error(
      'Buddy provider temporary purge refused because the bounded ownership inventory is incomplete'
    );
  }
  if (!ownershipCanBeProven(platform) && inventory.records.length > 0) {
    throw new Error(
      'Buddy provider temporary purge refused because Windows ACL ownership is not verified'
    );
  }

  const result = { removed: 0, removed_files: 0, removed_bytes: 0, live: 0, preserved: 0, refused: 0 };
  const removalBudget = {
    entries: 0,
    bytes: 0,
    startedAt: monotonicNowImpl(),
    monotonicNowImpl
  };
  for (const record of inventory.records) {
    const outcome = await removeAttributedTempRecord({
      inventory,
      record,
      platform,
      processAliveImpl,
      randomBytesImpl,
      renameImpl,
      removeImpl,
      inventoryBudget: removalBudget
    });
    if (outcome === 'removed') {
      result.removed += 1;
      result.removed_files += record.files;
      result.removed_bytes += record.bytes;
    } else {
      result[outcome] += 1;
    }
  }
  await assertParentUnchanged(inventory.parent, inventory.identity, platform);
  return Object.freeze({
    schema_version: '1',
    workspace_key: inventory.expectedWorkspace,
    ownership_assurance: before.ownership_assurance,
    purge_supported: before.purge_supported,
    removed_runs: result.removed,
    removed_files: result.removed_files,
    removed_bytes: result.removed_bytes,
    retained_live_runs: result.live,
    retained_preserved_runs: result.preserved,
    refused_runs: result.refused,
    legacy_unattributed_runs: inventory.legacy
  });
}

export async function createProviderTempRun({
  root,
  provider,
  tempBase = os.tmpdir(),
  nowMs = Date.now(),
  pid = process.pid,
  randomBytesImpl = randomBytes,
  processAliveImpl = defaultProcessAlive,
  staleRemoveImpl = rm,
  openImpl = open,
  platform = process.platform
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('Provider temporary workspace root must be an absolute path');
  }
  if (!PROVIDER_SET.has(provider)) {
    throw new TypeError(`Provider temporary attribution must be one of: ${PROVIDERS.join(', ')}`);
  }
  if (!Number.isFinite(nowMs)) throw new TypeError('Provider temporary creation time must be finite');
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError('Provider temporary owner PID is invalid');
  if (typeof openImpl !== 'function') throw new TypeError('Provider temporary marker opener must be callable');
  await sweepStaleProviderTempRuns({
    tempBase,
    nowMs,
    processAliveImpl,
    randomBytesImpl,
    removeImpl: staleRemoveImpl,
    platform
  });
  const { parent, identity } = await secureParent(tempBase, platform);
  await assertParentUnchanged(parent, identity, platform);
  const runId = randomBytesImpl(16).toString('hex');
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('Provider temporary run ID generation failed');
  const directory = path.join(parent, `${RUN_PREFIX}${runId}`);
  await mkdir(directory, { mode: 0o700 });

  let issuedIdentity;
  let issuedMarker;
  let createdIdentity;
  try {
    const runStat = await lstat(directory, { bigint: true });
    createdIdentity = runStat;
    if (!runStat.isDirectory() || runStat.isSymbolicLink() || !ownedByCurrentUser(runStat)
        || (platform !== 'win32' && !exactMode(runStat, 0o700))) {
      throw new Error('Provider temporary run directory cannot be secured');
    }
    const marker = {
      schema: TEMP_SCHEMA,
      run_id: runId,
      pid,
      created_at: new Date(nowMs).toISOString(),
      workspace_key: workspaceKey(path.resolve(root)),
      workspace_sha256: workspaceFingerprint(root),
      provider
    };
    const handle = await openImpl(path.join(directory, OWNER_MARKER), 'wx', 0o600);
    try {
      if (platform !== 'win32') await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const checked = await readMarker(directory, runId, platform);
    if (!checked || checked.legacy) {
      throw new Error('Provider temporary ownership marker validation failed');
    }
    issuedIdentity = runStat;
    issuedMarker = checked;
    await assertParentUnchanged(parent, identity, platform);
  } catch (error) {
    const cleanupTarget = await lstat(directory, { bigint: true }).catch(() => null);
    if (createdIdentity
        && cleanupTarget?.isDirectory()
        && !cleanupTarget.isSymbolicLink()
        && providerTempIdentitiesMatch(cleanupTarget, createdIdentity, platform)
        && ownedByCurrentUser(cleanupTarget)
        && (platform === 'win32' || exactMode(cleanupTarget, 0o700))) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }

  const run = Object.freeze({ directory, parent, runId });
  issuedRuns.set(run, Object.freeze({
    identity: issuedIdentity,
    marker: issuedMarker,
    parentIdentity: identity,
    platform
  }));
  return run;
}

export async function cleanupProviderTempRun(run, { cleanupImpl = rm } = {}) {
  const issued = plainObject(run) ? issuedRuns.get(run) : null;
  if (!issued) {
    throw new TypeError('Provider temporary cleanup requires an issued run');
  }
  if (typeof cleanupImpl !== 'function') throw new TypeError('Provider cleanup must be callable');
  if (run.directory !== path.join(run.parent, `${RUN_PREFIX}${run.runId}`)) {
    throw new Error('Provider temporary cleanup target is invalid');
  }
  await assertParentUnchanged(run.parent, issued.parentIdentity, issued.platform);
  const current = await lstat(run.directory, { bigint: true }).catch(() => null);
  const marker = current
    ? await readMarker(run.directory, run.runId, issued.platform)
    : null;
  if (!current || !current.isDirectory() || current.isSymbolicLink()
      || !providerTempIdentitiesMatch(current, issued.identity, issued.platform)
      || !ownedByCurrentUser(current)
      || (issued.platform !== 'win32' && !exactMode(current, 0o700))
      || !sameMarker(marker, issued.marker)) {
    throw new Error('Provider temporary cleanup ownership proof changed');
  }
  await cleanupImpl(run.directory, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50
  });
}
