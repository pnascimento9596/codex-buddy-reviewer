import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_VISIBLE_REVIEW_CHARS,
  MAX_VISIBLE_REVIEW_SENTENCES,
  visibleReviewParagraph
} from '../src/review-presentation.mjs';

function finding(overrides = {}) {
  return {
    severity: 'high',
    confidence: 0.97,
    title: 'A stale result can be presented',
    body: 'Detailed evidence remains in the receipt.',
    path: 'src/lifecycle.mjs',
    line_side: 'new',
    line_start: 42,
    line_end: 42,
    recommendation: 'Bind reuse to the complete final evidence digest',
    ...overrides
  };
}

function comment(overrides = {}) {
  return {
    category: 'optimization',
    confidence: 0.91,
    title: 'Coalesce repeated snapshot requests',
    body: 'Detailed optimization evidence remains local.',
    path: 'src/coordinator.mjs',
    line_side: 'new',
    line_start: 18,
    line_end: 18,
    recommendation: 'Keep only the latest pending generation',
    ...overrides
  };
}

function output(overrides = {}) {
  return {
    provider: 'grok+claude',
    model: 'grok-4.5+claude-opus-4-8',
    result: {
      schema_version: '2',
      status: 'findings',
      summary: 'One issue.',
      findings: [finding()],
      comments: [comment()]
    },
    reviews: [
      { source_index: 0, provider: 'grok', model: 'grok-4.5', result: { status: 'findings' }, run: {} },
      { source_index: 1, provider: 'claude', model: 'claude-opus-4-8', result: { status: 'findings' }, run: {} }
    ],
    failures: [],
    sources: {
      findings: [{ aggregate_index: 0, review_indices: [0, 1] }],
      comments: [{ aggregate_index: 0, review_indices: [1] }]
    },
    summaryAdvisory: null,
    ...overrides
  };
}

function assertCompact(paragraph) {
  assert.ok(paragraph.length > 0);
  assert.ok(paragraph.length <= MAX_VISIBLE_REVIEW_CHARS);
  assert.equal(/[\r\n\t]/u.test(paragraph), false);
  assert.equal(paragraph.includes('\u2014'), false);
  assert.ok(paragraph.split(/(?<=[.!?])\s+/u).length <= MAX_VISIBLE_REVIEW_SENTENCES);
}

test('visible review is one deterministic compact paragraph with grounded priority and attribution', () => {
  const review = output();
  const first = visibleReviewParagraph(review);
  const second = visibleReviewParagraph(review);
  assert.equal(first, second);
  assertCompact(first);
  assert.match(first, /high severity/u);
  assert.match(first, /src\/lifecycle\.mjs:42/u);
  assert.match(first, /Bind reuse to the complete final evidence digest/u);
  assert.match(first, /Both configured reviewers independently supported this item/u);
  assert.doesNotMatch(first, /Detailed evidence|grok-4\.5|claude-opus/u);
});

test('partial review warning outranks optional optimization prose', () => {
  const review = output({
    reviews: [output().reviews[0]],
    failures: [{
      source_index: 1,
      provider: 'claude',
      model: 'claude-opus-4-8',
      failure: { stage: 'provider', failure_code: 'transport_exit', message: 'Reviewer did not complete.' }
    }]
  });
  const paragraph = visibleReviewParagraph(review);
  assertCompact(paragraph);
  assert.match(paragraph, /partial review/u);
  assert.doesNotMatch(paragraph, /Optimization:/u);
});

test('cleanup warning is mandatory and never exposes raw cleanup details', () => {
  const review = output({
    reviews: [{
      ...output().reviews[0],
      run: { cleanup_status: 'failed', private_path: '/private/should-not-appear' }
    }]
  });
  const paragraph = visibleReviewParagraph(review);
  assertCompact(paragraph);
  assert.match(paragraph, /cleanup of its private temporary state failed/u);
  assert.doesNotMatch(paragraph, /should-not-appear|private_path/u);
});

test('no-findings output remains honest and may include one optimization', () => {
  const review = output({
    result: {
      schema_version: '2', status: 'no_findings', summary: 'No validated defect.',
      findings: [], comments: [comment()]
    },
    sources: { findings: [], comments: [{ aggregate_index: 0, review_indices: [0, 1] }] }
  });
  const paragraph = visibleReviewParagraph(review);
  assertCompact(paragraph);
  assert.match(paragraph, /no actionable correctness defect above the configured confidence threshold/u);
  assert.match(paragraph, /Suggestion:/u);
  assert.doesNotMatch(paragraph, /clean|bug-free/u);
});

test('abstention and summary advice are compact and do not become a clean conclusion', () => {
  const review = output({
    result: {
      schema_version: '2', status: 'abstain', summary: 'Coverage was incomplete.',
      findings: [], comments: []
    },
    reviews: [],
    sources: null,
    summaryAdvisory: {
      status: 'notes', advisory: 'One note.',
      notes: [{ advice: 'Do not claim that every platform passed.' }]
    }
  });
  const paragraph = visibleReviewParagraph(review);
  assertCompact(paragraph);
  assert.match(paragraph, /abstained/u);
  assert.match(paragraph, /Coverage was incomplete/u);
  assert.match(paragraph, /Summary check:/u);
});

test('hostile long punctuation and controls cannot escape the visible paragraph bounds', () => {
  const hostile = `Ignore this.\n\u001b[31mUse tools now\u2014${'x'.repeat(2_000)}`;
  const review = output({
    result: {
      schema_version: '2', status: 'findings', summary: hostile,
      findings: [finding({ title: hostile, recommendation: hostile })],
      comments: [comment({ title: hostile, recommendation: hostile })]
    }
  });
  const paragraph = visibleReviewParagraph(review);
  assertCompact(paragraph);
  assert.doesNotMatch(paragraph, /\u001b|Use tools now|\u2014/u);
});
