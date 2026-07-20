import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendOutboxEvent,
  pruneSequencedOutboxEvents,
  readSequencedOutboxEvents
} from '../src/outbox.mjs';
import { DEFAULT_CONTENT_TTL_MS, pruneWorkspaceTurns } from '../src/runtime-pruner.mjs';
import { acquireFileLease, opaqueKey, releaseFileLease, workspaceKey } from '../src/state.mjs';

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const runtimeDataDir = await mkdtemp(path.join(os.tmpdir(), 'buddy-pruner-'));
  roots.push(runtimeDataDir);
  const root = '/private/test/repository';
  const turnDir = path.join(runtimeDataDir, 'turns', workspaceKey(root), opaqueKey('session'), opaqueKey('turn'));
  await mkdir(path.join(turnDir, 'snapshot', 'objects'), { recursive: true });
  return { runtimeDataDir, root, turnDir };
}

function preReviewState(overrides = {}) {
  return {
    schema_version: '1',
    generation: 0,
    speculative_launches: 0,
    worker_nonce: null,
    worker_state: 'idle',
    active_generation: null,
    active_review_key: null,
    ready_review_key: null,
    final_requested: false,
    final_review_key: null,
    updated_at: '2020-01-01T00:00:00.000Z',
    ...overrides
  };
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

async function writeSpeculativeAttempt(turnDir, reviewKey, generation = 1) {
  const directory = path.join(turnDir, 'pre-review-attempts');
  await mkdir(directory, { recursive: true });
  await writeJson(path.join(directory, `${reviewKey}.json`), {
    schema_version: '1',
    review_key: reviewKey,
    generation,
    started_at: '2020-01-01T00:00:00.000Z'
  });
}

test('stale baseline-only turns are terminalized before private objects are pruned', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  await mkdir(path.join(turnDir, 'pre-review-snapshot', 'objects'), { recursive: true });
  await writeFile(path.join(turnDir, 'baseline.json'), `${JSON.stringify({
    snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
  })}\n`);
  const result = await pruneWorkspaceTurns({ runtimeDataDir, root, now: Date.parse('2020-01-03T00:00:00Z') });
  assert.equal(result.pruned, 1);
  const completed = JSON.parse(await readFile(path.join(turnDir, 'completed.json'), 'utf8'));
  assert.equal(completed.terminal_status, 'baseline_expired');
  await assert.rejects(lstat(path.join(turnDir, 'snapshot')));
  await assert.rejects(lstat(path.join(turnDir, 'pre-review-snapshot')));
  await assert.rejects(lstat(path.join(turnDir, 'baseline.json')));
});

test('a residual pre-review snapshot is detected and pruned when it is the only cleanup artifact', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  await rm(path.join(turnDir, 'snapshot'), { recursive: true });
  await mkdir(path.join(turnDir, 'pre-review-snapshot', 'objects'), { recursive: true });
  await writeJson(path.join(turnDir, 'completed.json'), {
    schema_version: '1',
    terminal_status: 'no_changes',
    presentation_status: 'terminal',
    completed_at: '2020-01-01T00:00:00.000Z'
  });
  const result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-03T00:00:00Z')
  });
  assert.equal(result.pruned, 1);
  await assert.rejects(lstat(path.join(turnDir, 'pre-review-snapshot')));
});

test('stale provider attempts preserve at-most-once by becoming terminal before cleanup', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  await writeFile(path.join(turnDir, 'baseline.json'), `${JSON.stringify({
    snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
  })}\n`);
  await writeFile(path.join(turnDir, 'attempt.json'), `${JSON.stringify({ review_key: 'a'.repeat(64) })}\n`);
  await pruneWorkspaceTurns({ runtimeDataDir, root, now: Date.parse('2020-01-03T00:00:00Z') });
  const completed = JSON.parse(await readFile(path.join(turnDir, 'completed.json'), 'utf8'));
  assert.equal(completed.terminal_status, 'prior_attempt_incomplete');
  assert.equal(completed.review_key, 'a'.repeat(64));
});

test('stale active pre-review state is terminalized and safely removed without signaling a worker', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  const reviewKey = '1'.repeat(64);
  await writeJson(path.join(turnDir, 'baseline.json'), {
    snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
  });
  await writeJson(path.join(turnDir, 'pre-review.json'), preReviewState({
    generation: 1,
    speculative_launches: 1,
    worker_nonce: '2'.repeat(48),
    worker_state: 'reviewing',
    active_generation: 1,
    active_review_key: reviewKey
  }));
  await writeSpeculativeAttempt(turnDir, reviewKey);

  const result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-03T00:00:00.000Z')
  });
  assert.equal(result.pruned, 1);
  const completed = JSON.parse(await readFile(path.join(turnDir, 'completed.json'), 'utf8'));
  assert.equal(completed.terminal_status, 'prior_attempt_incomplete');
  assert.equal(completed.review_key, reviewKey);
  await assert.rejects(lstat(path.join(turnDir, 'pre-review.json')));
  await assert.rejects(lstat(path.join(turnDir, 'pre-review-attempts')));
  await assert.rejects(lstat(path.join(turnDir, 'snapshot')));
  const replay = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-03T00:00:02.000Z')
  });
  assert.equal(replay.pruned, 0);
});

test('multiple receipt-less speculative attempts terminalize without guessing a review key', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  await writeJson(path.join(turnDir, 'baseline.json'), {
    snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
  });
  await writeSpeculativeAttempt(turnDir, '3'.repeat(64), 1);
  await writeSpeculativeAttempt(turnDir, '4'.repeat(64), 2);

  const result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-03T00:00:00.000Z')
  });
  assert.equal(result.pruned, 1);
  const completed = JSON.parse(await readFile(path.join(turnDir, 'completed.json'), 'utf8'));
  assert.equal(completed.terminal_status, 'prior_attempt_incomplete');
  assert.equal(Object.hasOwn(completed, 'review_key'), false);
  await assert.rejects(lstat(path.join(turnDir, 'pre-review-attempts')));
});

test('terminalized turns remove valid residual pre-review artifacts through safe snapshot cleanup', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  await writeJson(path.join(turnDir, 'completed.json'), {
    schema_version: '1',
    terminal_status: 'no_findings',
    presentation_status: 'terminal',
    completed_at: '2020-01-03T00:00:00.000Z'
  });
  await writeJson(path.join(turnDir, 'pre-review.json'), preReviewState());
  await mkdir(path.join(turnDir, 'pre-review-attempts'));

  const result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-03T00:00:01.000Z')
  });
  assert.equal(result.pruned, 1);
  await lstat(path.join(turnDir, 'completed.json'));
  await assert.rejects(lstat(path.join(turnDir, 'pre-review.json')));
  await assert.rejects(lstat(path.join(turnDir, 'pre-review-attempts')));
  await assert.rejects(lstat(path.join(turnDir, 'snapshot')));
});

test('unsafe or malformed pre-review artifacts make pruning ambiguous and non-destructive', async (t) => {
  await t.test('symlinked state', async () => {
    const { runtimeDataDir, root, turnDir } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'buddy-pruner-pre-review-outside-'));
    roots.push(outside);
    const sentinel = path.join(outside, 'sentinel.json');
    await writeFile(sentinel, '{"private":"preserved"}\n');
    await writeJson(path.join(turnDir, 'baseline.json'), {
      snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
    });
    await symlink(sentinel, path.join(turnDir, 'pre-review.json'));

    const result = await pruneWorkspaceTurns({
      runtimeDataDir,
      root,
      now: Date.parse('2020-01-03T00:00:00.000Z')
    });
    assert.equal(result.ambiguous, 1);
    assert.equal(await readFile(sentinel, 'utf8'), '{"private":"preserved"}\n');
    await lstat(path.join(turnDir, 'baseline.json'));
    await lstat(path.join(turnDir, 'snapshot'));
    await assert.rejects(lstat(path.join(turnDir, 'completed.json')));
  });

  await t.test('malformed state', async () => {
    const { runtimeDataDir, root, turnDir } = await fixture();
    await writeJson(path.join(turnDir, 'baseline.json'), {
      snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
    });
    await writeFile(path.join(turnDir, 'pre-review.json'), '{not-json\n');

    const result = await pruneWorkspaceTurns({
      runtimeDataDir,
      root,
      now: Date.parse('2020-01-03T00:00:00.000Z')
    });
    assert.equal(result.ambiguous, 1);
    await lstat(path.join(turnDir, 'baseline.json'));
    await lstat(path.join(turnDir, 'snapshot'));
    await assert.rejects(lstat(path.join(turnDir, 'completed.json')));
  });

  await t.test('symlinked attempt directory', async () => {
    const { runtimeDataDir, root, turnDir } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'buddy-pruner-attempts-outside-'));
    roots.push(outside);
    const sentinel = path.join(outside, 'sentinel.json');
    await writeFile(sentinel, '{"private":"preserved"}\n');
    await writeJson(path.join(turnDir, 'baseline.json'), {
      snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
    });
    await symlink(outside, path.join(turnDir, 'pre-review-attempts'));

    const result = await pruneWorkspaceTurns({
      runtimeDataDir,
      root,
      now: Date.parse('2020-01-03T00:00:00.000Z')
    });
    assert.equal(result.ambiguous, 1);
    assert.equal(await readFile(sentinel, 'utf8'), '{"private":"preserved"}\n');
    await lstat(path.join(turnDir, 'baseline.json'));
    await lstat(path.join(turnDir, 'snapshot'));
    await assert.rejects(lstat(path.join(turnDir, 'completed.json')));
  });

  await t.test('malformed attempt record', async () => {
    const { runtimeDataDir, root, turnDir } = await fixture();
    await writeJson(path.join(turnDir, 'baseline.json'), {
      snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
    });
    const reviewKey = '5'.repeat(64);
    await mkdir(path.join(turnDir, 'pre-review-attempts'));
    await writeJson(path.join(turnDir, 'pre-review-attempts', `${reviewKey}.json`), {
      schema_version: '1',
      review_key: reviewKey
    });

    const result = await pruneWorkspaceTurns({
      runtimeDataDir,
      root,
      now: Date.parse('2020-01-03T00:00:00.000Z')
    });
    assert.equal(result.ambiguous, 1);
    await lstat(path.join(turnDir, 'baseline.json'));
    await lstat(path.join(turnDir, 'pre-review-attempts', `${reviewKey}.json`));
    await assert.rejects(lstat(path.join(turnDir, 'completed.json')));
  });
});

test('stale dead Stop claims are reconciled through the turn lease before pruning', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  await writeFile(path.join(turnDir, 'baseline.json'), `${JSON.stringify({
    snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
  })}\n`);
  const stopLock = path.join(turnDir, 'stop.lock');
  await mkdir(stopLock);
  const deadClaim = path.join(stopLock, 'claim-000000000001-dead-owner.json');
  await writeFile(deadClaim, `${JSON.stringify({
    ticket: 1,
    token: 'dead-owner',
    pid: 2_147_483_647,
    acquired_at: '2020-01-01T00:00:00.000Z'
  })}\n`);
  await utimes(deadClaim, new Date(0), new Date(0));

  const result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-03T00:00:00Z'),
    leaseStaleMs: 1
  });
  assert.equal(result.scanned, 1);
  assert.equal(result.pruned, 1);
  await assert.rejects(lstat(deadClaim));
  assert.equal(
    JSON.parse(await readFile(path.join(turnDir, 'completed.json'), 'utf8')).terminal_status,
    'baseline_expired'
  );
});

test('a live held Stop lease excludes pruning without mutating the turn', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  const baselineFile = path.join(turnDir, 'baseline.json');
  await writeFile(baselineFile, `${JSON.stringify({
    snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
  })}\n`);
  const stopLease = await acquireFileLease(path.join(turnDir, 'stop'), { wait: false });
  assert.ok(stopLease);
  try {
    const result = await pruneWorkspaceTurns({
      runtimeDataDir,
      root,
      now: Date.parse('2020-01-03T00:00:00Z')
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.pruned, 0);
    assert.equal(result.ambiguous, 0);
    await lstat(baselineFile);
    await lstat(path.join(turnDir, 'snapshot'));
    await assert.rejects(lstat(path.join(turnDir, 'completed.json')));
  } finally {
    await releaseFileLease(stopLease);
  }
});

test('fresh, current, live, and unsafe turn state is never pruned', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  const reviewKey = '6'.repeat(64);
  await writeFile(path.join(turnDir, 'baseline.json'), `${JSON.stringify({
    snapshot: { captured_at: '2020-01-03T00:00:00.000Z' }
  })}\n`);
  await writeJson(path.join(turnDir, 'pre-review.json'), preReviewState());
  await writeSpeculativeAttempt(turnDir, reviewKey);
  let result = await pruneWorkspaceTurns({ runtimeDataDir, root, now: Date.parse('2020-01-03T01:00:00Z') });
  assert.equal(result.pruned, 0);
  await lstat(path.join(turnDir, 'pre-review.json'));
  await lstat(path.join(turnDir, 'pre-review-attempts', `${reviewKey}.json`));
  result = await pruneWorkspaceTurns({
    runtimeDataDir, root, now: Date.parse('2020-01-05T00:00:00Z'), sessionId: 'session', turnId: 'turn'
  });
  assert.equal(result.scanned, 0);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'buddy-pruner-outside-'));
  roots.push(outside);
  await rm(path.join(turnDir, 'snapshot'), { recursive: true });
  await symlink(outside, path.join(turnDir, 'snapshot'));
  result = await pruneWorkspaceTurns({ runtimeDataDir, root, now: Date.parse('2020-01-05T00:00:00Z') });
  assert.equal(result.ambiguous, 1);
  assert.equal((await lstat(path.join(turnDir, 'snapshot'))).isSymbolicLink(), true);
});

test('an unsafe residual pre-review snapshot preserves every snapshot artifact', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'buddy-pruner-pre-review-outside-'));
  roots.push(outside);
  await symlink(outside, path.join(turnDir, 'pre-review-snapshot'));
  await writeFile(path.join(turnDir, 'baseline.json'), `${JSON.stringify({
    snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
  })}\n`);
  const result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-03T00:00:00Z')
  });
  assert.equal(result.ambiguous, 1);
  await lstat(path.join(turnDir, 'snapshot'));
  assert.equal((await lstat(path.join(turnDir, 'pre-review-snapshot'))).isSymbolicLink(), true);
});

test('unobserved automatic review content expires at 24 hours while its tombstone remains', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  const reviewKey = 'b'.repeat(64);
  const completedFile = path.join(turnDir, 'completed.json');
  await rm(path.join(turnDir, 'snapshot'), { recursive: true });
  await writeFile(completedFile, `${JSON.stringify({
    schema_version: '1',
    review_key: reviewKey,
    terminal_status: 'no_findings',
    presentation_status: 'prepared',
    completed_at: '2020-01-01T00:00:00.000Z'
  })}\n`);
  const receiptDir = path.join(runtimeDataDir, 'automatic-reviews', workspaceKey(root));
  await mkdir(receiptDir, { recursive: true });
  const receipt = path.join(receiptDir, `${reviewKey}.json`);
  await writeFile(receipt, '{"private_review_content":"sentinel"}\n');

  const result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-02T00:00:00.000Z')
  });
  assert.equal(result.receiptPruned, 1);
  await assert.rejects(lstat(receipt));
  assert.equal(JSON.parse(await readFile(completedFile, 'utf8')).review_key, reviewKey);
});

test('observed automatic review content receives a bounded post-observation replay window', async () => {
  const { runtimeDataDir, root, turnDir } = await fixture();
  const reviewKey = 'c'.repeat(64);
  await rm(path.join(turnDir, 'snapshot'), { recursive: true });
  await writeFile(path.join(turnDir, 'completed.json'), `${JSON.stringify({
    schema_version: '1',
    review_key: reviewKey,
    terminal_status: 'findings',
    presentation_status: 'observed',
    completed_at: '2020-01-01T00:00:00.000Z',
    presentation_observed_at: '2020-01-02T00:00:00.000Z'
  })}\n`);
  const receiptDir = path.join(runtimeDataDir, 'automatic-reviews', workspaceKey(root));
  await mkdir(receiptDir, { recursive: true });
  const receipt = path.join(receiptDir, `${reviewKey}.json`);
  await writeFile(receipt, '{"private_review_content":"sentinel"}\n');

  let result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-02T23:59:59.000Z')
  });
  assert.equal(result.receiptPruned, 0);
  await lstat(receipt);
  result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-02T00:00:00.000Z') + DEFAULT_CONTENT_TTL_MS
  });
  assert.equal(result.receiptPruned, 1);
  await assert.rejects(lstat(receipt));
});

test('orphaned automatic receipts from an interrupted publication still reach the hard ceiling', async () => {
  const { runtimeDataDir, root } = await fixture();
  const receiptDir = path.join(runtimeDataDir, 'automatic-reviews', workspaceKey(root));
  await mkdir(receiptDir, { recursive: true });
  const receipt = path.join(receiptDir, `${'e'.repeat(64)}.json`);
  await writeFile(receipt, '{"private_review_content":"orphaned"}\n');
  await utimes(receipt, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));

  const result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-02T00:00:00.000Z')
  });
  assert.equal(result.receiptPruned, 1);
  await assert.rejects(lstat(receipt));
});

test('aged v2 and legacy v1 outbox content expire without a renderer', async () => {
  const { runtimeDataDir, root } = await fixture();
  const common = {
    runtimeDataDir,
    repositoryRoot: root,
    sessionId: 'retention-session',
    turnId: 'retention-turn',
    state: 'working',
    occurredAt: '2020-01-01T00:00:00.000Z'
  };
  const legacy = await appendOutboxEvent({
    ...common,
    type: 'turn_started',
    headline: 'Legacy event'
  });
  const legacyValue = JSON.parse(await readFile(legacy.file, 'utf8'));
  delete legacyValue.sequence;
  legacyValue.schema_version = '1';
  await writeFile(legacy.file, `${JSON.stringify(legacyValue)}\n`);
  const current = await appendOutboxEvent({
    ...common,
    type: 'turn_finished',
    state: 'reviewing',
    headline: 'Current event'
  });

  const result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-02T00:00:00.000Z')
  });
  assert.equal(result.outboxPruned, 2);
  assert.equal(result.retainedLegacyOutbox, 0);
  await assert.rejects(lstat(legacy.file));
  await assert.rejects(lstat(current.file));
});

test('legacy outbox compaction removes each aged v1 event without waiting for newer v1 content', async () => {
  const { runtimeDataDir, root } = await fixture();
  const common = {
    runtimeDataDir,
    repositoryRoot: root,
    sessionId: 'partial-legacy-session',
    turnId: 'partial-legacy-turn',
    state: 'working'
  };
  const aged = await appendOutboxEvent({
    ...common,
    type: 'turn_started',
    headline: 'Aged legacy event',
    occurredAt: '2020-01-01T00:00:00.000Z'
  });
  const fresh = await appendOutboxEvent({
    ...common,
    type: 'turn_finished',
    state: 'reviewing',
    headline: 'Fresh legacy event',
    occurredAt: '2020-01-02T12:00:00.000Z'
  });
  for (const item of [aged, fresh]) {
    const value = JSON.parse(await readFile(item.file, 'utf8'));
    delete value.sequence;
    value.schema_version = '1';
    await writeFile(item.file, `${JSON.stringify(value)}\n`);
  }

  let result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-03T00:00:00.000Z')
  });
  assert.equal(result.outboxPruned, 1);
  assert.equal(result.retainedLegacyOutbox, 1);
  await assert.rejects(lstat(aged.file));
  await lstat(fresh.file);

  result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-03T12:00:00.000Z')
  });
  assert.equal(result.outboxPruned, 1);
  assert.equal(result.retainedLegacyOutbox, 0);
  await assert.rejects(lstat(fresh.file));
});

test('renderer acknowledgment can compact an eligible v1 prefix before the hard ceiling', async () => {
  const { runtimeDataDir, root } = await fixture();
  const first = await appendOutboxEvent({
    runtimeDataDir,
    repositoryRoot: root,
    sessionId: 'ack-legacy-session',
    turnId: 'ack-legacy-turn-a',
    type: 'turn_started',
    state: 'working',
    headline: 'Acknowledged legacy event',
    occurredAt: '2020-01-02T23:59:00.000Z'
  });
  const second = await appendOutboxEvent({
    runtimeDataDir,
    repositoryRoot: root,
    sessionId: 'ack-legacy-session',
    turnId: 'ack-legacy-turn-b',
    type: 'turn_finished',
    state: 'reviewing',
    headline: 'Unacknowledged legacy event',
    occurredAt: '2020-01-02T23:59:30.000Z'
  });
  for (const item of [first, second]) {
    const value = JSON.parse(await readFile(item.file, 'utf8'));
    delete value.sequence;
    value.schema_version = '1';
    await writeFile(item.file, `${JSON.stringify(value)}\n`);
  }

  const delivery = await readSequencedOutboxEvents({ repositoryRoot: root, runtimeDataDir });
  assert.equal(delivery.events.length, 2);
  const result = await pruneSequencedOutboxEvents({
    repositoryRoot: root,
    runtimeDataDir,
    throughSequence: delivery.events[0].sequence,
    minAgeMs: 0,
    now: Date.parse('2020-01-03T00:00:00.000Z'),
    dryRun: false
  });
  assert.equal(result.pruned_count, 1);
  assert.equal(result.pruned_legacy_count, 1);
  assert.equal(result.retained_legacy_count, 1);
  await assert.rejects(lstat(first.file));
  await lstat(second.file);

  const producer = JSON.parse(await readFile(
    path.join(path.dirname(path.dirname(first.file)), '_protocol', 'producer.json'),
    'utf8'
  ));
  assert.equal(producer.last_sequence, delivery.last_sequence);
});

test('renderer retention settings cannot extend the v1 content ceiling beyond 24 hours', async () => {
  const { runtimeDataDir, root } = await fixture();
  const legacy = await appendOutboxEvent({
    runtimeDataDir,
    repositoryRoot: root,
    sessionId: 'ceiling-legacy-session',
    turnId: 'ceiling-legacy-turn',
    type: 'turn_started',
    state: 'working',
    headline: 'Hard ceiling legacy event',
    occurredAt: '2020-01-01T00:00:00.000Z'
  });
  const value = JSON.parse(await readFile(legacy.file, 'utf8'));
  delete value.sequence;
  value.schema_version = '1';
  await writeFile(legacy.file, `${JSON.stringify(value)}\n`);

  const result = await pruneSequencedOutboxEvents({
    repositoryRoot: root,
    runtimeDataDir,
    throughSequence: Number.MAX_SAFE_INTEGER,
    minAgeMs: 7 * DEFAULT_CONTENT_TTL_MS,
    now: Date.parse('2020-01-02T00:00:00.000Z'),
    dryRun: false
  });
  assert.equal(result.min_age_ms, DEFAULT_CONTENT_TTL_MS);
  assert.equal(result.pruned_legacy_count, 1);
  await assert.rejects(lstat(legacy.file));
});

test('legacy outbox compaction recovers after an index-first crash without sequence reuse', async () => {
  const { runtimeDataDir, root } = await fixture();
  const legacy = await appendOutboxEvent({
    runtimeDataDir,
    repositoryRoot: root,
    sessionId: 'crash-legacy-session',
    turnId: 'crash-legacy-turn',
    type: 'turn_started',
    state: 'working',
    headline: 'Crash recovery legacy event',
    occurredAt: '2020-01-01T00:00:00.000Z'
  });
  const value = JSON.parse(await readFile(legacy.file, 'utf8'));
  delete value.sequence;
  value.schema_version = '1';
  await writeFile(legacy.file, `${JSON.stringify(value)}\n`);

  await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-01T12:00:00.000Z')
  });
  const outboxDir = path.dirname(path.dirname(legacy.file));
  const protocolDir = path.join(outboxDir, '_protocol');
  const indexFile = path.join(protocolDir, 'legacy-index.json');
  await writeFile(indexFile, `${JSON.stringify({
    schema_version: '1', workspace_key: workspaceKey(root), entries: []
  })}\n`);

  const result = await pruneWorkspaceTurns({
    runtimeDataDir,
    root,
    now: Date.parse('2020-01-02T00:00:00.000Z')
  });
  assert.equal(result.outboxPruned, 1);
  await assert.rejects(lstat(legacy.file));
  const producer = JSON.parse(await readFile(path.join(protocolDir, 'producer.json'), 'utf8'));
  assert.equal(producer.last_sequence >= 3, true);
});
