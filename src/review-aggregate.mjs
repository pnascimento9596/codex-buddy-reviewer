import { createHash } from 'node:crypto';
import { hasUnsafeTerminalControls } from './policy.mjs';
import { REVIEW_SCHEMA_VERSION } from './review-schema.mjs';

const AGGREGATE_FINDING_LIMIT = 5;
const AGGREGATE_COMMENT_LIMIT = 3;
const SEVERITY_RANK = Object.freeze({ blocker: 0, high: 1, medium: 2, low: 3 });
// Engineering comments have no severity field, so their fixed risk-oriented
// order is reliability, testing, maintainability, then optimization.
const COMMENT_CATEGORY_RANK = Object.freeze({ reliability: 0, testing: 1, maintainability: 2, optimization: 3 });
const RESULT_KEYS = new Set(['schema_version', 'status', 'summary', 'findings', 'comments']);
const FINDING_KEYS = new Set([
  'severity', 'confidence', 'title', 'body', 'impact', 'path', 'line_side',
  'line_start', 'line_end', 'evidence', 'recommendation'
]);
const COMMENT_KEYS = new Set([
  'category', 'confidence', 'title', 'body', 'path', 'line_side',
  'line_start', 'line_end', 'evidence', 'recommendation'
]);
const SUCCESS_KEYS = new Set(['provider', 'model', 'result', 'run', 'summaryAdvisory']);
const FAILURE_KEYS = new Set(['provider', 'model', 'failure', 'run']);
const FAILURE_METADATA_KEYS = new Set(['stage', 'failure_code', 'message']);
const RUN_KEYS = new Set([
  'schema_version', 'ok', 'provider', 'model', 'stage', 'failure_code',
  'duration_ms', 'stdout_bytes', 'stderr_bytes', 'stderr_present', 'usage',
  'usage_complete', 'cost_usd_ticks', 'cleanup_status'
]);
const REQUIRED_RUN_KEYS = [...RUN_KEYS].filter((key) => key !== 'cleanup_status');
const USAGE_KEYS = new Set([
  'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'total_tokens'
]);
const SUMMARY_ADVISORY_KEYS = new Set(['schema_version', 'status', 'advisory', 'notes']);
const SUMMARY_NOTE_KEYS = new Set([
  'category', 'confidence', 'summary_start', 'summary_end', 'quote', 'advice'
]);
const SUMMARY_STATUS = new Set(['notes', 'no_notes', 'abstain']);
const SUMMARY_CATEGORY = new Set([
  'unsupported_claim', 'missing_verification', 'overstatement', 'scope_ambiguity'
]);
const STATUS = new Set(['findings', 'no_findings', 'abstain']);
const LINE_SIDE = new Set(['new', 'old']);

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unknown properties: ${unknown.join(', ')}`);
}

function assertRequiredKeys(value, required, label) {
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new TypeError(`${label} is missing required properties: ${missing.join(', ')}`);
}

function assertText(value, label, maximum, {
  singleLine = false,
  visibleAscii = false,
  printableAscii = false
} = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty text`);
  if (value.length > maximum) throw new TypeError(`${label} exceeds ${maximum} characters`);
  if (hasUnsafeTerminalControls(value)) throw new TypeError(`${label} contains unsafe terminal controls`);
  if (singleLine && /[\r\n\t]/u.test(value)) throw new TypeError(`${label} must be one line`);
  if (visibleAscii && !/^[\x21-\x7e]+$/u.test(value)) throw new TypeError(`${label} must contain visible ASCII only`);
  if (printableAscii && !/^[\x20-\x7e]+$/u.test(value)) throw new TypeError(`${label} must contain printable ASCII only`);
}

function assertConfidence(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a finite number from 0 to 1`);
  }
}

function assertLineRange(item, label) {
  if (!LINE_SIDE.has(item.line_side)) throw new TypeError(`${label}.line_side must be new or old`);
  if (!Number.isInteger(item.line_start) || item.line_start < 1) {
    throw new TypeError(`${label}.line_start must be a positive integer`);
  }
  if (!Number.isInteger(item.line_end) || item.line_end < item.line_start) {
    throw new TypeError(`${label}.line_end must be at least line_start`);
  }
}

function validateFinding(item, label) {
  if (!plainObject(item)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(item, FINDING_KEYS, label);
  assertRequiredKeys(item, [...FINDING_KEYS], label);
  if (!Object.hasOwn(SEVERITY_RANK, item.severity)) throw new TypeError(`${label}.severity is invalid`);
  assertConfidence(item.confidence, `${label}.confidence`);
  for (const [field, maximum] of [
    ['title', 160], ['body', 2000], ['impact', 1000], ['path', 500],
    ['evidence', 1600], ['recommendation', 1600]
  ]) assertText(item[field], `${label}.${field}`, maximum);
  assertLineRange(item, label);
}

function validateComment(item, label) {
  if (!plainObject(item)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(item, COMMENT_KEYS, label);
  assertRequiredKeys(item, [...COMMENT_KEYS], label);
  if (!Object.hasOwn(COMMENT_CATEGORY_RANK, item.category)) throw new TypeError(`${label}.category is invalid`);
  assertConfidence(item.confidence, `${label}.confidence`);
  for (const [field, maximum] of [
    ['title', 160], ['body', 1600], ['path', 500], ['evidence', 1600], ['recommendation', 1600]
  ]) assertText(item[field], `${label}.${field}`, maximum);
  assertLineRange(item, label);
}

function validateResult(result, label) {
  if (!plainObject(result)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(result, RESULT_KEYS, label);
  assertRequiredKeys(result, ['schema_version', 'status', 'summary', 'findings'], label);
  if (result.schema_version !== REVIEW_SCHEMA_VERSION) {
    throw new TypeError(`${label}.schema_version must be ${REVIEW_SCHEMA_VERSION}`);
  }
  if (!STATUS.has(result.status)) throw new TypeError(`${label}.status is invalid`);
  assertText(result.summary, `${label}.summary`, 1200);
  if (!Array.isArray(result.findings) || result.findings.length > AGGREGATE_FINDING_LIMIT) {
    throw new TypeError(`${label}.findings must contain at most ${AGGREGATE_FINDING_LIMIT} items`);
  }
  if (result.status === 'findings' && result.findings.length === 0) {
    throw new TypeError(`${label} with findings status requires a finding`);
  }
  if (result.status !== 'findings' && result.findings.length !== 0) {
    throw new TypeError(`${label} with ${result.status} status cannot contain findings`);
  }
  result.findings.forEach((item, index) => validateFinding(item, `${label}.findings[${index}]`));

  const comments = result.comments ?? [];
  if (!Array.isArray(comments) || comments.length > AGGREGATE_COMMENT_LIMIT) {
    throw new TypeError(`${label}.comments must contain at most ${AGGREGATE_COMMENT_LIMIT} items`);
  }
  if (result.status === 'abstain' && comments.length !== 0) {
    throw new TypeError(`${label} with abstain status cannot contain comments`);
  }
  comments.forEach((item, index) => validateComment(item, `${label}.comments[${index}]`));
}

function validateFailure(failure, label) {
  if (!plainObject(failure)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(failure, FAILURE_METADATA_KEYS, label);
  assertRequiredKeys(failure, [...FAILURE_METADATA_KEYS], label);
  for (const field of ['stage', 'failure_code']) {
    assertText(failure[field], `${label}.${field}`, 64, { singleLine: true, visibleAscii: true });
    if (!/^[a-z][a-z0-9_]*$/u.test(failure[field])) {
      throw new TypeError(`${label}.${field} must be a lowercase safe identifier`);
    }
  }
  assertText(failure.message, `${label}.message`, 240, { singleLine: true, printableAscii: true });
}

function assertNullableNonnegativeInteger(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${label} must be null or a nonnegative safe integer`);
  }
}

function validateRun(run, outcome, label) {
  if (!plainObject(run)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(run, RUN_KEYS, label);
  assertRequiredKeys(run, REQUIRED_RUN_KEYS, label);
  if (run.schema_version !== '1') throw new TypeError(`${label}.schema_version must be 1`);
  if (typeof run.ok !== 'boolean') throw new TypeError(`${label}.ok must be boolean`);
  if (run.provider !== outcome.provider || run.model !== outcome.model) {
    throw new TypeError(`${label} provider and model must match the review outcome`);
  }
  if (Object.hasOwn(run, 'cleanup_status') && run.cleanup_status !== 'failed') {
    throw new TypeError(`${label}.cleanup_status must be failed when present`);
  }
  assertText(run.stage, `${label}.stage`, 64, { singleLine: true, visibleAscii: true });
  if (run.failure_code !== null) {
    assertText(run.failure_code, `${label}.failure_code`, 64, { singleLine: true, visibleAscii: true });
    if (!/^[a-z][a-z0-9_]*$/u.test(run.failure_code)) {
      throw new TypeError(`${label}.failure_code must be null or a lowercase safe identifier`);
    }
  }
  for (const field of ['duration_ms', 'stdout_bytes', 'stderr_bytes', 'cost_usd_ticks']) {
    assertNullableNonnegativeInteger(run[field], `${label}.${field}`);
  }
  for (const field of ['stderr_present', 'usage_complete']) {
    if (run[field] !== null && typeof run[field] !== 'boolean') {
      throw new TypeError(`${label}.${field} must be null or boolean`);
    }
  }
  if (run.usage !== null) {
    if (!plainObject(run.usage)) throw new TypeError(`${label}.usage must be null or an object`);
    assertExactKeys(run.usage, USAGE_KEYS, `${label}.usage`);
    assertRequiredKeys(run.usage, [...USAGE_KEYS], `${label}.usage`);
    for (const field of USAGE_KEYS) {
      assertNullableNonnegativeInteger(run.usage[field], `${label}.usage.${field}`);
    }
  }
}

function validateSummaryAdvisory(advisory, label) {
  if (!plainObject(advisory)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(advisory, SUMMARY_ADVISORY_KEYS, label);
  assertRequiredKeys(advisory, [...SUMMARY_ADVISORY_KEYS], label);
  if (advisory.schema_version !== '1') throw new TypeError(`${label}.schema_version must be 1`);
  if (!SUMMARY_STATUS.has(advisory.status)) throw new TypeError(`${label}.status is invalid`);
  assertText(advisory.advisory, `${label}.advisory`, 800);
  if (!Array.isArray(advisory.notes) || advisory.notes.length > 5) {
    throw new TypeError(`${label}.notes must contain at most five items`);
  }
  if (advisory.status === 'notes' && advisory.notes.length === 0) {
    throw new TypeError(`${label} with notes status requires a note`);
  }
  if (advisory.status !== 'notes' && advisory.notes.length !== 0) {
    throw new TypeError(`${label} with ${advisory.status} status cannot contain notes`);
  }
  advisory.notes.forEach((note, index) => {
    const noteLabel = `${label}.notes[${index}]`;
    if (!plainObject(note)) throw new TypeError(`${noteLabel} must be an object`);
    assertExactKeys(note, SUMMARY_NOTE_KEYS, noteLabel);
    assertRequiredKeys(note, [...SUMMARY_NOTE_KEYS], noteLabel);
    if (!SUMMARY_CATEGORY.has(note.category)) throw new TypeError(`${noteLabel}.category is invalid`);
    assertConfidence(note.confidence, `${noteLabel}.confidence`);
    if (!Number.isInteger(note.summary_start) || note.summary_start < 0) {
      throw new TypeError(`${noteLabel}.summary_start must be a nonnegative integer`);
    }
    if (!Number.isInteger(note.summary_end) || note.summary_end <= note.summary_start) {
      throw new TypeError(`${noteLabel}.summary_end must be greater than summary_start`);
    }
    assertText(note.quote, `${noteLabel}.quote`, 600);
    assertText(note.advice, `${noteLabel}.advice`, 800);
  });
}

function cloneJsonValue(value, label, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`${label} must contain JSON-compatible values`);
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain circular references`);
  ancestors.add(value);
  let clone;
  if (Array.isArray(value)) {
    clone = value.map((item, index) => cloneJsonValue(item, `${label}[${index}]`, ancestors));
  } else {
    if (!plainObject(value)) throw new TypeError(`${label} must contain plain objects only`);
    clone = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(clone, key, {
        value: cloneJsonValue(value[key], `${label}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }
  ancestors.delete(value);
  return clone;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function reviewerLabel(provider, model) {
  return `${provider}/${model}`;
}

function validateOutcome(outcome, index) {
  const label = `review outcome ${index}`;
  if (!plainObject(outcome)) throw new TypeError(`${label} must be an object`);
  assertRequiredKeys(outcome, ['provider', 'model'], label);
  assertText(outcome.provider, `${label}.provider`, 120, { visibleAscii: true });
  assertText(outcome.model, `${label}.model`, 200, { visibleAscii: true });

  const isSuccess = Object.hasOwn(outcome, 'result');
  const isFailure = Object.hasOwn(outcome, 'failure');
  if (isSuccess === isFailure) throw new TypeError(`${label} must contain exactly one of result or failure`);
  assertExactKeys(outcome, isSuccess ? SUCCESS_KEYS : FAILURE_KEYS, label);

  if (isSuccess) validateResult(outcome.result, `${label}.result`);
  else validateFailure(outcome.failure, `${label}.failure`);
  if (Object.hasOwn(outcome, 'run')) validateRun(outcome.run, outcome, `${label}.run`);
  if (Object.hasOwn(outcome, 'summaryAdvisory') && outcome.summaryAdvisory !== null) {
    validateSummaryAdvisory(outcome.summaryAdvisory, `${label}.summaryAdvisory`);
  }
  return isSuccess;
}

function normalizedIdentityText(value) {
  return value.normalize('NFC');
}

function itemIdentity(item, type) {
  return JSON.stringify([
    type,
    normalizedIdentityText(item.path),
    item.line_side,
    item.line_start,
    item.line_end,
    normalizedIdentityText(item.title)
  ]);
}

function occurrenceRank(left, right) {
  return right.item.confidence - left.item.confidence
    || left.reviewIndex - right.reviewIndex
    || left.itemIndex - right.itemIndex;
}

function compareOccurrences(left, right, type) {
  const categoryRank = type === 'finding'
    ? SEVERITY_RANK[left.item.severity] - SEVERITY_RANK[right.item.severity]
    : COMMENT_CATEGORY_RANK[left.item.category] - COMMENT_CATEGORY_RANK[right.item.category];
  return categoryRank || occurrenceRank(left, right);
}

function collectUnique(reviews, type) {
  const byIdentity = new Map();
  const collection = type === 'finding' ? 'findings' : 'comments';
  for (const review of reviews) {
    const items = review.result[collection] ?? [];
    items.forEach((item, itemIndex) => {
      const occurrence = {
        item,
        itemIndex,
        reviewIndex: review.source_index,
        reviewerLabel: review.label
      };
      const key = itemIdentity(item, type);
      const existing = byIdentity.get(key);
      if (!existing) {
        byIdentity.set(key, { representative: occurrence, sources: [occurrence] });
        return;
      }
      existing.sources.push(occurrence);
      if (compareOccurrences(occurrence, existing.representative, type) < 0) {
        existing.representative = occurrence;
      }
    });
  }
  return [...byIdentity.values()];
}

function compareFindings(left, right) {
  const a = left.representative;
  const b = right.representative;
  return compareOccurrences(a, b, 'finding');
}

function compareComments(left, right) {
  const a = left.representative;
  const b = right.representative;
  return compareOccurrences(a, b, 'comment');
}

function sourceReceipt(entry, aggregateIndex) {
  const indices = [];
  const labels = [];
  for (const source of entry.sources) {
    if (!indices.includes(source.reviewIndex)) indices.push(source.reviewIndex);
    if (!labels.includes(source.reviewerLabel)) labels.push(source.reviewerLabel);
  }
  return {
    aggregate_index: aggregateIndex,
    review_indices: indices,
    reviewer_labels: labels,
    representative: {
      review_index: entry.representative.reviewIndex,
      item_index: entry.representative.itemIndex
    },
    occurrences: entry.sources.map((source) => ({
      review_index: source.reviewIndex,
      item_index: source.itemIndex,
      reviewer_label: source.reviewerLabel
    }))
  };
}

function boundedComposite(values, maximum) {
  const unique = [...new Set(values)];
  const joined = unique.join('+');
  if (joined.length <= maximum) return joined;
  const digest = createHash('sha256').update(joined).digest('hex').slice(0, 12);
  const suffix = `+${unique.length}#${digest}`;
  return `${joined.slice(0, maximum - suffix.length)}${suffix}`;
}

function aggregateSummary({
  status,
  successful,
  nonAbstaining,
  abstained,
  attempted,
  uniqueFindingCount,
  shownFindings,
  uniqueCommentCount,
  shownComments
}) {
  const failed = attempted - successful;
  const prefix = `Independent review aggregation completed: ${successful} of ${attempted} reviewer runs succeeded (${nonAbstaining} non-abstaining, ${abstained} abstained, ${failed} failed).`;
  if (status === 'abstain') return `${prefix} All successful reviewers abstained.`;
  const findingClause = status === 'findings'
    ? ` ${shownFindings} of ${uniqueFindingCount} unique findings are shown.`
    : ' No validated defect findings were reported.';
  const commentClause = uniqueCommentCount > 0
    ? ` ${shownComments} of ${uniqueCommentCount} unique engineering comments are shown.`
    : ' No engineering comments were reported.';
  return `${prefix}${findingClause}${commentClause}`;
}

function outputReview(outcome, sourceIndex) {
  const output = {
    source_index: sourceIndex,
    label: reviewerLabel(outcome.provider, outcome.model),
    provider: outcome.provider,
    model: outcome.model,
    result: cloneJsonValue(outcome.result, `review outcome ${sourceIndex}.result`)
  };
  if (Object.hasOwn(outcome, 'run')) output.run = cloneJsonValue(outcome.run, `review outcome ${sourceIndex}.run`);
  if (Object.hasOwn(outcome, 'summaryAdvisory')) {
    output.summaryAdvisory = cloneJsonValue(
      outcome.summaryAdvisory,
      `review outcome ${sourceIndex}.summaryAdvisory`
    );
  }
  return output;
}

function outputFailure(outcome, sourceIndex) {
  const output = {
    source_index: sourceIndex,
    label: reviewerLabel(outcome.provider, outcome.model),
    provider: outcome.provider,
    model: outcome.model,
    failure: cloneJsonValue(outcome.failure, `review outcome ${sourceIndex}.failure`)
  };
  if (Object.hasOwn(outcome, 'run')) output.run = cloneJsonValue(outcome.run, `review outcome ${sourceIndex}.run`);
  return output;
}

export class ReviewAggregationError extends Error {
  constructor(failures) {
    super('No reviewer completed successfully.');
    this.name = 'ReviewAggregationError';
    this.code = 'no_successful_reviews';
    this.failures = deepFreeze(failures);
  }
}

/**
 * Deterministically combines one or two independently validated review outcomes.
 *
 * A success has exactly { provider, model, result, run?, summaryAdvisory? }.
 * A safe failure has exactly { provider, model, failure, run? }, where failure is
 * { stage, failure_code, message }. Source indices are zero-based input indices.
 * No provider is called and no model-generated synthesis is performed. The
 * caller must first prove that every success is bound to the same immutable
 * prepared request because this deliberately small legacy boundary carries no
 * evidence or snapshot payload.
 */
export function aggregateReviewOutcomes(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length < 1 || outcomes.length > 2) {
    throw new TypeError('review outcomes must be an array containing one or two entries');
  }

  const successes = [];
  const failures = [];
  outcomes.forEach((outcome, index) => {
    if (validateOutcome(outcome, index)) successes.push(outputReview(outcome, index));
    else failures.push(outputFailure(outcome, index));
  });
  if (successes.length === 0) throw new ReviewAggregationError(failures);

  const uniqueFindings = collectUnique(successes, 'finding').sort(compareFindings);
  const uniqueComments = collectUnique(successes, 'comment').sort(compareComments);
  const selectedFindings = uniqueFindings.slice(0, AGGREGATE_FINDING_LIMIT);
  const selectedComments = uniqueComments.slice(0, AGGREGATE_COMMENT_LIMIT);
  const nonAbstainingSuccesses = successes.filter((review) => review.result.status !== 'abstain').length;
  const hasNonAbstainingSuccess = nonAbstainingSuccesses > 0;
  const status = selectedFindings.length > 0
    ? 'findings'
    : hasNonAbstainingSuccess ? 'no_findings' : 'abstain';
  const comments = status === 'abstain'
    ? []
    : selectedComments.map((entry) => entry.representative.item);
  const result = {
    schema_version: REVIEW_SCHEMA_VERSION,
    status,
    summary: aggregateSummary({
      status,
      successful: successes.length,
      nonAbstaining: nonAbstainingSuccesses,
      abstained: successes.length - nonAbstainingSuccesses,
      attempted: outcomes.length,
      uniqueFindingCount: uniqueFindings.length,
      shownFindings: selectedFindings.length,
      uniqueCommentCount: uniqueComments.length,
      shownComments: comments.length
    }),
    findings: selectedFindings.map((entry) => entry.representative.item),
    comments
  };

  return deepFreeze({
    provider: boundedComposite(outcomes.map((outcome) => outcome.provider), 120),
    model: boundedComposite(outcomes.map((outcome) => outcome.model), 200),
    reviews: successes,
    failures,
    result,
    sources: {
      findings: selectedFindings.map(sourceReceipt),
      comments: status === 'abstain' ? [] : selectedComments.map(sourceReceipt)
    }
  });
}
