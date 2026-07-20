import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReviewAggregationError,
  aggregateReviewOutcomes
} from '../src/review-aggregate.mjs';
import { REVIEW_SCHEMA_VERSION } from '../src/review-schema.mjs';
import { validateReviewResult } from '../src/result.mjs';

function finding(overrides = {}) {
  return {
    severity: 'medium',
    confidence: 0.9,
    title: 'A grounded defect',
    body: 'The changed implementation can return the wrong value.',
    impact: 'Callers can observe incorrect behavior.',
    path: 'src/example.mjs',
    line_side: 'new',
    line_start: 10,
    line_end: 10,
    evidence: 'The changed line returns the stale value.',
    recommendation: 'Return the current value.',
    ...overrides
  };
}

function comment(overrides = {}) {
  return {
    category: 'maintainability',
    confidence: 0.88,
    title: 'Clarify the helper name',
    body: 'The name hides the helper side effect.',
    path: 'src/example.mjs',
    line_side: 'new',
    line_start: 12,
    line_end: 12,
    evidence: 'The changed helper now writes state.',
    recommendation: 'Use a name that describes the write.',
    ...overrides
  };
}

function result(overrides = {}) {
  const findings = overrides.findings ?? [];
  return {
    schema_version: REVIEW_SCHEMA_VERSION,
    status: findings.length ? 'findings' : 'no_findings',
    summary: 'Provider summary.',
    findings,
    comments: [],
    ...overrides
  };
}

function success(provider, model, resultValue, overrides = {}) {
  return { provider, model, result: resultValue, ...overrides };
}

function failure(provider, model, overrides = {}) {
  return {
    provider,
    model,
    failure: {
      stage: 'inference',
      failure_code: 'deadline_exceeded',
      message: 'The provider exceeded its configured deadline.',
      ...overrides
    }
  };
}

function run(provider, model, overrides = {}) {
  return {
    schema_version: '1',
    ok: true,
    provider,
    model,
    stage: 'complete',
    failure_code: null,
    duration_ms: 25,
    stdout_bytes: 100,
    stderr_bytes: 0,
    stderr_present: false,
    usage: {
      input_tokens: 30,
      cached_input_tokens: 0,
      output_tokens: 12,
      reasoning_tokens: null,
      total_tokens: 42
    },
    usage_complete: true,
    cost_usd_ticks: null,
    ...overrides
  };
}

function evidence() {
  return {
    changed_paths: ['src/example.mjs', 'src/other.mjs'],
    path_evidence: [
      { path: 'src/example.mjs', disposition: 'complete', transmitted: true, file_state: 'modified' },
      { path: 'src/other.mjs', disposition: 'complete', transmitted: true, file_state: 'modified' }
    ],
    hunk_ranges: {
      'src/example.mjs': [{ side: 'new', start: 1, end: 30 }, { side: 'old', start: 1, end: 30 }],
      'src/other.mjs': [{ side: 'new', start: 1, end: 30 }, { side: 'old', start: 1, end: 30 }]
    },
    line_counts: { 'src/example.mjs': 30, 'src/other.mjs': 30 },
    old_line_counts: { 'src/example.mjs': 30, 'src/other.mjs': 30 },
    incomplete_paths: [],
    excluded_paths: [],
    sensitive_change_count: 0,
    ignored_change_count: 0
  };
}

test('one successful review produces a schema-compatible deterministic legacy result', () => {
  const input = success('grok', 'grok-4.5', result({
    comments: [comment()]
  }), {
    run: run('grok', 'grok-4.5'),
    summaryAdvisory: { schema_version: '1', status: 'no_notes', advisory: 'No notes.', notes: [] }
  });
  const aggregate = aggregateReviewOutcomes([input]);

  assert.equal(aggregate.provider, 'grok');
  assert.equal(aggregate.model, 'grok-4.5');
  assert.equal(aggregate.result.schema_version, REVIEW_SCHEMA_VERSION);
  assert.equal(aggregate.result.status, 'no_findings');
  assert.match(aggregate.result.summary, /^Independent review aggregation completed: 1 of 1 reviewer runs succeeded \(1 non-abstaining, 0 abstained, 0 failed\)\./);
  assert.deepEqual(aggregate.result.findings, []);
  assert.deepEqual(aggregate.result.comments, [comment()]);
  assert.deepEqual(aggregate.failures, []);
  assert.deepEqual(aggregate.reviews[0].result, input.result);
  assert.deepEqual(aggregate.reviews[0].run, input.run);
  assert.deepEqual(aggregate.reviews[0].summaryAdvisory, input.summaryAdvisory);
  assert.equal(aggregate.reviews[0].source_index, 0);
  assert.equal(aggregate.reviews[0].label, 'grok/grok-4.5');
  assert.deepEqual(aggregate.sources.comments, [{
    aggregate_index: 0,
    review_indices: [0],
    reviewer_labels: ['grok/grok-4.5'],
    representative: { review_index: 0, item_index: 0 },
    occurrences: [{ review_index: 0, item_index: 0, reviewer_label: 'grok/grok-4.5' }]
  }]);
  assert.deepEqual(validateReviewResult(aggregate.result, evidence()), aggregate.result);
});

test('successful cleanup warnings remain bounded private run metadata', () => {
  const aggregate = aggregateReviewOutcomes([
    success('grok', 'grok-4.5', result(), {
      run: run('grok', 'grok-4.5', { cleanup_status: 'failed' })
    })
  ]);
  assert.equal(aggregate.reviews[0].run.cleanup_status, 'failed');
  assert.throws(() => aggregateReviewOutcomes([
    success('grok', 'grok-4.5', result(), {
      run: run('grok', 'grok-4.5', { cleanup_status: 'complete' })
    })
  ]), /cleanup_status must be failed/);
});

test('aggregation accepts one success out of two and preserves safe failure metadata separately', () => {
  const failed = failure('claude', 'claude-opus-4-8');
  failed.run = run('claude', 'claude-opus-4-8', {
    ok: false,
    stage: 'inference',
    failure_code: 'deadline_exceeded',
    duration_ms: 30_000,
    stdout_bytes: null,
    stderr_bytes: null,
    stderr_present: null,
    usage: null,
    usage_complete: null
  });
  const aggregate = aggregateReviewOutcomes([
    failed,
    success('grok', 'grok-4.5', result())
  ]);

  assert.equal(aggregate.provider, 'claude+grok');
  assert.equal(aggregate.model, 'claude-opus-4-8+grok-4.5');
  assert.equal(aggregate.result.status, 'no_findings');
  assert.match(aggregate.result.summary, /1 of 2 reviewer runs succeeded \(1 non-abstaining, 0 abstained, 1 failed\)/);
  assert.equal(aggregate.reviews[0].source_index, 1);
  assert.deepEqual(aggregate.failures, [{
    source_index: 0,
    label: 'claude/claude-opus-4-8',
    provider: 'claude',
    model: 'claude-opus-4-8',
    failure: failed.failure,
    run: failed.run
  }]);
});

test('findings dedupe only on normalized identity and union reviewer receipts', () => {
  const first = finding({
    severity: 'medium',
    confidence: 0.99,
    title: 'Cafe\u0301 race',
    path: 'src/cafe\u0301.mjs',
    body: 'First reviewer wording.'
  });
  const second = finding({
    severity: 'high',
    confidence: 0.80,
    title: 'Caf\u00e9 race',
    path: 'src/caf\u00e9.mjs',
    body: 'Second reviewer wording.'
  });
  const repeatedByFirst = finding({
    severity: 'high',
    confidence: 0.70,
    title: first.title,
    path: first.path,
    body: 'Repeated wording from the first reviewer.'
  });
  const aggregate = aggregateReviewOutcomes([
    success('grok', 'grok-4.5', result({ findings: [first, repeatedByFirst] })),
    success('claude', 'claude-opus-4-8', result({ findings: [second] }))
  ]);

  assert.equal(aggregate.result.findings.length, 1);
  assert.deepEqual(aggregate.result.findings[0], second, 'higher-severity origin is the unmodified representative');
  assert.deepEqual(aggregate.reviews[0].result.findings[0], first);
  assert.deepEqual(aggregate.reviews[1].result.findings[0], second);
  assert.deepEqual(aggregate.sources.findings, [{
    aggregate_index: 0,
    review_indices: [0, 1],
    reviewer_labels: ['grok/grok-4.5', 'claude/claude-opus-4-8'],
    representative: { review_index: 1, item_index: 0 },
    occurrences: [
      { review_index: 0, item_index: 0, reviewer_label: 'grok/grok-4.5' },
      { review_index: 0, item_index: 1, reviewer_label: 'grok/grok-4.5' },
      { review_index: 1, item_index: 0, reviewer_label: 'claude/claude-opus-4-8' }
    ]
  }]);
});

test('source receipts retain distinct input indices even when reviewer labels are identical', () => {
  const first = comment({ confidence: 0.8, title: 'Same label review' });
  const second = comment({ confidence: 0.9, title: 'Same label review', body: 'Second run wording.' });
  const aggregate = aggregateReviewOutcomes([
    success('grok', 'grok-4.5', result({ comments: [first] })),
    success('grok', 'grok-4.5', result({ comments: [second] }))
  ]);

  assert.deepEqual(aggregate.sources.comments[0], {
    aggregate_index: 0,
    review_indices: [0, 1],
    reviewer_labels: ['grok/grok-4.5'],
    representative: { review_index: 1, item_index: 0 },
    occurrences: [
      { review_index: 0, item_index: 0, reviewer_label: 'grok/grok-4.5' },
      { review_index: 1, item_index: 0, reviewer_label: 'grok/grok-4.5' }
    ]
  });
  assert.deepEqual(aggregate.result.comments[0], second);
});

test('identity keeps different path, side, range, or title distinct while kind separates findings from comments', () => {
  const base = finding({ severity: 'high', title: 'Exact title', confidence: 0.99 });
  const variants = [
    finding({ ...base, path: 'src/other.mjs' }),
    finding({ ...base, line_side: 'old' }),
    finding({ ...base, line_start: 11, line_end: 11 }),
    finding({ ...base, title: 'exact title' })
  ];
  const aggregate = aggregateReviewOutcomes([
    success('a', 'one', result({ findings: [base, ...variants] })),
    success('b', 'two', result({ comments: [comment({
      category: 'reliability',
      title: base.title,
      path: base.path,
      line_side: base.line_side,
      line_start: base.line_start,
      line_end: base.line_end
    })] }))
  ]);

  assert.equal(aggregate.result.findings.length, 5);
  assert.equal(aggregate.result.comments.length, 1);
  assert.equal(aggregate.sources.findings.every((receipt) => receipt.review_indices.length === 1), true);
  assert.match(aggregate.result.summary, /5 of 5 unique findings are shown/);
});

test('findings rank by severity, confidence, reviewer order, then item order', () => {
  const itemsA = [
    finding({ severity: 'low', confidence: 1, title: 'low' }),
    finding({ severity: 'high', confidence: 0.8, title: 'high lower' }),
    finding({ severity: 'high', confidence: 0.9, title: 'high first tie' })
  ];
  const itemsB = [
    finding({ severity: 'blocker', confidence: 0.75, title: 'blocker' }),
    finding({ severity: 'high', confidence: 0.9, title: 'high second reviewer' }),
    finding({ severity: 'low', confidence: 0.5, title: 'omitted low' })
  ];
  const aggregate = aggregateReviewOutcomes([
    success('a', 'one', result({ findings: itemsA })),
    success('b', 'two', result({ findings: itemsB }))
  ]);

  assert.deepEqual(
    aggregate.result.findings.map((item) => item.title),
    ['blocker', 'high first tie', 'high second reviewer', 'high lower', 'low']
  );
  assert.match(aggregate.result.summary, /5 of 6 unique findings are shown/);
});

test('comments dedupe across category disagreements and rank by risk-oriented category, confidence, and reviewer order', () => {
  const duplicateA = comment({ category: 'maintainability', confidence: 0.99, title: 'Shared' });
  const duplicateB = comment({ category: 'testing', confidence: 0.80, title: 'Shared', body: 'Higher-ranked category wording.' });
  const aggregate = aggregateReviewOutcomes([
    success('a', 'one', result({ comments: [
      comment({ category: 'optimization', confidence: 1, title: 'Optimize' }),
      duplicateA,
      comment({ category: 'reliability', confidence: 0.8, title: 'Reliable' })
    ] })),
    success('b', 'two', result({ comments: [
      duplicateB,
      comment({ category: 'maintainability', confidence: 1, title: 'Maintain' })
    ] }))
  ]);

  assert.deepEqual(
    aggregate.result.comments.map((item) => item.title),
    ['Reliable', 'Shared', 'Maintain']
  );
  assert.deepEqual(aggregate.result.comments[1], duplicateB);
  assert.deepEqual(aggregate.sources.comments[1].review_indices, [0, 1]);
  assert.match(aggregate.result.summary, /3 of 4 unique engineering comments are shown/);
});

test('status is findings when any finding survives, regardless of another abstention', () => {
  const aggregate = aggregateReviewOutcomes([
    success('a', 'one', result({ status: 'abstain', summary: 'Insufficient.', findings: [], comments: [] })),
    success('b', 'two', result({ findings: [finding()] }))
  ]);
  assert.equal(aggregate.result.status, 'findings');
  assert.match(aggregate.result.summary, /1 non-abstaining, 1 abstained, 0 failed/);
  assert.deepEqual(validateReviewResult(aggregate.result, evidence()), aggregate.result);
});

test('status is no_findings when at least one successful reviewer did not abstain', () => {
  const aggregate = aggregateReviewOutcomes([
    success('a', 'one', result({ status: 'abstain', summary: 'Insufficient.', findings: [], comments: [] })),
    success('b', 'two', result())
  ]);
  assert.equal(aggregate.result.status, 'no_findings');
  assert.match(aggregate.result.summary, /1 non-abstaining, 1 abstained, 0 failed/);
  assert.deepEqual(validateReviewResult(aggregate.result, evidence()), aggregate.result);
});

test('status is abstain only when every successful reviewer abstained', () => {
  const aggregate = aggregateReviewOutcomes([
    success('a', 'one', result({ status: 'abstain', summary: 'First abstained.', findings: [], comments: [] })),
    success('b', 'two', result({ status: 'abstain', summary: 'Second abstained.', findings: [], comments: [] }))
  ]);
  assert.equal(aggregate.result.status, 'abstain');
  assert.deepEqual(aggregate.result.findings, []);
  assert.deepEqual(aggregate.result.comments, []);
  assert.deepEqual(aggregate.sources, { findings: [], comments: [] });
  assert.match(aggregate.result.summary, /All successful reviewers abstained\.$/);
  assert.deepEqual(validateReviewResult(aggregate.result, evidence()), aggregate.result);
});

test('zero successful reviews throws a typed failure with all safe metadata', () => {
  const outcomes = [
    failure('grok', 'grok-4.5'),
    failure('claude', 'claude-opus-4-8', {
      stage: 'validation',
      failure_code: 'invalid_review_schema',
      message: 'The response did not satisfy the local schema.'
    })
  ];
  assert.throws(
    () => aggregateReviewOutcomes(outcomes),
    (error) => {
      assert.equal(error instanceof ReviewAggregationError, true);
      assert.equal(error.code, 'no_successful_reviews');
      assert.equal(error.failures.length, 2);
      assert.equal(error.failures[1].failure.failure_code, 'invalid_review_schema');
      assert.equal(Object.isFrozen(error.failures), true);
      return true;
    }
  );
});

test('aggregate is a detached deeply immutable snapshot without changing inputs', () => {
  const original = success('grok', 'grok-4.5', result({ findings: [finding()] }), {
    run: run('grok', 'grok-4.5')
  });
  const before = structuredClone(original);
  const aggregate = aggregateReviewOutcomes([original]);

  assert.deepEqual(original, before);
  assert.notEqual(aggregate.reviews[0].result, original.result);
  assert.notEqual(aggregate.result.findings[0], original.result.findings[0]);
  assert.equal(Object.isFrozen(aggregate), true);
  assert.equal(Object.isFrozen(aggregate.result.findings[0]), true);
  assert.equal(Object.isFrozen(aggregate.reviews[0].run.usage), true);
  assert.throws(() => { aggregate.result.findings[0].title = 'mutated'; }, TypeError);
  original.result.findings[0].title = 'changed later';
  assert.equal(aggregate.result.findings[0].title, 'A grounded defect');
  assert.equal(aggregate.reviews[0].result.findings[0].title, 'A grounded defect');
});

test('strict boundary rejects invalid cardinality, ambiguous outcomes, unsafe failures, and stale schemas', () => {
  assert.throws(() => aggregateReviewOutcomes([]), /one or two entries/);
  assert.throws(() => aggregateReviewOutcomes([failure('a', 'one'), failure('b', 'two'), failure('c', 'three')]), /one or two entries/);
  assert.throws(() => aggregateReviewOutcomes([{ provider: 'a', model: 'one' }]), /exactly one of result or failure/);
  assert.throws(() => aggregateReviewOutcomes([{
    ...success('a', 'one', result()),
    failure: failure('a', 'one').failure
  }]), /exactly one of result or failure/);
  assert.throws(() => aggregateReviewOutcomes([{
    ...failure('a', 'one'),
    unexpected: true
  }]), /unknown properties/);
  assert.throws(() => aggregateReviewOutcomes([failure('a', 'one', { message: 'forged\nstatus' })]), /one line/);
  assert.throws(() => aggregateReviewOutcomes([failure('a', 'one', { message: 'Unicode snowman \u2603' })]), /printable ASCII/);
  assert.throws(() => aggregateReviewOutcomes([success('a', 'one', result(), {
    run: run('b', 'two')
  })]), /provider and model must match/);
  assert.throws(() => aggregateReviewOutcomes([success('a', 'one', result(), {
    run: { ...run('a', 'one'), secret: 'must not pass through' }
  })]), /unknown properties/);
  assert.throws(() => aggregateReviewOutcomes([success('a', 'one', result(), {
    run: { ...run('a', 'one'), ok: 'yes' }
  })]), /ok must be boolean/);
  assert.throws(() => aggregateReviewOutcomes([success('a', 'one', result(), {
    run: { ...run('a', 'one'), duration_ms: -1 }
  })]), /nonnegative safe integer/);
  assert.throws(() => aggregateReviewOutcomes([success('a', 'one', result(), {
    run: { ...run('a', 'one'), stage: 'complete\u001b[31m' }
  })]), /unsafe terminal controls/);
  assert.throws(() => aggregateReviewOutcomes([success('a', 'one', result(), {
    summaryAdvisory: { schema_version: '1', status: 'notes', advisory: 'Invalid.', notes: [] }
  })]), /requires a note/);
  assert.throws(() => aggregateReviewOutcomes([success('a', 'one', result(), {
    summaryAdvisory: {
      schema_version: '1',
      status: 'notes',
      advisory: 'Invalid.',
      notes: [{
        category: 'unsupported_claim',
        confidence: 0.9,
        summary_start: 0,
        summary_end: 1,
        quote: 'x',
        advice: 'y',
        secret: 'must not pass through'
      }]
    }
  })]), /unknown properties/);
  assert.throws(() => aggregateReviewOutcomes([success('a', 'one', result({ schema_version: '1' }))]), /schema_version must be/);
  assert.throws(() => aggregateReviewOutcomes([success('a', 'one', result({
    status: 'abstain',
    findings: [],
    comments: [comment()]
  }))]), /abstain status cannot contain comments/);
});

test('composite labels remain bounded, deterministic, and preserve full labels in review records', () => {
  const providerA = `a${'x'.repeat(118)}`;
  const providerB = `b${'y'.repeat(118)}`;
  const modelA = `m${'x'.repeat(198)}`;
  const modelB = `n${'y'.repeat(198)}`;
  const outcomes = [
    success(providerA, modelA, result()),
    success(providerB, modelB, result())
  ];
  const first = aggregateReviewOutcomes(outcomes);
  const second = aggregateReviewOutcomes(outcomes);

  assert.equal(first.provider.length, 120);
  assert.equal(first.model.length, 200);
  assert.equal(first.provider, second.provider);
  assert.equal(first.model, second.model);
  assert.match(first.provider, /\+2#[0-9a-f]{12}$/);
  assert.equal(first.reviews[0].provider, providerA);
  assert.equal(first.reviews[1].model, modelB);
});
