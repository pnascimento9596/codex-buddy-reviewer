import { lstat, opendir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  purgeWorkspaceProviderTempRuns,
  workspaceProviderTempStatus
} from './providers/temp-state.mjs';
import { pruneWorkspaceTurns } from './runtime-pruner.mjs';
import { pruneSetupPlansForWorkspace } from './setup.mjs';
import { resolveDataDir, resolveRuntimeDataDir, workspaceKey } from './state.mjs';

export const DATA_INVENTORY_ENTRY_LIMIT = 20_000;
export const DATA_INVENTORY_DEPTH_LIMIT = 64;
export const DATA_INVENTORY_BYTE_LIMIT = 1024 * 1024 * 1024;
export const DATA_INVENTORY_DEADLINE_MS = 2_000;

class DataInventoryIncomplete extends Error {
  constructor(reason) {
    super(`Buddy data inventory is incomplete: ${reason}`);
    this.reason = reason;
  }
}

function newInventoryBudget(monotonicNowImpl = () => performance.now()) {
  if (typeof monotonicNowImpl !== 'function') {
    throw new TypeError('Buddy data inventory monotonic clock must be callable');
  }
  return {
    entries: 0,
    files: 0,
    bytes: 0,
    startedAt: monotonicNowImpl(),
    monotonicNowImpl
  };
}

function assertInventoryBudget(budget, depth) {
  let reason = null;
  if (depth > DATA_INVENTORY_DEPTH_LIMIT) reason = 'depth_limit';
  else if (budget.entries > DATA_INVENTORY_ENTRY_LIMIT) reason = 'entry_limit';
  else if (budget.bytes > DATA_INVENTORY_BYTE_LIMIT) reason = 'byte_limit';
  else if (budget.monotonicNowImpl() - budget.startedAt >= DATA_INVENTORY_DEADLINE_MS) {
    reason = 'deadline';
  }
  if (reason) throw new DataInventoryIncomplete(reason);
}

function exactWorkspaceTargets({ root, dataDir, runtimeDataDir }) {
  const dataRoot = path.resolve(resolveDataDir(dataDir));
  const runtimeRoot = path.resolve(resolveRuntimeDataDir(runtimeDataDir));
  const workspace = workspaceKey(path.resolve(root));
  return {
    workspace,
    dataRoot,
    runtimeRoot,
    content: [
      { id: 'manual_reviews', root: dataRoot, target: path.join(dataRoot, 'reviews', workspace) },
      { id: 'automatic_reviews', root: runtimeRoot, target: path.join(runtimeRoot, 'automatic-reviews', workspace) },
      { id: 'renderer_outbox', root: runtimeRoot, target: path.join(runtimeRoot, 'outbox', workspace) },
      { id: 'renderer_cursors', root: runtimeRoot, target: path.join(runtimeRoot, 'renderers', workspace) }
    ],
    turns: { id: 'turn_state', root: runtimeRoot, target: path.join(runtimeRoot, 'turns', workspace) },
    settings: [
      { id: 'mode', root: dataRoot, target: path.join(dataRoot, 'mode', `${workspace}.json`) },
      { id: 'summary_guard', root: dataRoot, target: path.join(dataRoot, 'summary-claim-guard', `${workspace}.json`) },
      { id: 'presentation', root: dataRoot, target: path.join(dataRoot, 'presentation', workspace) },
      { id: 'reviewer_circuits', root: runtimeRoot, target: path.join(runtimeRoot, 'circuits', workspace) },
      { id: 'egress_registry', root: dataRoot, target: path.join(dataRoot, 'egress', workspace) }
    ],
    outsideScope: [
      {
        id: 'setup_plans_and_journals',
        scope: 'shared',
        root: dataRoot,
        target: path.join(dataRoot, 'setup'),
        reason: 'Only expired never-started or old terminal records for this workspace are eligible for the transaction-aware setup pruner. Unresolved rollback evidence is preserved.'
      },
      {
        id: 'pet_install_registry_and_backups',
        scope: 'shared',
        root: dataRoot,
        target: path.join(dataRoot, 'pets'),
        reason: 'Pet ownership and rollback records are shared installation state, not review content.'
      },
    ]
  };
}

async function detailsOrMissing(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertContained(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Buddy data target must be a strict descendant of its configured state root');
  }
  return relative.split(path.sep).filter(Boolean);
}

async function inspectExactPath(root, target) {
  const components = assertContained(root, target);
  const rootDetails = await detailsOrMissing(root);
  if (!rootDetails) return { exists: false, kind: 'missing' };
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new Error(`Buddy state root must be a regular non-symlink directory: ${root}`);
  }
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const details = await detailsOrMissing(current);
    if (!details) return { exists: false, kind: 'missing' };
    if (details.isSymbolicLink()) {
      throw new Error(`Buddy refuses a data path containing a symbolic link: ${current}`);
    }
    if (index < components.length - 1 && !details.isDirectory()) {
      throw new Error(`Buddy state path has a non-directory ancestor: ${current}`);
    }
    if (index === components.length - 1) {
      if (!details.isDirectory() && !details.isFile()) {
        throw new Error(`Buddy data target must be a regular file or directory: ${current}`);
      }
      return {
        exists: true,
        kind: details.isDirectory() ? 'directory' : 'file',
        bytes: details.isFile() ? details.size : 0
      };
    }
  }
  throw new Error('Buddy could not resolve the exact workspace data target');
}

async function countTree(target, kind, budget, depth = 0) {
  assertInventoryBudget(budget, depth);
  if (kind === 'file') {
    const details = await lstat(target);
    budget.entries += 1;
    budget.files += 1;
    budget.bytes += details.size;
    assertInventoryBudget(budget, depth);
    return { files: 1, bytes: details.size };
  }
  let files = 0;
  let bytes = 0;
  const entries = await opendir(target);
  try {
    for await (const entry of entries) {
      budget.entries += 1;
      assertInventoryBudget(budget, depth);
      const child = path.join(target, entry.name);
      const details = await lstat(child);
      if (details.isSymbolicLink()) {
        throw new Error(`Buddy refuses to inspect a symbolic link in private state: ${child}`);
      }
      if (details.isDirectory()) {
        const nested = await countTree(child, 'directory', budget, depth + 1);
        files += nested.files;
        bytes += nested.bytes;
      } else if (details.isFile()) {
        files += 1;
        bytes += details.size;
        budget.files += 1;
        budget.bytes += details.size;
        assertInventoryBudget(budget, depth);
      } else {
        throw new Error(`Buddy private state contains an unsupported filesystem entry: ${child}`);
      }
    }
  } finally {
    await entries.close().catch(() => {});
  }
  return { files, bytes };
}

async function targetStatus(target, budget) {
  const inspected = await inspectExactPath(target.root, target.target);
  const beforeFiles = budget.files;
  const beforeBytes = budget.bytes;
  let complete = true;
  let incompleteReason = null;
  if (inspected.exists) {
    try {
      await countTree(target.target, inspected.kind, budget);
    } catch (error) {
      if (!(error instanceof DataInventoryIncomplete)) throw error;
      complete = false;
      incompleteReason = error.reason;
    }
  }
  return Object.freeze({
    id: target.id,
    path: target.target,
    exists: inspected.exists,
    complete,
    incomplete_reason: incompleteReason,
    files: budget.files - beforeFiles,
    bytes: budget.bytes - beforeBytes
  });
}

async function outsideScopeStatus(target, budget) {
  const status = await targetStatus(target, budget);
  return Object.freeze({
    ...status,
    scope: target.scope,
    reason: target.reason
  });
}

async function collectStatuses(targets, budget, mapper = targetStatus) {
  const statuses = [];
  for (const target of targets) statuses.push(await mapper(target, budget));
  return statuses;
}

async function removeTarget(target) {
  const inspected = await inspectExactPath(target.root, target.target);
  if (!inspected.exists) return false;
  await rm(target.target, {
    recursive: inspected.kind === 'directory',
    force: true
  });
  return true;
}

export async function workspaceDataStatus(options) {
  const targets = exactWorkspaceTargets(options);
  const budget = newInventoryBudget(options.dataInventoryMonotonicNowImpl);
  const content = await collectStatuses([...targets.content, targets.turns], budget);
  const settings = await collectStatuses(targets.settings, budget);
  const outsideScope = await collectStatuses(targets.outsideScope, budget, outsideScopeStatus);
  const providerTemporary = await workspaceProviderTempStatus({
    root: options.root,
    tempBase: options.providerTempBase,
    processAliveImpl: options.providerProcessAliveImpl,
    platform: options.platform,
    monotonicNowImpl: options.providerInventoryMonotonicNowImpl
  });
  const incompleteReasons = [...new Set([
    ...content,
    ...settings,
    ...outsideScope
  ].filter((item) => !item.complete).map((item) => item.incomplete_reason))];
  if (!providerTemporary.complete) incompleteReasons.push('provider_temporary_inventory');
  return Object.freeze({
    schema_version: '1',
    workspace_key: targets.workspace,
    workspace_root: path.resolve(options.root),
    complete: incompleteReasons.length === 0,
    incomplete_reasons: Object.freeze([...new Set(incompleteReasons)]),
    content: Object.freeze(content),
    settings: Object.freeze(settings),
    provider_temporary: providerTemporary,
    preserved_outside_scope: Object.freeze(outsideScope),
    totals: Object.freeze({
      content_files: content.reduce((total, item) => total + item.files, 0),
      content_bytes: content.reduce((total, item) => total + item.bytes, 0),
      settings_files: settings.reduce((total, item) => total + item.files, 0),
      settings_bytes: settings.reduce((total, item) => total + item.bytes, 0),
      provider_temporary_files: providerTemporary.files,
      provider_temporary_bytes: providerTemporary.bytes,
      outside_scope_files: outsideScope.reduce((total, item) => total + item.files, 0),
      outside_scope_bytes: outsideScope.reduce((total, item) => total + item.bytes, 0)
    })
  });
}

export async function purgeWorkspaceData(options) {
  const targets = exactWorkspaceTargets(options);
  const allTargets = [
    ...targets.content,
    targets.turns,
    ...targets.settings
  ];
  // Fully inventory every target before the first mutation. This recursively
  // rejects symbolic links and unsupported filesystem entries, so a purge
  // cannot partially delete safe areas before discovering an unsafe child in
  // another workspace-scoped area.
  const budget = newInventoryBudget(options.dataInventoryMonotonicNowImpl);
  const targetStatuses = await collectStatuses(allTargets, budget);
  const outsideBefore = await collectStatuses(targets.outsideScope, budget, outsideScopeStatus);
  const providerTempBefore = await workspaceProviderTempStatus({
    root: options.root,
    tempBase: options.providerTempBase,
    processAliveImpl: options.providerProcessAliveImpl,
    platform: options.platform,
    monotonicNowImpl: options.providerInventoryMonotonicNowImpl
  });
  const incomplete = [...targetStatuses, ...outsideBefore].filter((item) => !item.complete);
  if (incomplete.length > 0) {
    const reasons = [...new Set(incomplete.map((item) => item.incomplete_reason))];
    throw new Error(`Buddy data purge refused because data inventory is incomplete: ${reasons.join(', ')}`);
  }
  if (!providerTempBefore.complete) {
    throw new Error('Buddy data purge refused because provider temporary inventory is incomplete');
  }
  if (!providerTempBefore.purge_supported && providerTempBefore.attributed_runs > 0) {
    throw new Error('Buddy data purge refused because provider temporary ownership cannot be proven');
  }

  const turnResult = await pruneWorkspaceTurns({
    root: options.root,
    runtimeDataDir: options.runtimeDataDir,
    now: options.now ?? Date.now(),
    ttlMs: 0,
    contentTtlMs: 0,
    terminalizeIncomplete: true,
    maxEntries: DATA_INVENTORY_ENTRY_LIMIT,
    deadlineMs: options.deadlineMs ?? 60_000,
    leaseStaleMs: options.leaseStaleMs
  });
  if (!turnResult.acquired || turnResult.live > 0 || turnResult.ambiguous > 0 || turnResult.limited) {
    throw new Error(
      `Buddy data purge could not safely quiesce turn state: acquired=${turnResult.acquired}, `
      + `live=${turnResult.live}, ambiguous=${turnResult.ambiguous}, limited=${turnResult.limited}`
    );
  }

  const setupStatus = outsideBefore.find((item) => item.id === 'setup_plans_and_journals');
  const workspaceDetails = await detailsOrMissing(path.resolve(options.root));
  const setupCleanup = setupStatus?.exists
    && workspaceDetails?.isDirectory()
    && !workspaceDetails.isSymbolicLink()
    ? await pruneSetupPlansForWorkspace({
        root: options.root,
        dataDir: options.dataDir,
        nowMs: options.now ?? Date.now()
      })
    : Object.freeze({
        scanned: 0,
        removed: 0,
        preserved: setupStatus?.files ?? 0,
        refused: 0,
        limited: false,
        cleanup_available: !setupStatus?.exists
      });

  const removed = [];
  for (const target of targets.content) {
    if (await removeTarget(target)) removed.push(target.id);
  }
  if (options.includeSettings) {
    // Remove the egress registry last. The public data command calls this
    // function while holding the workspace provider lane and after proving the
    // active registry empty. Once this exact directory is removed, a later
    // provider operation may safely create a new generation of workspace
    // coordination state without being mistaken for pre-purge data.
    const egress = targets.settings.find((target) => target.id === 'egress_registry');
    for (const target of targets.settings.filter((item) => item !== egress)) {
      if (await removeTarget(target)) removed.push(target.id);
    }
    if (egress && await removeTarget(egress)) removed.push(egress.id);
  }
  const providerTemporary = await purgeWorkspaceProviderTempRuns({
    root: options.root,
    tempBase: options.providerTempBase,
    processAliveImpl: options.providerProcessAliveImpl,
    randomBytesImpl: options.providerRandomBytesImpl,
    renameImpl: options.providerRenameImpl,
    removeImpl: options.providerRemoveImpl,
    platform: options.platform,
    monotonicNowImpl: options.providerInventoryMonotonicNowImpl
  });
  const after = await workspaceDataStatus(options);
  return Object.freeze({
    schema_version: '1',
    workspace_key: targets.workspace,
    workspace_root: path.resolve(options.root),
    include_settings: options.includeSettings === true,
    removed: Object.freeze(removed),
    retained_turn_tombstones: after.content.find((item) => item.id === 'turn_state')?.files ?? 0,
    retained_settings_files: after.totals.settings_files,
    remaining_content_files: after.totals.content_files,
    provider_temporary: providerTemporary,
    setup_cleanup: setupCleanup,
    preserved_outside_scope: after.preserved_outside_scope
  });
}
