import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendOutboxEvent } from '../src/outbox.mjs';
import { readRendererEvents, registerRendererConsumer } from '../src/renderer-protocol.mjs';

const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function result(summary, overrides = {}) {
  return {
    schema_version: '2',
    status: 'no_findings',
    summary,
    findings: [],
    comments: [],
    ...overrides
  };
}

function finding(index) {
  return {
    severity: index === 0 ? 'high' : 'medium',
    confidence: 0.9,
    title: `Finding ${index}`,
    body: `Finding body ${index}`,
    impact: `Finding impact ${index}`,
    path: `src/finding-${index}.mjs`,
    line_side: 'new',
    line_start: index + 1,
    line_end: index + 1,
    evidence: `Finding evidence ${index}`,
    recommendation: `Finding recommendation ${index}`
  };
}

function comment(index) {
  return {
    category: index === 0 ? 'reliability' : 'testing',
    confidence: 0.8,
    title: `Comment ${index}`,
    body: `Comment body ${index}`,
    path: `src/comment-${index}.mjs`,
    line_side: 'new',
    line_start: index + 1,
    line_end: index + 1,
    evidence: `Comment evidence ${index}`,
    recommendation: `Comment recommendation ${index}`
  };
}

function success(sourceIndex, provider, model, reviewResult = result(`${provider} completed.`)) {
  return {
    source_index: sourceIndex,
    provider,
    model,
    status: 'succeeded',
    result: reviewResult,
    failure: null
  };
}

function failure(sourceIndex, provider, model, failureCode = 'provider_unavailable') {
  return {
    source_index: sourceIndex,
    provider,
    model,
    status: failureCode === 'circuit_open' ? 'circuit_open' : 'failed',
    result: null,
    failure: {
      stage: 'provider',
      failure_code: failureCode,
      message: failureCode === 'circuit_open'
        ? 'Reviewer circuit is temporarily open.'
        : 'Reviewer connection did not complete.'
    }
  };
}

function eventOptions(repositoryRoot, runtimeDataDir, overrides = {}) {
  return {
    repositoryRoot,
    runtimeDataDir,
    sessionId: 'multi-review-session',
    turnId: 'multi-review-turn',
    type: 'review_completed',
    state: 'success',
    headline: 'Buddy review completed',
    detail: 'One of two independent reviewers completed.',
    workerSummary: 'Bounded worker summary.',
    result: result('Aggregate review completed.'),
    provider: 'claude+grok',
    model: 'claude-opus-4-8+grok-4.5',
    summaryAdvisory: null,
    companion: null,
    occurredAt: '2026-07-18T12:00:00.000Z',
    ...overrides
  };
}

async function renderOnlyEvent(repositoryRoot, runtimeDataDir, consumerId) {
  const consumer = { repositoryRoot, runtimeDataDir, consumerId };
  await registerRendererConsumer(consumer);
  const delivery = await readRendererEvents(consumer);
  assert.equal(delivery.events.length, 1);
  return delivery.events[0];
}

test('one success and one safe failure retain ordered attribution and render a partial reviewer state', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-multireview-partial-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-multireview-partial-data-');
  const written = await appendOutboxEvent(eventOptions(repositoryRoot, runtimeDataDir, {
    reviews: [
      success(1, 'grok\u001b[31m', 'grok-4.5'),
      failure(0, 'claude', 'claude-opus-4-8', 'circuit_open')
    ]
  }));

  assert.deepEqual(written.event.payload.reviews.map((review) => review.source_index), [0, 1]);
  assert.deepEqual(written.event.payload.reviews.map((review) => review.status), ['circuit_open', 'succeeded']);
  assert.equal(written.event.payload.reviews[1].provider, 'grok\\u{001b}[31m');
  assert.equal(JSON.stringify(written.event.payload.reviews).includes('\u001b'), false);
  assert.equal(JSON.stringify(written.event.payload.reviews).includes('raw_error'), false);

  const rendered = await renderOnlyEvent(repositoryRoot, runtimeDataDir, 'partial-renderer');
  assert.equal(rendered.payload.reviewer_state, 'partial');
  assert.equal(rendered.payload.reviews[0].failure.failure_code, 'circuit_open');
  assert.equal(rendered.payload.reviews[1].result.summary, 'grok\\u{001b}[31m completed.');
  assert.equal(rendered.payload.review.summary, 'Aggregate review completed.');
});

test('two successes are sorted stably and receive equal per-review presentation caps', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-multireview-complete-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-multireview-complete-data-');
  const fullResult = (name) => result(`${name} completed.`, {
    status: 'findings',
    findings: Array.from({ length: 5 }, (_, index) => finding(index)),
    comments: Array.from({ length: 3 }, (_, index) => comment(index))
  });
  const written = await appendOutboxEvent(eventOptions(repositoryRoot, runtimeDataDir, {
    state: 'findings',
    reviews: [
      success(1, 'grok', 'grok-4.5', fullResult('Grok')),
      success(0, 'claude', 'claude-opus-4-8', fullResult('Claude'))
    ]
  }));

  assert.deepEqual(written.event.payload.reviews.map((review) => review.provider), ['claude', 'grok']);
  for (const review of written.event.payload.reviews) {
    assert.equal(review.result.findings.length, 3);
    assert.equal(review.result.comments.length, 2);
  }
  assert.ok(JSON.stringify(written.event.payload).length < 40_000);

  const rendered = await renderOnlyEvent(repositoryRoot, runtimeDataDir, 'complete-renderer');
  assert.equal(rendered.payload.reviewer_state, 'complete');
  assert.deepEqual(rendered.payload.reviews.map((review) => review.provider), ['claude', 'grok']);
});

test('legacy v2 events without attributed reviews retain their event shape and renderer compatibility', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-multireview-legacy-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-multireview-legacy-data-');
  const written = await appendOutboxEvent(eventOptions(repositoryRoot, runtimeDataDir));
  assert.equal(Object.hasOwn(written.event.payload, 'reviews'), false);

  const rendered = await renderOnlyEvent(repositoryRoot, runtimeDataDir, 'legacy-renderer');
  assert.equal(rendered.payload.reviews, null);
  assert.equal(rendered.payload.reviewer_state, null);
  assert.equal(rendered.payload.review.summary, 'Aggregate review completed.');
});

test('reviewer presentation rejects oversized, secret-shaped, raw-error, and unsafe-path metadata', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-multireview-reject-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-multireview-reject-data-');
  const base = eventOptions(repositoryRoot, runtimeDataDir);

  await assert.rejects(
    appendOutboxEvent({ ...base, reviews: [{ ...success(0, 'claude', 'model'), api_key: 'secret' }] }),
    /unsupported or missing fields/
  );
  await assert.rejects(
    appendOutboxEvent({ ...base, reviews: [{ ...success(0, 'claude', 'model'), run: { raw: 'secret' } }] }),
    /unsupported or missing fields/
  );
  await assert.rejects(
    appendOutboxEvent({
      ...base,
      reviews: [success(0, 'claude', 'model', { ...result('ok'), private: { token: 'secret' } })]
    }),
    /unsupported or missing fields/
  );
  await assert.rejects(
    appendOutboxEvent({ ...base, reviews: [success(0, 'p'.repeat(121), 'model')] }),
    /at most 120/
  );
  await assert.rejects(
    appendOutboxEvent({
      ...base,
      reviews: [success(0, 'claude', 'model', result('s'.repeat(1201)))]
    }),
    /at most 1200/
  );
  await assert.rejects(
    appendOutboxEvent({
      ...base,
      reviews: [success(0, 'claude', 'model'), { ...failure(1, 'grok', 'model'), raw_error: 'secret' }]
    }),
    /unsupported or missing fields/
  );
  await assert.rejects(
    appendOutboxEvent({
      ...base,
      reviews: [success(0, 'claude', 'model', result('bad path', {
        status: 'findings', findings: [{ ...finding(0), path: '.env' }]
      }))]
    }),
    /allowlisted repository-relative path/
  );
  const credentialModel = ['xai-', 'A9_bC7-dE5_fG3-hJ1_kL8'].join('');
  await assert.rejects(
    appendOutboxEvent({ ...base, model: credentialModel }),
    /model is invalid or contains credential material/
  );
  await assert.rejects(
    appendOutboxEvent({ ...base, reviews: [success(0, 'claude', credentialModel)] }),
    /model is invalid or contains credential material/
  );
});

test('semantic event identity changes when an attributed reviewer detail changes', async () => {
  const repositoryRoot = await temporaryDirectory('codex-buddy-multireview-id-root-');
  const runtimeDataDir = await temporaryDirectory('codex-buddy-multireview-id-data-');
  const base = eventOptions(repositoryRoot, runtimeDataDir);
  const first = await appendOutboxEvent({
    ...base,
    reviews: [success(0, 'claude', 'claude-opus-4-8')]
  });
  const second = await appendOutboxEvent({
    ...base,
    reviews: [success(0, 'claude', 'claude-opus-4-8-20260718')]
  });
  assert.notEqual(first.event.event_id, second.event.event_id);
  assert.deepEqual([first.event.sequence, second.event.sequence], [1, 2]);
});
