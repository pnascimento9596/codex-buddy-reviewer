import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendOutboxEvent, PET_EVENT_CONTRACT, readSequencedOutboxEvents } from '../src/outbox.mjs';
import {
  parseRendererArgs,
  RENDERER_HELP,
  renderRendererCommand,
  runRendererCommand
} from '../src/renderer-cli.mjs';
import {
  acknowledgeRendererEvents,
  pruneAcknowledgedRendererEvents,
  readRendererEvents,
  registerRendererConsumer,
  rendererConsumerStatus,
  unregisterRendererConsumer
} from '../src/renderer-protocol.mjs';
import { canonicalJson, opaqueKey, workspaceKey } from '../src/state.mjs';

const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function eventOptions(repositoryRoot, runtimeDataDir, overrides = {}) {
  return {
    repositoryRoot,
    runtimeDataDir,
    sessionId: 'renderer-session',
    turnId: 'renderer-turn',
    type: 'turn_started',
    state: 'working',
    headline: 'Buddy is working',
    detail: 'A bounded local event.',
    workerSummary: 'Private worker summary',
    occurredAt: '2026-07-18T12:00:00.000Z',
    ...overrides
  };
}

test('checked-in pet event schema stays aligned with runtime protocol classifications', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/pet-event.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.oneOf, [{ $ref: '#/$defs/eventV1' }, { $ref: '#/$defs/eventV2' }]);
  assert.deepEqual(
    [schema.$defs.eventV1.properties.schema_version.const, schema.$defs.eventV2.properties.schema_version.const],
    PET_EVENT_CONTRACT.schemaVersions
  );
  assert.deepEqual(schema.$defs.eventType.enum, PET_EVENT_CONTRACT.eventTypes);
    assert.deepEqual(schema.$defs.presentationState.enum, PET_EVENT_CONTRACT.presentationStates);
    assert.deepEqual(schema.$defs.review.properties.status.enum, PET_EVENT_CONTRACT.reviewStatuses);
    assert.deepEqual(
      schema.$defs.failedReviewerOutcome.properties.status.enum,
      PET_EVENT_CONTRACT.reviewerOutcomeStatuses.filter((status) => status !== 'succeeded')
    );
    assert.equal(schema.$defs.payloadV2.properties.reviews.maxItems, 2);
    assert.equal(schema.$defs.reviewerResult.properties.findings.maxItems, 3);
    assert.equal(schema.$defs.reviewerResult.properties.comments.maxItems, 2);
  assert.deepEqual(schema.$defs.finding.properties.severity.enum, PET_EVENT_CONTRACT.severities);
  assert.deepEqual(schema.$defs.comment.properties.category.enum, PET_EVENT_CONTRACT.commentCategories);
  assert.deepEqual(schema.$defs.summaryAdvisory.properties.status.enum, PET_EVENT_CONTRACT.summaryAdvisoryStatuses);
  assert.deepEqual(
    schema.$defs.summaryAdvisory.properties.notes.items.properties.category.enum,
    PET_EVENT_CONTRACT.summaryNoteCategories
  );
  assert.deepEqual(schema.$defs.companion.properties.personality.enum, PET_EVENT_CONTRACT.presentationPersonalities);
  assert.equal(schema.$defs.eventV2.properties.sequence.minimum, 1);
  assert.equal(schema.$defs.payloadV2.properties.worker_summary.maxLength, 4000);
  assert.equal(schema.$defs.review.properties.findings.maxItems, 5);
  assert.equal(schema.$defs.review.properties.comments.maxItems, 3);
});

async function writeLegacyEvent(repositoryRoot, runtimeDataDir, overrides = {}) {
  const options = eventOptions(repositoryRoot, runtimeDataDir, overrides);
  const review = options.result ? {
    status: options.result.status,
    summary: options.result.summary,
    findings: (options.result.findings ?? []).map((finding) => ({
      severity: finding.severity,
      confidence: finding.confidence,
      title: finding.title,
      body: finding.body,
      path: finding.path,
      line_start: finding.line_start,
      line_end: finding.line_end,
      recommendation: finding.recommendation
    })),
    comments: (options.result.comments ?? []).map((comment) => ({
      category: comment.category,
      confidence: comment.confidence,
      title: comment.title,
      body: comment.body,
      path: comment.path,
      line_start: comment.line_start,
      line_end: comment.line_end,
      recommendation: comment.recommendation
    })),
    provider: options.provider ?? null,
    model: options.model ?? null
  } : null;
  const identity = {
    schema_version: '1',
    event_type: options.type,
    workspace_key: workspaceKey(repositoryRoot),
    session_key: opaqueKey(options.sessionId),
    turn_key: opaqueKey(options.turnId),
    review_key: options.reviewKey ?? null,
    presentation_state: options.state,
    payload: {
      headline: options.headline ?? null,
      detail: options.detail ?? null,
      worker_summary: options.workerSummary ?? null,
      review
    }
  };
  const id = createHash('sha256').update(canonicalJson(identity)).digest('hex');
  const event = { ...identity, event_id: id, occurred_at: options.occurredAt };
  const directory = path.join(runtimeDataDir, 'outbox', identity.workspace_key, identity.session_key);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}.json`);
  await writeFile(file, `${JSON.stringify(event, null, 2)}\n`, { mode: 0o600 });
  return { event, file };
}

test('stored outbox events reject credential-shaped reviewer models before renderer delivery', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-renderer-model-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-renderer-model-data-');
  const model = ['sk', '-ant', '-api', '03-', 'A9_bC7', '-dE5_fG', '3-hJ1_k', 'L8mN6pQ'].join('');
  await writeLegacyEvent(repositoryRoot, runtimeDataDir, {
    type: 'review_completed',
    state: 'success',
    result: { status: 'no_findings', summary: 'Legacy result.', findings: [], comments: [] },
    provider: 'claude',
    model
  });
  await assert.rejects(
    readSequencedOutboxEvents({ repositoryRoot, runtimeDataDir }),
    (error) => /model is invalid or contains credential material/.test(error.message)
      && !error.message.includes(model)
  );
});

test('v2 sequencing preserves immutable v1 bytes and builds a deterministic legacy index', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-renderer-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-renderer-data-');
  const timestamp = '2026-07-18T10:00:00.000Z';
  const legacyA = await writeLegacyEvent(repositoryRoot, runtimeDataDir, {
    sessionId: 'legacy-session-a', turnId: 'legacy-turn-a', detail: 'Legacy A', occurredAt: timestamp
  });
  const legacyB = await writeLegacyEvent(repositoryRoot, runtimeDataDir, {
    sessionId: 'legacy-session-b', turnId: 'legacy-turn-b', detail: 'Legacy B', occurredAt: timestamp
  });
  const beforeA = await readFile(legacyA.file);
  const beforeB = await readFile(legacyB.file);

  const v2Options = eventOptions(repositoryRoot, runtimeDataDir, {
    sessionId: 'v2-session', turnId: 'v2-turn', type: 'review_started', state: 'reviewing', detail: 'V2'
  });
  const first = await appendOutboxEvent(v2Options);
  const duplicate = await appendOutboxEvent({ ...v2Options, occurredAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(first.event.schema_version, '2');
  assert.equal(first.event.sequence, 3);
  assert.equal(first.event.event_id, duplicate.event.event_id);
  assert.equal(first.event.sequence, duplicate.event.sequence);
  assert.equal(first.file, duplicate.file);
  assert.deepEqual(await readFile(legacyA.file), beforeA);
  assert.deepEqual(await readFile(legacyB.file), beforeB);

  const read = await readSequencedOutboxEvents({ repositoryRoot, runtimeDataDir });
  assert.deepEqual(read.events.map((item) => item.sequence), [1, 2, 3]);
  const expectedLegacyOrder = [legacyA.event.event_id, legacyB.event.event_id].sort();
  assert.deepEqual(read.events.slice(0, 2).map((item) => item.event.event_id), expectedLegacyOrder);

  const protocolRoot = path.join(runtimeDataDir, 'outbox', workspaceKey(repositoryRoot), '_protocol');
  const legacyIndex = JSON.parse(await readFile(path.join(protocolRoot, 'legacy-index.json'), 'utf8'));
  assert.deepEqual(legacyIndex.entries.map((entry) => entry.event_id), expectedLegacyOrder);
  assert.deepEqual(legacyIndex.entries.map((entry) => entry.sequence), [1, 2]);
});

test('a cross-version retry adopts the exact immutable v1 semantic event without a second render', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-renderer-retry-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-renderer-retry-data-');
  const options = eventOptions(repositoryRoot, runtimeDataDir, {
    type: 'review_completed',
    state: 'findings',
    result: {
      status: 'findings',
      summary: 'One bounded finding.',
      findings: [{
        severity: 'medium', confidence: 0.9, title: 'Fixture finding', body: 'Fixture body.',
        path: 'src/example.mjs', line_side: 'new', line_start: 1, line_end: 1,
        recommendation: 'Apply the fixture repair.'
      }],
      comments: []
    },
    provider: 'grok',
    model: 'grok-4.5',
    summaryAdvisory: { status: 'no_notes', advisory: 'No notes.', notes: [] },
    companion: {
      pet_id: 'buddy-byte', personality: 'precise', mood: 'ready', xp: 10,
      completed_reviews: 1, utterance: 'Review complete.'
    }
  });
  const legacy = await writeLegacyEvent(repositoryRoot, runtimeDataDir, options);
  const legacyBytes = await readFile(legacy.file);

  const retried = await appendOutboxEvent({ ...options, occurredAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(retried.event.schema_version, '1');
  assert.equal(retried.event.event_id, legacy.event.event_id);
  assert.equal(retried.file, legacy.file);
  assert.deepEqual(await readFile(legacy.file), legacyBytes);
  const sequenced = await readSequencedOutboxEvents({ repositoryRoot, runtimeDataDir });
  assert.equal(sequenced.events.length, 1);
  assert.equal(sequenced.events[0].sequence, 1);

  const consumer = { repositoryRoot, runtimeDataDir, consumerId: 'cross-version-renderer' };
  await registerRendererConsumer(consumer);
  const delivered = await readRendererEvents(consumer);
  assert.equal(delivered.events.length, 1);
  assert.equal(delivered.events[0].event_id, legacy.event.event_id);
  await acknowledgeRendererEvents({ ...consumer, cursor: delivered.cursor });
  assert.deepEqual((await readRendererEvents(consumer)).events, []);
});

test('concurrent v2 publishers receive unique workspace-monotonic sequences', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-renderer-concurrent-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-renderer-concurrent-data-');
  const published = await Promise.all(Array.from({ length: 12 }, (_, index) => appendOutboxEvent(
    eventOptions(repositoryRoot, runtimeDataDir, {
      sessionId: `session-${index % 3}`,
      turnId: `turn-${index}`,
      detail: `event-${index}`
    })
  )));
  assert.equal(new Set(published.map((item) => item.event.event_id)).size, 12);
  assert.deepEqual(published.map((item) => item.event.sequence).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1));
  const read = await readSequencedOutboxEvents({ repositoryRoot, runtimeDataDir });
  assert.deepEqual(read.events.map((item) => item.sequence), Array.from({ length: 12 }, (_, index) => index + 1));
});

test('a late immutable v1 event is indexed after the v2 high-water mark without collision', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-renderer-late-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-renderer-late-data-');
  const v2 = await appendOutboxEvent(eventOptions(repositoryRoot, runtimeDataDir));
  assert.equal(v2.event.sequence, 1);
  const legacy = await writeLegacyEvent(repositoryRoot, runtimeDataDir, {
    sessionId: 'late-v1-session', turnId: 'late-v1-turn', detail: 'late legacy event'
  });
  const read = await readSequencedOutboxEvents({ repositoryRoot, runtimeDataDir });
  assert.deepEqual(read.events.map((item) => item.sequence), [1, 2]);
  assert.equal(read.events[1].event.event_id, legacy.event.event_id);
  assert.equal(read.events[1].event.schema_version, '1');
});

test('renderer delivery is explicit pull and ack with private summaries default-denied', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-renderer-consumer-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-renderer-consumer-data-');
  await appendOutboxEvent(eventOptions(repositoryRoot, runtimeDataDir, { detail: 'first' }));
  await appendOutboxEvent(eventOptions(repositoryRoot, runtimeDataDir, { turnId: 'second-turn', detail: 'second' }));
  const shared = { repositoryRoot, runtimeDataDir, consumerId: 'desktop-buddy' };

  const registered = await registerRendererConsumer(shared);
  assert.equal(registered.active, true);
  const first = await readRendererEvents({ ...shared, limit: 1 });
  assert.equal(first.events.length, 1);
  assert.equal(Object.hasOwn(first.events[0].payload, 'worker_summary'), false);
  assert.match(first.cursor, /^[0-9a-f]{64}$/);
  assert.equal(first.has_more, true);

  const redelivery = await readRendererEvents({ ...shared, limit: 100, includeWorkerSummary: true });
  assert.equal(redelivery.cursor, first.cursor);
  assert.equal(redelivery.events.length, 1);
  assert.equal(redelivery.events[0].payload.worker_summary, null);
  assert.equal(redelivery.has_more, true);
  await assert.rejects(
    acknowledgeRendererEvents({ ...shared, cursor: 'f'.repeat(64) }),
    /unknown, stale, or forged/
  );
  const acknowledged = await acknowledgeRendererEvents({ ...shared, cursor: first.cursor });
  assert.equal(acknowledged.last_sequence, 1);
  assert.equal(acknowledged.pending, null);

  const second = await readRendererEvents({ ...shared, limit: 20 });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].sequence, 2);
  const unregistered = await unregisterRendererConsumer(shared);
  assert.equal(unregistered.active, false);
  assert.equal(unregistered.pending, null);
  assert.equal(unregistered.last_sequence, 1);
  await assert.rejects(readRendererEvents(shared), /unregistered/);
  await assert.rejects(acknowledgeRendererEvents({ ...shared, cursor: second.cursor }), /unregistered/);

  const resumed = await registerRendererConsumer(shared);
  assert.equal(resumed.active, true);
  assert.equal(resumed.pending, null);
  assert.equal(resumed.last_sequence, 1);
  const resumedDelivery = await readRendererEvents(shared);
  assert.notEqual(resumedDelivery.cursor, second.cursor);
  assert.equal(resumedDelivery.events[0].sequence, 2);
  await assert.rejects(
    acknowledgeRendererEvents({ ...shared, cursor: second.cursor }),
    /unknown, stale, or forged/
  );
  await acknowledgeRendererEvents({ ...shared, cursor: resumedDelivery.cursor });
  const empty = await readRendererEvents(shared);
  assert.deepEqual(empty.events, []);
  assert.equal(empty.cursor, null);
  assert.equal((await rendererConsumerStatus(shared)).last_sequence, 2);
});

test('renderer can expose a retained legacy v1 summary only after explicit local opt-in', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-renderer-legacy-summary-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-renderer-legacy-summary-data-');
  await writeLegacyEvent(repositoryRoot, runtimeDataDir, {
    sessionId: 'legacy-summary-session',
    turnId: 'legacy-summary-turn'
  });
  const shared = { repositoryRoot, runtimeDataDir, consumerId: 'legacy-desktop-buddy' };

  await registerRendererConsumer(shared);
  const denied = await readRendererEvents(shared);
  assert.equal(Object.hasOwn(denied.events[0].payload, 'worker_summary'), false);

  const explicitlyIncluded = await readRendererEvents({ ...shared, includeWorkerSummary: true });
  assert.equal(explicitlyIncluded.cursor, denied.cursor);
  assert.equal(explicitlyIncluded.events[0].event_schema_version, '1');
  assert.equal(explicitlyIncluded.events[0].payload.worker_summary, 'Private worker summary');
});

test('unregister clears a pending cursor so a pruned event cannot resurrect on re-register', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-renderer-unregister-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-renderer-unregister-data-');
  await appendOutboxEvent(eventOptions(repositoryRoot, runtimeDataDir));
  const deliveryConsumer = { repositoryRoot, runtimeDataDir, consumerId: 'delivery-renderer' };
  const retentionConsumer = { repositoryRoot, runtimeDataDir, consumerId: 'retention-renderer' };
  await registerRendererConsumer(deliveryConsumer);
  await registerRendererConsumer(retentionConsumer);
  const pending = await readRendererEvents(deliveryConsumer);
  const retained = await readRendererEvents(retentionConsumer);
  await acknowledgeRendererEvents({ ...retentionConsumer, cursor: retained.cursor });

  const unregistered = await unregisterRendererConsumer(deliveryConsumer);
  assert.equal(unregistered.pending, null);
  assert.equal(unregistered.last_sequence, 0);
  const pruned = await pruneAcknowledgedRendererEvents({
    repositoryRoot,
    runtimeDataDir,
    minAgeMs: 0,
    now: Date.parse('2026-07-20T00:00:00Z'),
    dryRun: false
  });
  assert.equal(pruned.pruned_count, 1);

  const registered = await registerRendererConsumer(deliveryConsumer);
  assert.equal(registered.pending, null);
  assert.equal(registered.last_sequence, 0);
  const empty = await readRendererEvents(deliveryConsumer);
  assert.deepEqual(empty.events, []);
  assert.equal(empty.cursor, null);
  await assert.rejects(
    acknowledgeRendererEvents({ ...deliveryConsumer, cursor: pending.cursor }),
    /unknown, stale, or forged/
  );
});

test('retention prunes only aged v2 events acknowledged by every active consumer', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-renderer-prune-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-renderer-prune-data-');
  await appendOutboxEvent(eventOptions(repositoryRoot, runtimeDataDir, { detail: 'first' }));
  await appendOutboxEvent(eventOptions(repositoryRoot, runtimeDataDir, { turnId: 'second', detail: 'second' }));
  const firstConsumer = { repositoryRoot, runtimeDataDir, consumerId: 'first-renderer' };
  const secondConsumer = { repositoryRoot, runtimeDataDir, consumerId: 'offline-renderer' };
  await registerRendererConsumer(firstConsumer);
  await registerRendererConsumer(secondConsumer);
  const firstBatch = await readRendererEvents({ ...firstConsumer, limit: 2 });
  await acknowledgeRendererEvents({ ...firstConsumer, cursor: firstBatch.cursor });
  const secondBatch = await readRendererEvents({ ...secondConsumer, limit: 1 });
  await acknowledgeRendererEvents({ ...secondConsumer, cursor: secondBatch.cursor });

  const dryRun = await pruneAcknowledgedRendererEvents({
    repositoryRoot, runtimeDataDir, minAgeMs: 0, now: Date.parse('2026-07-20T00:00:00Z')
  });
  assert.equal(dryRun.through_sequence, 1);
  assert.equal(dryRun.eligible_count, 1);
  assert.equal(dryRun.pruned_count, 0);
  const applied = await pruneAcknowledgedRendererEvents({
    repositoryRoot, runtimeDataDir, minAgeMs: 0, now: Date.parse('2026-07-20T00:00:00Z'), dryRun: false
  });
  assert.equal(applied.pruned_count, 1);
  assert.deepEqual(
    (await readSequencedOutboxEvents({ repositoryRoot, runtimeDataDir })).events.map((item) => item.sequence),
    [2]
  );

  await unregisterRendererConsumer(secondConsumer);
  const released = await pruneAcknowledgedRendererEvents({
    repositoryRoot, runtimeDataDir, minAgeMs: 0, now: Date.parse('2026-07-20T00:00:00Z'), dryRun: false
  });
  assert.equal(released.through_sequence, 2);
  assert.equal(released.pruned_count, 1);
  assert.deepEqual((await readSequencedOutboxEvents({ repositoryRoot, runtimeDataDir })).events, []);
});

test('renderer CLI grammar is closed and the headless next response stays machine-readable', async () => {
  assert.match(RENDERER_HELP, /New v2 events never persist worker summaries/);
  assert.match(RENDERER_HELP, /cannot extend the 24-hour content limit/);
  assert.match(RENDERER_HELP, /hard-expires aged\s+v1 and v2 content even when no renderer is registered/);
  assert.deepEqual(parseRendererArgs(['register', '--consumer', 'desktop-buddy']), {
    action: 'register', json: false, includeWorkerSummary: false, consumerId: 'desktop-buddy'
  });
  assert.deepEqual(parseRendererArgs(['prune', '--dry-run']), {
    action: 'prune', json: false, includeWorkerSummary: false, dryRun: true
  });
  assert.deepEqual(parseRendererArgs(['prune', '--apply']), {
    action: 'prune', json: false, includeWorkerSummary: false, dryRun: false
  });
  assert.throws(() => parseRendererArgs(['prune', '--consumer', 'desktop-buddy']), /unknown renderer argument|consumer/);
  assert.throws(() => parseRendererArgs(['next']), /requires --consumer/);
  assert.throws(() => parseRendererArgs(['status', '--consumer', 'desktop-buddy', '--limit', '2']), /allowed only/);
  assert.throws(() => parseRendererArgs(['register', '--consumer', 'desktop-buddy', '--include-worker-summary']), /allowed only/);
  assert.throws(() => parseRendererArgs(['ack', '--consumer', 'desktop-buddy']), /requires --cursor/);
  assert.throws(() => parseRendererArgs(['next', '--consumer', '../escape']), /consumer id/);

  const emptyRepositoryRoot = await temporaryDirectory('codex-buddy-renderer-empty-root-');
  const emptyRuntimeDataDir = await temporaryDirectory('codex-buddy-renderer-empty-data-');
  const noConsumer = await runRendererCommand(['prune', '--apply'], {
    repositoryRoot: emptyRepositoryRoot,
    runtimeDataDir: emptyRuntimeDataDir
  });
  assert.equal(noConsumer.result.blocked_reason, 'no_active_consumers');
  assert.match(renderRendererCommand(noConsumer), /no active consumers; nothing eligible or deleted/);

  const repositoryRoot = await temporaryDirectory('codex-buddy-renderer-cli-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-renderer-cli-data-');
  await appendOutboxEvent(eventOptions(repositoryRoot, runtimeDataDir));
  await runRendererCommand(['register', '--consumer', 'desktop-buddy'], { repositoryRoot, runtimeDataDir });
  const next = await runRendererCommand(['next', '--consumer', 'desktop-buddy'], { repositoryRoot, runtimeDataDir });
  const rendered = JSON.parse(renderRendererCommand(next));
  assert.equal(rendered.events.length, 1);
  assert.equal(Object.hasOwn(rendered.events[0].payload, 'worker_summary'), false);
});
