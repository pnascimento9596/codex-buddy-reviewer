import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { escapeTerminalControls, pathPolicy } from './policy.mjs';
import { assessProviderModelIdentifier } from './secret-scan.mjs';
import {
  canonicalJson,
  ensurePrivateStatePath,
  opaqueKey,
  resolveRuntimeDataDir,
  withFileLock,
  workspaceKey,
  writePrivateJsonAtomic,
  writePrivateJsonExclusive
} from './state.mjs';

export const PET_EVENT_CONTRACT = Object.freeze({
  schemaVersions: Object.freeze(['1', '2']),
  eventTypes: Object.freeze([
    'mode_changed',
    'turn_started',
    'turn_finished',
    'review_started',
    'review_completed',
    'review_degraded'
  ]),
  presentationStates: Object.freeze(['idle', 'working', 'reviewing', 'success', 'findings', 'abstain', 'error']),
  reviewStatuses: Object.freeze(['findings', 'no_findings', 'abstain']),
  reviewerOutcomeStatuses: Object.freeze(['succeeded', 'failed', 'circuit_open']),
  severities: Object.freeze(['blocker', 'high', 'medium', 'low']),
  commentCategories: Object.freeze(['optimization', 'reliability', 'maintainability', 'testing']),
  summaryAdvisoryStatuses: Object.freeze(['notes', 'no_notes', 'abstain']),
  summaryNoteCategories: Object.freeze([
    'unsupported_claim', 'missing_verification', 'overstatement', 'scope_ambiguity'
  ]),
  presentationPersonalities: Object.freeze(['precise', 'warm', 'wry'])
});

const EVENT_TYPES = new Set(PET_EVENT_CONTRACT.eventTypes);
const PRESENTATION_STATES = new Set(PET_EVENT_CONTRACT.presentationStates);
const REVIEW_STATUSES = new Set(PET_EVENT_CONTRACT.reviewStatuses);
const REVIEWER_OUTCOME_STATUSES = new Set(PET_EVENT_CONTRACT.reviewerOutcomeStatuses);
const SEVERITIES = new Set(PET_EVENT_CONTRACT.severities);
const COMMENT_CATEGORIES = new Set(PET_EVENT_CONTRACT.commentCategories);
const SUMMARY_ADVISORY_STATUSES = new Set(PET_EVENT_CONTRACT.summaryAdvisoryStatuses);
const SUMMARY_NOTE_CATEGORIES = new Set(PET_EVENT_CONTRACT.summaryNoteCategories);
const PRESENTATION_PERSONALITIES = new Set(PET_EVENT_CONTRACT.presentationPersonalities);
const WORKSPACE_PATTERN = /^[0-9a-f]{16}$/;
const OPAQUE_PATTERN = /^[0-9a-f]{24}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROTOCOL_DIRECTORY = '_protocol';
const LEGACY_INDEX_SCHEMA_VERSION = '1';
const PRODUCER_SCHEMA_VERSION = '1';
const OUTBOX_LOCK_TIMEOUT_MS = 30_000;
const OUTBOX_CONTENT_TTL_MS = 24 * 60 * 60_000;
const REVIEWER_OUTCOME_LIMIT = 2;
const REVIEWER_FINDING_LIMIT = 3;
const REVIEWER_COMMENT_LIMIT = 2;

function boundedText(value, maximum) {
  if (value === null || value === undefined) return null;
  const safe = escapeTerminalControls(String(value)).replaceAll('\r', '');
  return safe.length <= maximum ? safe : `${safe.slice(0, maximum - 1)}…`;
}

function boundedIdentityText(value, maximum) {
  const safe = escapeTerminalControls(String(value))
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t');
  return safe.length <= maximum ? safe : `${safe.slice(0, maximum - 1)}…`;
}

function assertProviderModel(value, label, optional = false) {
  if (optional && (value === null || value === undefined)) return;
  if (!assessProviderModelIdentifier(value).allowed) {
    throw new Error(`${label} is invalid or contains credential material`);
  }
}

function publicReview(result, provider, model) {
  if (!result) return null;
  assertProviderModel(model, 'Buddy event review.model');
  return {
    status: result.status,
    summary: boundedText(result.summary, 1600),
    findings: (result.findings ?? []).slice(0, 5).map((finding) => ({
      severity: finding.severity,
      confidence: finding.confidence,
      title: boundedText(finding.title, 160),
      body: boundedText(finding.body, 1200),
      path: boundedText(finding.path, 500),
      line_side: finding.line_side ?? 'new',
      line_start: finding.line_start,
      line_end: finding.line_end,
      recommendation: boundedText(finding.recommendation, 1200)
    })),
    comments: (result.comments ?? []).slice(0, 3).map((comment) => ({
      category: comment.category,
      confidence: comment.confidence,
      title: boundedText(comment.title, 160),
      body: boundedText(comment.body, 1200),
      path: boundedText(comment.path, 500),
      line_side: comment.line_side ?? 'new',
      line_start: comment.line_start,
      line_end: comment.line_end,
      recommendation: boundedText(comment.recommendation, 1200)
    })),
    provider: boundedText(provider, 120),
    model: boundedText(model, 200)
  };
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedKeys(value, allowed, required, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length || missing.length) throw new Error(`${label} contains unsupported or missing fields`);
}

function assertSourceText(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be non-empty text of at most ${maximum} characters`);
  }
}

function validateSourceReviewItem(item, kind, label) {
  const common = kind === 'finding'
    ? ['severity', 'confidence', 'title', 'body', 'path', 'line_side', 'line_start', 'line_end', 'recommendation']
    : ['category', 'confidence', 'title', 'body', 'path', 'line_side', 'line_start', 'line_end', 'recommendation'];
  const complete = kind === 'finding' ? [...common, 'impact', 'evidence'] : [...common, 'evidence'];
  const legacy = common.filter((key) => key !== 'line_side');
  const actual = Object.keys(item ?? {}).sort();
  if (!plainObject(item) || ![common, complete, legacy].some((keys) => (
    keys.length === actual.length && [...keys].sort().every((key, index) => key === actual[index])
  ))) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
  if (kind === 'finding' ? !SEVERITIES.has(item.severity) : !COMMENT_CATEGORIES.has(item.category)) {
    throw new Error(`${label} has an unsupported classification`);
  }
  if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
    throw new Error(`${label}.confidence must be between 0 and 1`);
  }
  for (const [field, maximum] of [
    ['title', 160], ['body', kind === 'finding' ? 2000 : 1600], ['path', 500], ['recommendation', 1600]
  ]) assertSourceText(item[field], maximum, `${label}.${field}`);
  if (Object.hasOwn(item, 'impact')) assertSourceText(item.impact, 1000, `${label}.impact`);
  if (Object.hasOwn(item, 'evidence')) assertSourceText(item.evidence, 1600, `${label}.evidence`);
  if (item.line_side !== undefined && !['new', 'old'].includes(item.line_side)) {
    throw new Error(`${label}.line_side must be new or old`);
  }
  if (!pathPolicy(item.path).allowed) throw new Error(`${label}.path is not an allowlisted repository-relative path`);
  if (!Number.isInteger(item.line_start) || item.line_start < 1
      || !Number.isInteger(item.line_end) || item.line_end < item.line_start) {
    throw new Error(`${label} has an invalid line range`);
  }
}

function publicReviewerResult(result, label) {
  assertAllowedKeys(
    result,
    ['schema_version', 'status', 'summary', 'findings', 'comments'],
    ['status', 'summary', 'findings'],
    label
  );
  if (Object.hasOwn(result, 'schema_version') && !['1', '2'].includes(result.schema_version)) {
    throw new Error(`${label}.schema_version is unsupported`);
  }
  if (!REVIEW_STATUSES.has(result.status)) throw new Error(`${label}.status is unsupported`);
  assertSourceText(result.summary, 1200, `${label}.summary`);
  if (!Array.isArray(result.findings) || result.findings.length > 5) {
    throw new Error(`${label}.findings must be an array of at most 5 items`);
  }
  const comments = result.comments ?? [];
  if (!Array.isArray(comments) || comments.length > 3) {
    throw new Error(`${label}.comments must be an array of at most 3 items`);
  }
  if ((result.status === 'findings') !== (result.findings.length > 0)) {
    throw new Error(`${label} has findings inconsistent with its status`);
  }
  if (result.status === 'abstain' && comments.length > 0) {
    throw new Error(`${label} cannot contain comments when its status is abstain`);
  }
  result.findings.forEach((item, index) => validateSourceReviewItem(item, 'finding', `${label}.findings[${index}]`));
  comments.forEach((item, index) => validateSourceReviewItem(item, 'comment', `${label}.comments[${index}]`));
  return {
    status: result.status,
    summary: boundedText(result.summary, 800),
    findings: result.findings.slice(0, REVIEWER_FINDING_LIMIT).map((finding) => ({
      severity: finding.severity,
      confidence: finding.confidence,
      title: boundedText(finding.title, 160),
      body: boundedText(finding.body, 1200),
      path: boundedText(finding.path, 500),
      line_side: finding.line_side ?? 'new',
      line_start: finding.line_start,
      line_end: finding.line_end,
      recommendation: boundedText(finding.recommendation, 1200)
    })),
    comments: comments.slice(0, REVIEWER_COMMENT_LIMIT).map((comment) => ({
      category: comment.category,
      confidence: comment.confidence,
      title: boundedText(comment.title, 160),
      body: boundedText(comment.body, 1200),
      path: boundedText(comment.path, 500),
      line_side: comment.line_side ?? 'new',
      line_start: comment.line_start,
      line_end: comment.line_end,
      recommendation: boundedText(comment.recommendation, 1200)
    }))
  };
}

function validateReviewerIdentity(outcome, label) {
  if (!Number.isInteger(outcome.source_index) || outcome.source_index < 0 || outcome.source_index >= REVIEWER_OUTCOME_LIMIT) {
    throw new Error(`${label}.source_index must identify one of at most two configured reviewers`);
  }
  assertSourceText(outcome.provider, 120, `${label}.provider`);
  assertSourceText(outcome.model, 200, `${label}.model`);
  assertProviderModel(outcome.model, `${label}.model`);
}

function publicReviewerFailure(failure, label) {
  assertExactKeys(failure, ['stage', 'failure_code', 'message'], label);
  for (const field of ['stage', 'failure_code']) {
    if (typeof failure[field] !== 'string' || failure[field].length > 64
        || !/^[a-z][a-z0-9_]*$/u.test(failure[field])) {
      throw new Error(`${label}.${field} must be a lowercase safe identifier of at most 64 characters`);
    }
  }
  if (typeof failure.message !== 'string' || !failure.message.trim() || failure.message.length > 240
      || /[\r\n\t]/u.test(failure.message)) {
    throw new Error(`${label}.message must be one line of at most 240 characters`);
  }
  return {
    stage: failure.stage,
    failure_code: failure.failure_code,
    message: boundedText(failure.message, 240)
  };
}

function publicReviewerOutcomes(options) {
  if (options.reviews === undefined) return undefined;
  if (!Array.isArray(options.reviews)) throw new Error('Buddy reviewer outcomes must be an array');
  const outcomes = options.reviews.map((outcome, index) => {
    const label = `Buddy reviewer outcome ${index}`;
    assertAllowedKeys(
      outcome,
      ['source_index', 'provider', 'model', 'status', 'result', 'failure'],
      ['source_index', 'provider', 'model', 'status', 'result', 'failure'],
      label
    );
    validateReviewerIdentity(outcome, label);
    if (!REVIEWER_OUTCOME_STATUSES.has(outcome.status)) throw new Error(`${label}.status is unsupported`);
    if (outcome.status === 'succeeded') {
      if (outcome.failure !== null) throw new Error(`${label} cannot contain a failure after success`);
      return {
        source_index: outcome.source_index,
        provider: boundedIdentityText(outcome.provider, 120),
        model: boundedIdentityText(outcome.model, 200),
        status: outcome.status,
        result: publicReviewerResult(outcome.result, `${label}.result`),
        failure: null
      };
    }
    if (outcome.result !== null) throw new Error(`${label} cannot contain a result after failure`);
    const failure = publicReviewerFailure(outcome.failure, `${label}.failure`);
    if ((outcome.status === 'circuit_open') !== (failure.failure_code === 'circuit_open')) {
      throw new Error(`${label} has a mismatched failure status`);
    }
    return {
      source_index: outcome.source_index,
      provider: boundedIdentityText(outcome.provider, 120),
      model: boundedIdentityText(outcome.model, 200),
      status: outcome.status,
      result: null,
      failure
    };
  }).sort((left, right) => left.source_index - right.source_index);
  if (outcomes.length < 1 || outcomes.length > REVIEWER_OUTCOME_LIMIT) {
    throw new Error('Buddy reviewer outcomes must contain one or two entries');
  }
  if (!outcomes.some((outcome) => outcome.status === 'succeeded')) {
    throw new Error('Buddy completed review outcomes require at least one successful reviewer');
  }
  outcomes.forEach((outcome, index) => {
    if (outcome.source_index !== index) {
      throw new Error('Buddy reviewer outcome source indexes must be unique, contiguous, and zero based');
    }
  });
  return outcomes;
}

function publicSummaryAdvisory(advisory) {
  if (!advisory) return null;
  return {
    status: advisory.status,
    advisory: boundedText(advisory.advisory, 800),
    notes: (advisory.notes ?? []).slice(0, 5).map((note) => ({
      category: note.category,
      confidence: note.confidence,
      summary_start: note.summary_start,
      summary_end: note.summary_end,
      quote: boundedText(note.quote, 600),
      advice: boundedText(note.advice, 800)
    }))
  };
}

function publicCompanion(companion) {
  if (!companion) return null;
  return {
    pet_id: boundedText(companion.pet_id, 64),
    personality: companion.personality,
    mood: boundedText(companion.mood, 32),
    xp: companion.xp,
    completed_reviews: companion.completed_reviews,
    utterance: boundedText(companion.utterance, 180)
  };
}

function legacyPublicReview(result, provider, model) {
  const review = publicReview(result, provider, model);
  if (!review) return null;
  return {
    ...review,
    findings: review.findings.map(({ line_side: _lineSide, ...finding }) => finding),
    comments: review.comments.map(({ line_side: _lineSide, ...comment }) => comment)
  };
}

function eventIdentity(options) {
  const payload = {
    headline: boundedText(options.headline, 240),
    detail: boundedText(options.detail, 1600),
    // The worker summary already remains visible in the Codex transcript. Do
    // not duplicate user/session content into the durable renderer outbox.
    worker_summary: null,
    review: publicReview(options.result, options.provider, options.model),
    summary_advisory: publicSummaryAdvisory(options.summaryAdvisory),
    companion: publicCompanion(options.companion)
  };
  const reviews = publicReviewerOutcomes(options);
  if (reviews !== undefined) payload.reviews = reviews;
  return {
    // v2 event IDs remain semantic and exclude sequence. Cross-version retry
    // compatibility is handled by legacyEventIdentity below.
    schema_version: '1',
    event_type: options.type,
    workspace_key: workspaceKey(options.repositoryRoot),
    session_key: opaqueKey(options.sessionId),
    turn_key: opaqueKey(options.turnId),
    review_key: options.reviewKey ?? null,
    presentation_state: options.state,
    payload
  };
}

function legacyEventIdentity(options) {
  const identity = eventIdentity(options);
  return {
    ...identity,
    payload: {
      headline: identity.payload.headline,
      detail: identity.payload.detail,
      // Preserve the v1 deterministic ID lookup for events written by older
      // versions that included the summary. New events always store null.
      worker_summary: boundedText(options.workerSummary, 4000),
      review: legacyPublicReview(options.result, options.provider, options.model)
    }
  };
}

function eventId(identity) {
  return createHash('sha256').update(canonicalJson(identity)).digest('hex');
}

function identityFromStoredEvent(event) {
  return {
    schema_version: '1',
    event_type: event.event_type,
    workspace_key: event.workspace_key,
    session_key: event.session_key,
    turn_key: event.turn_key,
    review_key: event.review_key,
    presentation_state: event.presentation_state,
    payload: event.payload
  };
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function assertOptionalText(value, maximum, label) {
  if (value !== null && (typeof value !== 'string' || value.length > maximum)) {
    throw new Error(`${label} must be null or a string of at most ${maximum} characters`);
  }
}

function assertText(value, maximum, label) {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`${label} must be a string of at most ${maximum} characters`);
  }
}

function validateReviewItem(item, kind, label) {
  const isFinding = kind === 'finding';
  const keys = isFinding
    ? ['severity', 'confidence', 'title', 'body', 'path', 'line_start', 'line_end', 'recommendation']
    : ['category', 'confidence', 'title', 'body', 'path', 'line_start', 'line_end', 'recommendation'];
  const versionedKeys = Object.hasOwn(item, 'line_side') ? [...keys, 'line_side'] : keys;
  assertExactKeys(item, versionedKeys, label);
  if (isFinding ? !SEVERITIES.has(item.severity) : !COMMENT_CATEGORIES.has(item.category)) {
    throw new Error(`${label} has an unsupported classification`);
  }
  if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
    throw new Error(`${label}.confidence must be between 0 and 1`);
  }
  assertText(item.title, 160, `${label}.title`);
  assertText(item.body, 1200, `${label}.body`);
  assertText(item.path, 500, `${label}.path`);
  if (item.line_side !== undefined && !['new', 'old'].includes(item.line_side)) {
    throw new Error(`${label}.line_side must be new or old`);
  }
  if (!pathPolicy(item.path).allowed) throw new Error(`${label}.path is not an allowlisted repository-relative path`);
  assertText(item.recommendation, 1200, `${label}.recommendation`);
  if (!Number.isInteger(item.line_start) || item.line_start < 1
      || !Number.isInteger(item.line_end) || item.line_end < item.line_start) {
    throw new Error(`${label} has an invalid line range`);
  }
}

function validateReviewerResult(result, label) {
  assertExactKeys(result, ['status', 'summary', 'findings', 'comments'], label);
  if (!REVIEW_STATUSES.has(result.status)) throw new Error(`${label} has an unsupported status`);
  assertText(result.summary, 800, `${label}.summary`);
  if (!Array.isArray(result.findings) || result.findings.length > REVIEWER_FINDING_LIMIT) {
    throw new Error(`${label}.findings must be an array of at most ${REVIEWER_FINDING_LIMIT} items`);
  }
  if (!Array.isArray(result.comments) || result.comments.length > REVIEWER_COMMENT_LIMIT) {
    throw new Error(`${label}.comments must be an array of at most ${REVIEWER_COMMENT_LIMIT} items`);
  }
  if ((result.status === 'findings') !== (result.findings.length > 0)) {
    throw new Error(`${label} has findings inconsistent with its status`);
  }
  if (result.status === 'abstain' && result.comments.length > 0) {
    throw new Error(`${label} cannot contain comments when its status is abstain`);
  }
  result.findings.forEach((item, index) => validateReviewItem(item, 'finding', `${label}.findings[${index}]`));
  result.comments.forEach((item, index) => validateReviewItem(item, 'comment', `${label}.comments[${index}]`));
}

function validateReviewerOutcomes(reviews) {
  if (!Array.isArray(reviews) || reviews.length < 1 || reviews.length > REVIEWER_OUTCOME_LIMIT) {
    throw new Error('Buddy event reviews must be an array of one or two entries');
  }
  let successes = 0;
  for (const [index, outcome] of reviews.entries()) {
    assertExactKeys(
      outcome,
      ['source_index', 'provider', 'model', 'status', 'result', 'failure'],
      `Buddy event reviewer outcome ${index}`
    );
    if (outcome.source_index !== index || !REVIEWER_OUTCOME_STATUSES.has(outcome.status)) {
      throw new Error(`Buddy event reviewer outcome ${index} has invalid order or status`);
    }
    assertText(outcome.provider, 120, `Buddy event reviewer outcome ${index}.provider`);
    assertText(outcome.model, 200, `Buddy event reviewer outcome ${index}.model`);
    assertProviderModel(outcome.model, `Buddy event reviewer outcome ${index}.model`);
    if (outcome.provider !== boundedIdentityText(outcome.provider, 120)
        || outcome.model !== boundedIdentityText(outcome.model, 200)) {
      throw new Error(`Buddy event reviewer outcome ${index} attribution is not terminal safe`);
    }
    if (outcome.status === 'succeeded') {
      successes += 1;
      if (outcome.failure !== null) throw new Error(`Buddy event reviewer outcome ${index} cannot contain a failure`);
      validateReviewerResult(outcome.result, `Buddy event reviewer outcome ${index}.result`);
    } else {
      if (outcome.result !== null) throw new Error(`Buddy event reviewer outcome ${index} cannot contain a result`);
      publicReviewerFailure(outcome.failure, `Buddy event reviewer outcome ${index}.failure`);
      if ((outcome.status === 'circuit_open') !== (outcome.failure.failure_code === 'circuit_open')) {
        throw new Error(`Buddy event reviewer outcome ${index} has a mismatched failure status`);
      }
    }
  }
  if (successes < 1) throw new Error('Buddy event reviews require at least one successful reviewer');
}

function validateSummaryAdvisory(advisory) {
  if (advisory === null) return;
  assertExactKeys(advisory, ['status', 'advisory', 'notes'], 'Buddy event summary advisory');
  if (!SUMMARY_ADVISORY_STATUSES.has(advisory.status)) {
    throw new Error('Buddy event summary advisory has an unsupported status');
  }
  assertText(advisory.advisory, 800, 'Buddy event summary advisory.advisory');
  if (!Array.isArray(advisory.notes) || advisory.notes.length > 5) {
    throw new Error('Buddy event summary advisory notes must be an array of at most 5 items');
  }
  for (const [index, note] of advisory.notes.entries()) {
    assertExactKeys(
      note,
      ['category', 'confidence', 'summary_start', 'summary_end', 'quote', 'advice'],
      `Buddy event summary advisory note ${index}`
    );
    if (!SUMMARY_NOTE_CATEGORIES.has(note.category)
        || !Number.isFinite(note.confidence) || note.confidence < 0 || note.confidence > 1
        || !Number.isInteger(note.summary_start) || note.summary_start < 0
        || !Number.isInteger(note.summary_end) || note.summary_end <= note.summary_start) {
      throw new Error(`Buddy event summary advisory note ${index} is invalid`);
    }
    assertText(note.quote, 600, `Buddy event summary advisory note ${index}.quote`);
    assertText(note.advice, 800, `Buddy event summary advisory note ${index}.advice`);
  }
}

function validateCompanion(companion) {
  if (companion === null) return;
  assertExactKeys(
    companion,
    ['pet_id', 'personality', 'mood', 'xp', 'completed_reviews', 'utterance'],
    'Buddy event companion'
  );
  assertText(companion.pet_id, 64, 'Buddy event companion.pet_id');
  if (!PRESENTATION_PERSONALITIES.has(companion.personality)) {
    throw new Error('Buddy event companion has an unsupported personality');
  }
  assertText(companion.mood, 32, 'Buddy event companion.mood');
  assertText(companion.utterance, 180, 'Buddy event companion.utterance');
  if (!Number.isSafeInteger(companion.xp) || companion.xp < 0
      || !Number.isSafeInteger(companion.completed_reviews) || companion.completed_reviews < 0
      || companion.xp !== companion.completed_reviews * 10) {
    throw new Error('Buddy event companion has invalid completion XP');
  }
}

function validatePayload(payload, options = {}) {
  const legacyKeys = ['headline', 'detail', 'worker_summary', 'review'];
  const currentKeys = [...legacyKeys, 'summary_advisory', 'companion'];
  const isLegacy = Object.keys(payload ?? {}).length === legacyKeys.length;
  const hasReviewerOutcomes = Object.hasOwn(payload ?? {}, 'reviews');
  const expectedKeys = hasReviewerOutcomes ? [...currentKeys, 'reviews'] : currentKeys;
  assertExactKeys(payload, isLegacy && options.allowLegacy ? legacyKeys : expectedKeys, 'Buddy event payload');
  assertOptionalText(payload.headline, 240, 'Buddy event payload.headline');
  assertOptionalText(payload.detail, 1600, 'Buddy event payload.detail');
  assertOptionalText(payload.worker_summary, 4000, 'Buddy event payload.worker_summary');
  if (!isLegacy) {
    validateSummaryAdvisory(payload.summary_advisory);
    validateCompanion(payload.companion);
    if (hasReviewerOutcomes) validateReviewerOutcomes(payload.reviews);
  }
  if (payload.review === null) return;
  assertExactKeys(payload.review, ['status', 'summary', 'findings', 'comments', 'provider', 'model'], 'Buddy event review');
  if (!REVIEW_STATUSES.has(payload.review.status)) throw new Error('Buddy event review has an unsupported status');
  assertText(payload.review.summary, 1600, 'Buddy event review.summary');
  assertOptionalText(payload.review.provider, 120, 'Buddy event review.provider');
  assertOptionalText(payload.review.model, 200, 'Buddy event review.model');
  assertProviderModel(payload.review.model, 'Buddy event review.model', true);
  if (!Array.isArray(payload.review.findings) || payload.review.findings.length > 5) {
    throw new Error('Buddy event review.findings must be an array of at most 5 items');
  }
  if (!Array.isArray(payload.review.comments) || payload.review.comments.length > 3) {
    throw new Error('Buddy event review.comments must be an array of at most 3 items');
  }
  payload.review.findings.forEach((item, index) => validateReviewItem(item, 'finding', `Buddy event finding ${index}`));
  payload.review.comments.forEach((item, index) => validateReviewItem(item, 'comment', `Buddy event comment ${index}`));
}

function validateStoredEvent(event, expected = {}) {
  const version = event?.schema_version;
  const keys = [
    'schema_version', 'event_type', 'workspace_key', 'session_key', 'turn_key', 'review_key',
    'presentation_state', 'payload', 'event_id', 'occurred_at'
  ];
  if (version === '2') keys.push('sequence');
  if (version !== '1' && version !== '2') throw new Error('unsupported Buddy outbox event schema');
  assertExactKeys(event, keys, 'Buddy outbox event');
  if (!EVENT_TYPES.has(event.event_type)) throw new Error('Buddy outbox event has an unsupported type');
  if (!PRESENTATION_STATES.has(event.presentation_state)) throw new Error('Buddy outbox event has an unsupported presentation state');
  if (!WORKSPACE_PATTERN.test(event.workspace_key) || (expected.workspace && event.workspace_key !== expected.workspace)) {
    throw new Error('Buddy outbox event has an invalid workspace key');
  }
  if (!OPAQUE_PATTERN.test(event.session_key) || (expected.session && event.session_key !== expected.session)) {
    throw new Error('Buddy outbox event has an invalid session key');
  }
  if (!OPAQUE_PATTERN.test(event.turn_key)) throw new Error('Buddy outbox event has an invalid turn key');
  if (event.review_key !== null && !SHA256_PATTERN.test(event.review_key)) {
    throw new Error('Buddy outbox event has an invalid review key');
  }
  if (!SHA256_PATTERN.test(event.event_id) || (expected.eventId && event.event_id !== expected.eventId)) {
    throw new Error('Buddy outbox event has an invalid event id');
  }
  if (event.event_id !== eventId(identityFromStoredEvent(event))) {
    throw new Error('Buddy outbox event identity digest does not match its contents');
  }
  if (typeof event.occurred_at !== 'string' || !Number.isFinite(Date.parse(event.occurred_at))) {
    throw new Error('Buddy outbox event has an invalid occurrence timestamp');
  }
  if (version === '2' && (!Number.isSafeInteger(event.sequence) || event.sequence < 1)) {
    throw new Error('Buddy outbox v2 event has an invalid sequence');
  }
  validatePayload(event.payload, { allowLegacy: version === '1' });
  if (Object.hasOwn(event.payload, 'reviews')
      && (version !== '2' || event.event_type !== 'review_completed' || event.payload.review === null)) {
    throw new Error('Buddy attributed reviews are allowed only on completed v2 review events');
  }
  return event;
}

async function detailsOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readImmutableJson(file, label) {
  const details = await detailsOrNull(file);
  if (!details) return null;
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  return value;
}

function outboxWorkspace(runtimeDataDir, repositoryRoot) {
  const runtimeRoot = resolveRuntimeDataDir(runtimeDataDir);
  const workspace = workspaceKey(repositoryRoot);
  const directory = path.join(runtimeRoot, 'outbox', workspace);
  const protocolDirectory = path.join(directory, PROTOCOL_DIRECTORY);
  return {
    runtimeRoot,
    workspace,
    directory,
    protocolDirectory,
    producerFile: path.join(protocolDirectory, 'producer.json'),
    legacyIndexFile: path.join(protocolDirectory, 'legacy-index.json'),
    lockTarget: path.join(protocolDirectory, 'workspace-state')
  };
}

async function ensureOutboxWorkspace(paths) {
  await ensurePrivateStatePath(paths.runtimeRoot, paths.protocolDirectory);
}

async function scanEventFiles(paths) {
  const entries = await readdir(paths.directory, { withFileTypes: true });
  const events = [];
  const ids = new Set();
  for (const entry of entries) {
    if (entry.name === PROTOCOL_DIRECTORY) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Buddy outbox protocol path must be a non-symlink directory');
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory() || !OPAQUE_PATTERN.test(entry.name)) {
      throw new Error(`Buddy outbox contains an unsupported workspace entry: ${entry.name}`);
    }
    const sessionDirectory = path.join(paths.directory, entry.name);
    const files = await readdir(sessionDirectory, { withFileTypes: true });
    for (const fileEntry of files) {
      if (fileEntry.isFile() && /^\..+\.tmp$/.test(fileEntry.name)) continue;
      const match = fileEntry.name.match(/^([0-9a-f]{64})\.json$/);
      if (!match || fileEntry.isSymbolicLink() || !fileEntry.isFile()) {
        throw new Error(`Buddy outbox contains an unsupported session entry: ${fileEntry.name}`);
      }
      const file = path.join(sessionDirectory, fileEntry.name);
      const event = validateStoredEvent(
        await readImmutableJson(file, 'Buddy outbox event'),
        { workspace: paths.workspace, session: entry.name, eventId: match[1] }
      );
      if (ids.has(event.event_id)) throw new Error(`Buddy outbox contains duplicate event id ${event.event_id}`);
      ids.add(event.event_id);
      events.push({ event, file });
    }
  }
  return events;
}

function validateLegacyIndex(value, workspace) {
  if (value === null) return { schema_version: LEGACY_INDEX_SCHEMA_VERSION, workspace_key: workspace, entries: [] };
  assertExactKeys(value, ['schema_version', 'workspace_key', 'entries'], 'Buddy legacy event index');
  if (value.schema_version !== LEGACY_INDEX_SCHEMA_VERSION || value.workspace_key !== workspace || !Array.isArray(value.entries)) {
    throw new Error('Buddy legacy event index has an unsupported identity or schema');
  }
  const ids = new Set();
  const sequences = new Set();
  for (const entry of value.entries) {
    assertExactKeys(entry, ['event_id', 'session_key', 'sequence'], 'Buddy legacy event index entry');
    if (!SHA256_PATTERN.test(entry.event_id) || !OPAQUE_PATTERN.test(entry.session_key)
        || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
      throw new Error('Buddy legacy event index contains an invalid entry');
    }
    if (ids.has(entry.event_id) || sequences.has(entry.sequence)) throw new Error('Buddy legacy event index contains duplicates');
    ids.add(entry.event_id);
    sequences.add(entry.sequence);
  }
  return value;
}

function validateProducer(value, workspace) {
  if (value === null) return { schema_version: PRODUCER_SCHEMA_VERSION, workspace_key: workspace, last_sequence: 0 };
  assertExactKeys(value, ['schema_version', 'workspace_key', 'last_sequence'], 'Buddy outbox producer state');
  if (value.schema_version !== PRODUCER_SCHEMA_VERSION || value.workspace_key !== workspace
      || !Number.isSafeInteger(value.last_sequence) || value.last_sequence < 0) {
    throw new Error('Buddy outbox producer state has an unsupported identity or schema');
  }
  return value;
}

async function initializeWorkspace(paths) {
  const scanned = await scanEventFiles(paths);
  const v1 = scanned.filter((item) => item.event.schema_version === '1');
  const v2 = scanned.filter((item) => item.event.schema_version === '2');
  let producer = validateProducer(await readImmutableJson(paths.producerFile, 'Buddy outbox producer state'), paths.workspace);
  let legacyIndex = validateLegacyIndex(
    await readImmutableJson(paths.legacyIndexFile, 'Buddy legacy event index'),
    paths.workspace
  );
  const v1ById = new Map(v1.map((item) => [item.event.event_id, item]));
  for (const entry of legacyIndex.entries) {
    const item = v1ById.get(entry.event_id);
    if (!item || item.event.session_key !== entry.session_key) {
      throw new Error('Buddy legacy event index references a missing or mismatched immutable event');
    }
  }

  const indexed = new Set(legacyIndex.entries.map((entry) => entry.event_id));
  const unindexed = v1
    .filter((item) => !indexed.has(item.event.event_id))
    .sort((left, right) => (
      left.event.occurred_at.localeCompare(right.event.occurred_at)
      || left.event.event_id.localeCompare(right.event.event_id)
    ));
  if (unindexed.length || !(await detailsOrNull(paths.legacyIndexFile))) {
    let sequence = Math.max(
      producer.last_sequence,
      legacyIndex.entries.reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0),
      v2.reduce((maximum, item) => Math.max(maximum, item.event.sequence), 0)
    );
    legacyIndex = {
      ...legacyIndex,
      entries: [
        ...legacyIndex.entries,
        ...unindexed.map((item) => ({
          event_id: item.event.event_id,
          session_key: item.event.session_key,
          sequence: ++sequence
        }))
      ]
    };
    await writePrivateJsonAtomic(paths.legacyIndexFile, legacyIndex);
  }

  const assigned = new Map(legacyIndex.entries.map((entry) => [entry.sequence, entry.event_id]));
  for (const item of v2) {
    const prior = assigned.get(item.event.sequence);
    if (prior) throw new Error(`Buddy outbox sequence ${item.event.sequence} is duplicated by ${prior} and ${item.event.event_id}`);
    assigned.set(item.event.sequence, item.event.event_id);
  }
  const maximumObserved = [...assigned.keys()].reduce((maximum, sequence) => Math.max(maximum, sequence), 0);
  if (producer.last_sequence < maximumObserved || !(await detailsOrNull(paths.producerFile))) {
    producer = { ...producer, last_sequence: Math.max(producer.last_sequence, maximumObserved) };
    await writePrivateJsonAtomic(paths.producerFile, producer);
  }

  const legacySequences = new Map(legacyIndex.entries.map((entry) => [entry.event_id, entry.sequence]));
  const events = scanned.map((item) => ({
    ...item,
    sequence: item.event.schema_version === '2' ? item.event.sequence : legacySequences.get(item.event.event_id)
  }));
  return { events, producer };
}

async function withOutboxWorkspace(options, callback) {
  const paths = outboxWorkspace(options.runtimeDataDir, options.repositoryRoot);
  await ensureOutboxWorkspace(paths);
  return withFileLock(paths.lockTarget, async () => callback(paths, await initializeWorkspace(paths)), {
    timeoutMs: OUTBOX_LOCK_TIMEOUT_MS,
    staleMs: OUTBOX_LOCK_TIMEOUT_MS
  });
}

export async function appendOutboxEvent(options) {
  if (!EVENT_TYPES.has(options.type)) throw new Error(`unsupported Buddy event type: ${options.type}`);
  if (!PRESENTATION_STATES.has(options.state)) throw new Error(`unsupported Buddy presentation state: ${options.state}`);
  if (options.reviewKey !== undefined && options.reviewKey !== null && !SHA256_PATTERN.test(options.reviewKey)) {
    throw new Error('Buddy review key must be a SHA-256 hex digest');
  }
  if (options.reviews !== undefined && options.type !== 'review_completed') {
    throw new Error('Buddy reviewer outcomes are allowed only on completed review events');
  }
  const identity = eventIdentity(options);
  const deterministicId = eventId(identity);
  const legacyDeterministicId = eventId(legacyEventIdentity(options));

  return withOutboxWorkspace(options, async (paths, initialized) => {
    const existing = initialized.events.find((item) => item.event.event_id === deterministicId);
    if (existing) return { event: existing.event, file: existing.file };
    const legacy = Object.hasOwn(identity.payload, 'reviews') ? null : initialized.events.find((item) => (
      item.event.schema_version === '1' && item.event.event_id === legacyDeterministicId
    ));
    if (legacy) return { event: legacy.event, file: legacy.file };

    const sequence = initialized.producer.last_sequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('Buddy outbox sequence space is exhausted');
    const event = {
      ...identity,
      schema_version: '2',
      sequence,
      event_id: deterministicId,
      occurred_at: options.occurredAt ?? new Date().toISOString()
    };
    validateStoredEvent(event, { workspace: paths.workspace, session: event.session_key, eventId: deterministicId });
    const directory = path.join(paths.directory, event.session_key);
    await ensurePrivateStatePath(paths.runtimeRoot, directory);
    const file = path.join(directory, `${deterministicId}.json`);
    const created = await writePrivateJsonExclusive(file, event);
    if (!created) {
      // A still-running v1 producer does not participate in the v2 workspace
      // lock. If it won the immutable event publication race, adopt that exact
      // event through the migration path instead of emitting a duplicate.
      const refreshed = await initializeWorkspace(paths);
      const raced = refreshed.events.find((item) => (
        item.event.event_id === deterministicId
        || (item.event.schema_version === '1' && item.event.event_id === legacyDeterministicId)
      ));
      if (raced) return { event: raced.event, file: raced.file };
      throw new Error('Buddy outbox event appeared during serialized publication');
    }
    await writePrivateJsonAtomic(paths.producerFile, {
      schema_version: PRODUCER_SCHEMA_VERSION,
      workspace_key: paths.workspace,
      last_sequence: sequence
    });
    return { event, file };
  });
}

export async function readSequencedOutboxEvents(options) {
  const afterSequence = options.afterSequence ?? 0;
  const throughSequence = options.throughSequence ?? Number.MAX_SAFE_INTEGER;
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Buddy outbox after-sequence must be a non-negative integer');
  if (!Number.isSafeInteger(throughSequence) || throughSequence < afterSequence) {
    throw new Error('Buddy outbox through-sequence must be an integer at or after after-sequence');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Buddy outbox read limit must be between 1 and 100');

  return withOutboxWorkspace(options, async (_paths, initialized) => {
    const available = initialized.events
      .filter((item) => item.sequence > afterSequence && item.sequence <= throughSequence)
      .sort((left, right) => left.sequence - right.sequence || left.event.event_id.localeCompare(right.event.event_id));
    return {
      events: available.slice(0, limit),
      has_more: available.length > limit,
      last_sequence: initialized.producer.last_sequence
    };
  });
}

async function compactLegacyEvents(paths, initialized, eligible, dryRun) {
  const legacy = initialized.events.filter((item) => item.event.schema_version === '1');
  if (dryRun || eligible.length === 0) {
    return {
      eligible_count: eligible.length,
      pruned_count: 0,
      retained_count: legacy.length
    };
  }

  const index = validateLegacyIndex(
    await readImmutableJson(paths.legacyIndexFile, 'Buddy legacy event index'),
    paths.workspace
  );
  const eligibleIds = new Set(eligible.map((item) => item.event.event_id));
  const indexedIds = new Set(index.entries.map((entry) => entry.event_id));
  if ([...eligibleIds].some((eventId) => !indexedIds.has(eventId))) {
    throw new Error('Buddy legacy compaction requires every eligible event to have a migration index entry');
  }

  // Commit the new migration index before unlinking immutable events. If the
  // process stops between these operations, the next initialization assigns
  // any remaining unindexed file a sequence above producer.last_sequence.
  // This can conservatively redeliver a renderer event, but it cannot reuse a
  // sequence, strand the workspace, or collide with a v2 event.
  await writePrivateJsonAtomic(paths.legacyIndexFile, {
    ...index,
    entries: index.entries.filter((entry) => !eligibleIds.has(entry.event_id))
  });
  for (const item of eligible) await rm(item.file, { force: true });
  return {
    eligible_count: eligible.length,
    pruned_count: eligible.length,
    retained_count: legacy.length - eligible.length
  };
}

export async function pruneSequencedOutboxEvents(options) {
  const throughSequence = options.throughSequence;
  const requestedMinAgeMs = options.minAgeMs ?? OUTBOX_CONTENT_TTL_MS;
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun !== false;
  if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
    throw new Error('Buddy outbox prune sequence must be a non-negative integer');
  }
  if (!Number.isSafeInteger(requestedMinAgeMs) || requestedMinAgeMs < 0 || !Number.isFinite(now)) {
    throw new Error('Buddy outbox prune age and clock must be non-negative finite integers');
  }
  // Acknowledgment can justify earlier deletion, but a configured renderer
  // minimum cannot extend the privacy ceiling for content-bearing events.
  const minAgeMs = Math.min(requestedMinAgeMs, OUTBOX_CONTENT_TTL_MS);
  return withOutboxWorkspace(options, async (paths, initialized) => {
    const eligible = initialized.events.filter((item) => (
      item.sequence <= throughSequence
      && now - Date.parse(item.event.occurred_at) >= minAgeMs
    ));
    const eligibleLegacy = eligible.filter((item) => item.event.schema_version === '1');
    const eligibleV2 = eligible.filter((item) => item.event.schema_version === '2');
    const legacyResult = await compactLegacyEvents(
      paths,
      initialized,
      eligibleLegacy,
      dryRun
    );
    if (!dryRun) {
      for (const item of eligibleV2) await rm(item.file, { force: true });
    }
    return {
      dry_run: dryRun,
      through_sequence: throughSequence,
      min_age_ms: minAgeMs,
      eligible_count: eligible.length,
      pruned_count: dryRun ? 0 : eligible.length,
      pruned_legacy_count: legacyResult.pruned_count,
      retained_legacy_count: legacyResult.retained_count
    };
  });
}

export async function pruneExpiredOutboxEvents(options) {
  const requestedMinAgeMs = options.minAgeMs ?? OUTBOX_CONTENT_TTL_MS;
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun === true;
  if (!Number.isSafeInteger(requestedMinAgeMs) || requestedMinAgeMs < 0 || !Number.isFinite(now)) {
    throw new Error('Buddy outbox expiry age and clock must be non-negative finite integers');
  }
  const minAgeMs = Math.min(requestedMinAgeMs, OUTBOX_CONTENT_TTL_MS);
  return withOutboxWorkspace(options, async (paths, initialized) => {
    const eligibleV2 = initialized.events.filter((item) => (
      item.event.schema_version === '2'
      && now - Date.parse(item.event.occurred_at) >= minAgeMs
    ));
    const eligibleLegacy = initialized.events.filter((item) => (
      item.event.schema_version === '1'
      && now - Date.parse(item.event.occurred_at) >= minAgeMs
    ));
    const legacyResult = await compactLegacyEvents(
      paths,
      initialized,
      eligibleLegacy,
      dryRun
    );
    if (!dryRun) {
      for (const item of eligibleV2) await rm(item.file, { force: true });
    }
    const eligibleCount = eligibleV2.length + legacyResult.eligible_count;
    return {
      dry_run: dryRun,
      min_age_ms: minAgeMs,
      eligible_count: eligibleCount,
      pruned_count: dryRun ? 0 : eligibleCount,
      pruned_legacy_count: legacyResult.pruned_count,
      retained_legacy_count: legacyResult.retained_count
    };
  });
}

export const OUTBOX_EVENT_SCHEMA_VERSION = '2';
