import { lstat, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { pruneExpiredOutboxEvents } from './outbox.mjs';

import {
  acquireFileLease,
  ensurePrivateStatePath,
  opaqueKey,
  readPrivateJson,
  releaseFileLease,
  resolveRuntimeDataDir,
  workspaceKey,
  writePrivateJsonExclusive
} from './state.mjs';

export const DEFAULT_CONTENT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_TTL_MS = DEFAULT_CONTENT_TTL_MS;
const REVIEW_KEY_PATTERN = /^[0-9a-f]{64}$/;

async function regularFileOrMissing(file) {
  try {
    const details = await lstat(file);
    return details.isFile() && !details.isSymbolicLink() ? 'file' : 'unsafe';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function safeJson(file) {
  const kind = await regularFileOrMissing(file);
  if (kind === 'missing') return { kind, value: null };
  if (kind === 'unsafe') return { kind, value: null };
  try {
    return { kind, value: await readPrivateJson(file) };
  } catch {
    return { kind: 'malformed', value: null };
  }
}

async function staleTimestamp(baselineFile, baseline, now, ttlMs) {
  const captured = Date.parse(baseline?.snapshot?.captured_at ?? '');
  if (Number.isFinite(captured)) return now - captured >= ttlMs;
  const details = await stat(baselineFile).catch(() => null);
  return details ? now - details.mtimeMs >= ttlMs : false;
}

function receiptExpiryAnchor(completed) {
  const observed = Date.parse(completed?.presentation_observed_at ?? '');
  if (Number.isFinite(observed)) return observed;
  const completedAt = Date.parse(completed?.completed_at ?? '');
  return Number.isFinite(completedAt) ? completedAt : null;
}

async function pruneExpiredReceipt(completed, options) {
  if (!completed) return { pruned: false, ambiguous: false };
  const reviewKey = completed.review_key;
  if (reviewKey !== undefined && !REVIEW_KEY_PATTERN.test(reviewKey)) {
    return { pruned: false, ambiguous: true };
  }
  if (!REVIEW_KEY_PATTERN.test(reviewKey ?? '')) return { pruned: false, ambiguous: false };
  const anchor = receiptExpiryAnchor(completed);
  if (anchor === null) return { pruned: false, ambiguous: true };
  if (options.now - anchor < options.contentTtlMs) return { pruned: false, ambiguous: false };

  const receipt = path.join(options.receiptDirectory, `${reviewKey}.json`);
  const kind = await regularFileOrMissing(receipt);
  if (kind === 'unsafe') return { pruned: false, ambiguous: true };
  if (kind === 'missing') return { pruned: false, ambiguous: false };
  await rm(receipt, { force: true });
  return { pruned: true, ambiguous: false };
}

async function pruneUnclaimedReceipts(receiptDirectory, options) {
  let directoryDetails;
  try {
    directoryDetails = await lstat(receiptDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return { pruned: 0, ambiguous: 0 };
    throw error;
  }
  if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) {
    return { pruned: 0, ambiguous: 1 };
  }
  const candidates = [];
  for (const entry of await readdir(receiptDirectory, { withFileTypes: true })) {
    const match = entry.name.match(/^([0-9a-f]{64})\.json$/);
    if (!match || entry.isSymbolicLink() || !entry.isFile()) return { pruned: 0, ambiguous: 1 };
    if (options.protectedReceiptKeys.has(match[1])) continue;
    const file = path.join(receiptDirectory, entry.name);
    const details = await lstat(file);
    if (details.isSymbolicLink() || !details.isFile()) return { pruned: 0, ambiguous: 1 };
    if (options.now - details.mtimeMs >= options.contentTtlMs) candidates.push(file);
  }
  for (const file of candidates) await rm(file, { force: true });
  return { pruned: candidates.length, ambiguous: 0 };
}

async function safeRemoveSnapshot(turnDir) {
  const snapshotDir = path.join(turnDir, 'snapshot');
  try {
    const details = await lstat(snapshotDir);
    if (details.isSymbolicLink() || !details.isDirectory()) return false;
    await rm(snapshotDir, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') return false;
  }
  await rm(path.join(turnDir, 'baseline.json'), { force: true });
  await rm(path.join(turnDir, 'attempt.json'), { force: true });
  return true;
}

async function pruneTurn(turnDir, options) {
  let stopLease;
  try {
    stopLease = await acquireFileLease(path.join(turnDir, 'stop'), {
      wait: false,
      staleMs: options.leaseStaleMs
    });
  } catch {
    return { outcome: 'ambiguous', receiptPruned: 0 };
  }
  if (!stopLease) return { outcome: 'live', receiptPruned: 0 };

  try {
    const baselineFile = path.join(turnDir, 'baseline.json');
    const attemptFile = path.join(turnDir, 'attempt.json');
    const completedFile = path.join(turnDir, 'completed.json');
    const [baseline, attempt, completed] = await Promise.all([
      safeJson(baselineFile),
      safeJson(attemptFile),
      safeJson(completedFile)
    ]);
    if ([baseline, attempt, completed].some((item) => ['unsafe', 'malformed'].includes(item.kind))) {
      return { outcome: 'ambiguous', receiptPruned: 0 };
    }

    const receipt = await pruneExpiredReceipt(completed.value, options);
    if (receipt.ambiguous) return { outcome: 'ambiguous', receiptPruned: 0 };
    if (!receipt.pruned && REVIEW_KEY_PATTERN.test(completed.value?.review_key ?? '')) {
      options.protectedReceiptKeys.add(completed.value.review_key);
    }
    if (!baseline.value) {
      if (options.terminalizeIncomplete) {
        if (!completed.value) {
          const reviewKey = REVIEW_KEY_PATTERN.test(attempt.value?.review_key ?? '') ? attempt.value.review_key : null;
          await writePrivateJsonExclusive(completedFile, {
            schema_version: '1',
            ...(reviewKey ? { review_key: reviewKey } : {}),
            terminal_status: attempt.value ? 'prior_attempt_incomplete' : 'data_purged',
            presentation_status: 'terminal',
            completed_at: new Date(options.now).toISOString()
          });
        }
        return await safeRemoveSnapshot(turnDir)
          ? { outcome: 'pruned', receiptPruned: receipt.pruned ? 1 : 0 }
          : { outcome: 'ambiguous', receiptPruned: receipt.pruned ? 1 : 0 };
      }
      return { outcome: receipt.pruned ? 'content_pruned' : 'empty', receiptPruned: receipt.pruned ? 1 : 0 };
    }
    if (!await staleTimestamp(baselineFile, baseline.value, options.now, options.ttlMs)) {
      return { outcome: receipt.pruned ? 'content_pruned' : 'fresh', receiptPruned: receipt.pruned ? 1 : 0 };
    }

    if (!completed.value) {
      const reviewKey = REVIEW_KEY_PATTERN.test(attempt.value?.review_key ?? '') ? attempt.value.review_key : null;
      await writePrivateJsonExclusive(completedFile, {
        schema_version: '1',
        ...(reviewKey ? { review_key: reviewKey } : {}),
        terminal_status: attempt.value ? 'prior_attempt_incomplete' : 'baseline_expired',
        presentation_status: 'terminal',
        completed_at: new Date(options.now).toISOString()
      });
    }
    return await safeRemoveSnapshot(turnDir)
      ? { outcome: 'pruned', receiptPruned: receipt.pruned ? 1 : 0 }
      : { outcome: 'ambiguous', receiptPruned: receipt.pruned ? 1 : 0 };
  } finally {
    await releaseFileLease(stopLease);
  }
}

export async function pruneWorkspaceTurns(options) {
  const runtimeRoot = resolveRuntimeDataDir(options.runtimeDataDir);
  const workspace = workspaceKey(options.root);
  const workspaceDir = path.join(runtimeRoot, 'turns', workspace);
  const receiptDirectory = path.join(runtimeRoot, 'automatic-reviews', workspace);
  await ensurePrivateStatePath(runtimeRoot, workspaceDir);
  const lease = await acquireFileLease(path.join(workspaceDir, 'prune'), {
    wait: false,
    staleMs: options.leaseStaleMs ?? 60_000
  });
  if (!lease) {
    return {
      acquired: false, scanned: 0, pruned: 0, receiptPruned: 0,
      outboxPruned: 0, retainedLegacyOutbox: 0, live: 0, ambiguous: 0, limited: false
    };
  }

  const deadline = Date.now() + (options.deadlineMs ?? 500);
  const maxEntries = options.maxEntries ?? 1_000;
  const skipSession = options.sessionId === undefined ? null : opaqueKey(options.sessionId);
  const skipTurn = options.turnId === undefined ? null : opaqueKey(options.turnId);
  let scanned = 0;
  let pruned = 0;
  let receiptPruned = 0;
  let ambiguous = 0;
  let limited = false;
  let outboxPruned = 0;
  let retainedLegacyOutbox = 0;
  let live = 0;
  const protectedReceiptKeys = new Set();
  try {
    const sessions = await readdir(workspaceDir, { withFileTypes: true });
    outer: for (const session of sessions) {
      if (!session.isDirectory() || session.isSymbolicLink() || session.name.endsWith('.lock')) continue;
      const sessionDir = path.join(workspaceDir, session.name);
      const turns = await readdir(sessionDir, { withFileTypes: true }).catch(() => []);
      for (const turn of turns) {
        if (!turn.isDirectory() || turn.isSymbolicLink()) continue;
        if (session.name === skipSession && turn.name === skipTurn) continue;
        if (scanned >= maxEntries || Date.now() >= deadline) {
          limited = true;
          break outer;
        }
        scanned += 1;
        const turnResult = await pruneTurn(path.join(sessionDir, turn.name), {
          now: options.now ?? Date.now(),
          ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
          contentTtlMs: options.contentTtlMs ?? DEFAULT_CONTENT_TTL_MS,
          receiptDirectory,
          protectedReceiptKeys,
          terminalizeIncomplete: options.terminalizeIncomplete === true,
          leaseStaleMs: options.leaseStaleMs ?? 60_000
        });
        if (turnResult.outcome === 'pruned') pruned += 1;
        receiptPruned += turnResult.receiptPruned;
        if (turnResult.outcome === 'ambiguous') ambiguous += 1;
        if (turnResult.outcome === 'live') live += 1;
      }
    }
    if (!limited && live === 0 && ambiguous === 0) {
      const orphanReceipts = await pruneUnclaimedReceipts(receiptDirectory, {
        now: options.now ?? Date.now(),
        contentTtlMs: options.contentTtlMs ?? DEFAULT_CONTENT_TTL_MS,
        protectedReceiptKeys
      });
      receiptPruned += orphanReceipts.pruned;
      ambiguous += orphanReceipts.ambiguous;
    }
    const outbox = await pruneExpiredOutboxEvents({
      repositoryRoot: options.root,
      runtimeDataDir: options.runtimeDataDir,
      minAgeMs: options.contentTtlMs ?? DEFAULT_CONTENT_TTL_MS,
      now: options.now ?? Date.now(),
      dryRun: false
    });
    outboxPruned = outbox.pruned_count;
    retainedLegacyOutbox = outbox.retained_legacy_count;
    return {
      acquired: true, scanned, pruned, receiptPruned, outboxPruned,
      retainedLegacyOutbox, live, ambiguous, limited
    };
  } finally {
    await releaseFileLease(lease);
  }
}
