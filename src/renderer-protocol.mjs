import { randomBytes } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pruneSequencedOutboxEvents, readSequencedOutboxEvents } from './outbox.mjs';
import { escapeTerminalControls } from './policy.mjs';
import {
  ensurePrivateStatePath,
  resolveRuntimeDataDir,
  withFileLock,
  workspaceKey,
  writePrivateJsonAtomic
} from './state.mjs';

const CONSUMER_SCHEMA_VERSION = '1';
const CONSUMER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONSUMER_LOCK_TIMEOUT_MS = 30_000;

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function validateConsumerId(consumerId) {
  if (typeof consumerId !== 'string' || !CONSUMER_ID_PATTERN.test(consumerId)) {
    throw new Error('Buddy renderer consumer id must match [a-z0-9][a-z0-9._-]{0,63}');
  }
  return consumerId;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateConsumer(value, expected) {
  if (value === null) return null;
  assertExactKeys(value, [
    'schema_version', 'consumer_id', 'workspace_key', 'active', 'registered_at', 'updated_at',
    'last_sequence', 'last_event_id', 'pending'
  ], 'Buddy renderer consumer state');
  if (value.schema_version !== CONSUMER_SCHEMA_VERSION
      || value.consumer_id !== expected.consumerId
      || value.workspace_key !== expected.workspace) {
    throw new Error('Buddy renderer consumer state belongs to another identity or schema');
  }
  if (typeof value.active !== 'boolean' || !validTimestamp(value.registered_at) || !validTimestamp(value.updated_at)) {
    throw new Error('Buddy renderer consumer state has invalid lifecycle metadata');
  }
  if (!Number.isSafeInteger(value.last_sequence) || value.last_sequence < 0) {
    throw new Error('Buddy renderer consumer state has an invalid acknowledged sequence');
  }
  if (value.last_event_id !== null && !SHA256_PATTERN.test(value.last_event_id)) {
    throw new Error('Buddy renderer consumer state has an invalid acknowledged event id');
  }
  if (value.pending !== null) {
    assertExactKeys(value.pending, ['token', 'through_sequence', 'through_event_id', 'count', 'has_more'], 'Buddy renderer pending delivery');
    if (!SHA256_PATTERN.test(value.pending.token)
        || !Number.isSafeInteger(value.pending.through_sequence)
        || value.pending.through_sequence <= value.last_sequence
        || !SHA256_PATTERN.test(value.pending.through_event_id)
        || !Number.isInteger(value.pending.count) || value.pending.count < 1 || value.pending.count > 100
        || typeof value.pending.has_more !== 'boolean') {
      throw new Error('Buddy renderer consumer state has an invalid pending delivery');
    }
  }
  return value;
}

async function readConsumerFile(file, expected) {
  let details;
  try {
    details = await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error('Buddy renderer consumer state must be a regular non-symlink file');
  }
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error('Buddy renderer consumer state is not valid JSON', { cause: error });
  }
  return validateConsumer(value, expected);
}

function consumerPaths(options) {
  const consumerId = validateConsumerId(options.consumerId);
  const runtimeRoot = resolveRuntimeDataDir(options.runtimeDataDir);
  const workspace = workspaceKey(options.repositoryRoot);
  const directory = path.join(runtimeRoot, 'renderers', workspace);
  const file = path.join(directory, `${consumerId}.json`);
  return { consumerId, runtimeRoot, workspace, directory, file, workspaceLock: path.join(directory, '_workspace') };
}

async function withConsumer(options, callback) {
  const paths = consumerPaths(options);
  await ensurePrivateStatePath(paths.runtimeRoot, paths.directory);
  return withFileLock(paths.workspaceLock, () => withFileLock(
    paths.file,
    async () => callback(paths, await readConsumerFile(paths.file, paths)),
    {
      timeoutMs: CONSUMER_LOCK_TIMEOUT_MS,
      staleMs: CONSUMER_LOCK_TIMEOUT_MS
    }
  ), {
    timeoutMs: CONSUMER_LOCK_TIMEOUT_MS,
    staleMs: CONSUMER_LOCK_TIMEOUT_MS
  });
}

function publicConsumer(consumer) {
  return {
    schema_version: consumer.schema_version,
    consumer_id: consumer.consumer_id,
    workspace_key: consumer.workspace_key,
    active: consumer.active,
    registered_at: consumer.registered_at,
    updated_at: consumer.updated_at,
    last_sequence: consumer.last_sequence,
    last_event_id: consumer.last_event_id,
    pending: consumer.pending === null ? null : {
      through_sequence: consumer.pending.through_sequence,
      through_event_id: consumer.pending.through_event_id,
      count: consumer.pending.count,
      has_more: consumer.pending.has_more
    }
  };
}

function safeText(value) {
  return value === null ? null : escapeTerminalControls(String(value)).replaceAll('\r', '');
}

function projectReview(review) {
  if (review === null) return null;
  return {
    status: review.status,
    summary: safeText(review.summary),
    findings: review.findings.map((item) => ({
      severity: item.severity,
      confidence: item.confidence,
      title: safeText(item.title),
      body: safeText(item.body),
      path: safeText(item.path),
      line_side: item.line_side ?? 'new',
      line_start: item.line_start,
      line_end: item.line_end,
      recommendation: safeText(item.recommendation)
    })),
    comments: review.comments.map((item) => ({
      category: item.category,
      confidence: item.confidence,
      title: safeText(item.title),
      body: safeText(item.body),
      path: safeText(item.path),
      line_side: item.line_side ?? 'new',
      line_start: item.line_start,
      line_end: item.line_end,
      recommendation: safeText(item.recommendation)
    })),
    provider: safeText(review.provider),
    model: safeText(review.model)
  };
}

function projectReviewerResult(result) {
  if (result === null) return null;
  return {
    status: result.status,
    summary: safeText(result.summary),
    findings: result.findings.map((item) => ({
      severity: item.severity,
      confidence: item.confidence,
      title: safeText(item.title),
      body: safeText(item.body),
      path: safeText(item.path),
      line_side: item.line_side ?? 'new',
      line_start: item.line_start,
      line_end: item.line_end,
      recommendation: safeText(item.recommendation)
    })),
    comments: result.comments.map((item) => ({
      category: item.category,
      confidence: item.confidence,
      title: safeText(item.title),
      body: safeText(item.body),
      path: safeText(item.path),
      line_side: item.line_side ?? 'new',
      line_start: item.line_start,
      line_end: item.line_end,
      recommendation: safeText(item.recommendation)
    }))
  };
}

function projectReviewerOutcome(outcome) {
  return {
    source_index: outcome.source_index,
    provider: safeText(outcome.provider),
    model: safeText(outcome.model),
    status: outcome.status,
    result: projectReviewerResult(outcome.result),
    failure: outcome.failure === null ? null : {
      stage: outcome.failure.stage,
      failure_code: outcome.failure.failure_code,
      message: safeText(outcome.failure.message)
    }
  };
}

function projectEvent(item, includeWorkerSummary) {
  const { event, sequence } = item;
  const reviews = event.payload.reviews === undefined
    ? null
    : event.payload.reviews.map(projectReviewerOutcome);
  const payload = {
    headline: safeText(event.payload.headline),
    detail: safeText(event.payload.detail),
    review: projectReview(event.payload.review),
    reviews,
    reviewer_state: reviews === null
      ? null
      : reviews.every((review) => review.status === 'succeeded') ? 'complete' : 'partial',
    summary_advisory: event.payload.summary_advisory === undefined
      ? null
      : event.payload.summary_advisory,
    companion: event.payload.companion === undefined ? null : event.payload.companion
  };
  if (includeWorkerSummary) payload.worker_summary = safeText(event.payload.worker_summary);
  return {
    schema_version: '1',
    sequence,
    event_schema_version: event.schema_version,
    event_type: event.event_type,
    workspace_key: event.workspace_key,
    session_key: event.session_key,
    turn_key: event.turn_key,
    review_key: event.review_key,
    presentation_state: event.presentation_state,
    payload,
    event_id: event.event_id,
    occurred_at: event.occurred_at
  };
}

export async function registerRendererConsumer(options) {
  return withConsumer(options, async (paths, current) => {
    const now = new Date().toISOString();
    const next = current
      ? { ...current, active: true, updated_at: now }
      : {
          schema_version: CONSUMER_SCHEMA_VERSION,
          consumer_id: paths.consumerId,
          workspace_key: paths.workspace,
          active: true,
          registered_at: now,
          updated_at: now,
          last_sequence: 0,
          last_event_id: null,
          pending: null
        };
    await writePrivateJsonAtomic(paths.file, next);
    return publicConsumer(next);
  });
}

export async function readRendererEvents(options) {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Buddy renderer event limit must be between 1 and 100');
  }
  if (options.includeWorkerSummary !== undefined && typeof options.includeWorkerSummary !== 'boolean') {
    throw new Error('Buddy renderer worker-summary option must be boolean');
  }
  return withConsumer(options, async (paths, current) => {
    if (!current) throw new Error(`Buddy renderer consumer ${paths.consumerId} is not registered`);
    if (!current.active) throw new Error(`Buddy renderer consumer ${paths.consumerId} is unregistered`);

    let pending = current.pending;
    let batch;
    if (pending) {
      batch = await readSequencedOutboxEvents({
        repositoryRoot: options.repositoryRoot,
        runtimeDataDir: options.runtimeDataDir,
        afterSequence: current.last_sequence,
        throughSequence: pending.through_sequence,
        limit: pending.count
      });
      const last = batch.events.at(-1);
      if (batch.events.length !== pending.count || !last
          || last.sequence !== pending.through_sequence
          || last.event.event_id !== pending.through_event_id) {
        throw new Error('Buddy renderer pending delivery no longer matches the immutable outbox');
      }
    } else {
      batch = await readSequencedOutboxEvents({
        repositoryRoot: options.repositoryRoot,
        runtimeDataDir: options.runtimeDataDir,
        afterSequence: current.last_sequence,
        limit
      });
      const last = batch.events.at(-1);
      if (last) {
        pending = {
          token: randomBytes(32).toString('hex'),
          through_sequence: last.sequence,
          through_event_id: last.event.event_id,
          count: batch.events.length,
          has_more: batch.has_more
        };
        await writePrivateJsonAtomic(paths.file, {
          ...current,
          pending,
          updated_at: new Date().toISOString()
        });
      }
    }

    return {
      schema_version: '1',
      consumer_id: paths.consumerId,
      workspace_key: paths.workspace,
      events: batch.events.map((item) => projectEvent(item, options.includeWorkerSummary === true)),
      cursor: pending?.token ?? null,
      has_more: pending?.has_more ?? false
    };
  });
}

export async function acknowledgeRendererEvents(options) {
  if (typeof options.cursor !== 'string' || !SHA256_PATTERN.test(options.cursor)) {
    throw new Error('Buddy renderer acknowledgement requires an opaque cursor token');
  }
  return withConsumer(options, async (paths, current) => {
    if (!current) throw new Error(`Buddy renderer consumer ${paths.consumerId} is not registered`);
    if (!current.active) throw new Error(`Buddy renderer consumer ${paths.consumerId} is unregistered`);
    if (!current.pending || current.pending.token !== options.cursor) {
      throw new Error('Buddy renderer acknowledgement cursor is unknown, stale, or forged');
    }
    const next = {
      ...current,
      last_sequence: current.pending.through_sequence,
      last_event_id: current.pending.through_event_id,
      pending: null,
      updated_at: new Date().toISOString()
    };
    await writePrivateJsonAtomic(paths.file, next);
    return publicConsumer(next);
  });
}

export async function rendererConsumerStatus(options) {
  return withConsumer(options, async (paths, current) => {
    if (!current) throw new Error(`Buddy renderer consumer ${paths.consumerId} is not registered`);
    return publicConsumer(current);
  });
}

export async function unregisterRendererConsumer(options) {
  return withConsumer(options, async (paths, current) => {
    if (!current) throw new Error(`Buddy renderer consumer ${paths.consumerId} is not registered`);
    const next = { ...current, active: false, pending: null, updated_at: new Date().toISOString() };
    await writePrivateJsonAtomic(paths.file, next);
    return publicConsumer(next);
  });
}

export async function pruneAcknowledgedRendererEvents(options) {
  const runtimeRoot = resolveRuntimeDataDir(options.runtimeDataDir);
  const workspace = workspaceKey(options.repositoryRoot);
  const directory = path.join(runtimeRoot, 'renderers', workspace);
  await ensurePrivateStatePath(runtimeRoot, directory);
  return withFileLock(path.join(directory, '_workspace'), async () => {
    const entries = await readdir(directory, { withFileTypes: true });
    const consumers = [];
    for (const entry of entries) {
      if (entry.name.endsWith('.lock')) continue;
      const match = entry.name.match(/^([a-z0-9][a-z0-9._-]{0,63})\.json$/);
      if (!match || entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`Buddy renderer state contains an unsupported entry: ${entry.name}`);
      }
      consumers.push(await readConsumerFile(path.join(directory, entry.name), {
        consumerId: match[1],
        workspace
      }));
    }
    const active = consumers.filter((consumer) => consumer.active);
    if (!active.length) {
      return {
        dry_run: options.dryRun !== false,
        through_sequence: 0,
        eligible_count: 0,
        pruned_count: 0,
        blocked_reason: 'no_active_consumers'
      };
    }
    const throughSequence = Math.min(...active.map((consumer) => consumer.last_sequence));
    return pruneSequencedOutboxEvents({
      repositoryRoot: options.repositoryRoot,
      runtimeDataDir: options.runtimeDataDir,
      throughSequence,
      minAgeMs: options.minAgeMs,
      now: options.now,
      dryRun: options.dryRun
    });
  }, { timeoutMs: CONSUMER_LOCK_TIMEOUT_MS, staleMs: CONSUMER_LOCK_TIMEOUT_MS });
}

export const RENDERER_CONSUMER_SCHEMA_VERSION = CONSUMER_SCHEMA_VERSION;
