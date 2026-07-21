import path from 'node:path';
import { REVIEW_SCHEMA_VERSION } from './review-schema.mjs';
import { hasUnsafeTerminalControls, normalizeRepoPath } from './policy.mjs';

const VALID_STATUS = new Set(['findings', 'no_findings', 'abstain']);
const VALID_SEVERITY = new Set(['blocker', 'high', 'medium', 'low']);
const RESULT_KEYS = new Set(['schema_version', 'status', 'summary', 'findings', 'comments']);
const FINDING_KEYS = new Set([
  'severity', 'confidence', 'title', 'body', 'impact', 'path', 'line_side', 'line_start', 'line_end', 'evidence', 'recommendation'
]);
const COMMENT_KEYS = new Set([
  'category', 'confidence', 'title', 'body', 'path', 'line_side', 'line_start', 'line_end', 'evidence', 'recommendation'
]);
const VALID_COMMENT_CATEGORY = new Set(['optimization', 'reliability', 'maintainability', 'testing']);

export function localReviewResultForEvidence(evidence) {
  if (!Array.isArray(evidence?.changed_paths)
      || !Array.isArray(evidence.excluded_paths)
      || !Array.isArray(evidence.path_evidence)) {
    throw new TypeError('review evidence requires changed, excluded, and path evidence arrays');
  }
  if (evidence.path_evidence.some((item) => (
    !item
    || typeof item !== 'object'
    || Array.isArray(item)
    || typeof item.path !== 'string'
    || typeof item.transmitted !== 'boolean'
    || typeof item.disposition !== 'string'
  ))) {
    throw new TypeError('review path evidence contains an invalid entry');
  }
  const changedPaths = evidence.changed_paths;
  const transmittedPaths = new Set(
    evidence.path_evidence
      .filter((item) => item.transmitted === true && item.disposition === 'complete')
      .map((item) => item.path)
  );
  if (changedPaths.length > 0 && changedPaths.some((repoPath) => transmittedPaths.has(repoPath))) {
    return null;
  }
  const excludedCount = (evidence.excluded_paths?.length ?? 0)
    + (evidence.sensitive_change_count ?? 0)
    + (evidence.ignored_change_count ?? 0);
  const incompleteCount = evidence.incomplete_paths?.length ?? 0;
  if (excludedCount || incompleteCount) {
    return {
      schema_version: REVIEW_SCHEMA_VERSION,
      status: 'abstain',
      summary: incompleteCount
        ? 'No complete transmitted evidence was available for the observed changes.'
        : 'All observed changes were excluded by privacy policy.',
      findings: [],
      comments: []
    };
  }
  return {
    schema_version: REVIEW_SCHEMA_VERSION,
    status: 'no_findings',
    summary: 'No reviewable changes were observed in the selected scope.',
    findings: [],
    comments: []
  };
}

function rejectUnknownKeys(object, allowed, label) {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown properties: ${unknown.join(', ')}`);
}

function parseJsonString(value) {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error('reviewer output did not contain a JSON object');
  }
}

export function parseReviewerOutput(stdout) {
  const outer = parseJsonString(stdout);
  if (outer && typeof outer === 'object') {
    if (outer.structured_output && typeof outer.structured_output === 'object') return outer.structured_output;
    if (typeof outer.result === 'string') return parseJsonString(outer.result);
    if (typeof outer.content === 'string') return parseJsonString(outer.content);
  }
  return outer;
}

function assertString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  if (hasUnsafeTerminalControls(value)) {
    throw new Error(`${field} contains unsafe control characters`);
  }
}

function validateGrounding(item, index, label, evidence, changed) {
  const repoPath = normalizeRepoPath(item.path);
  if (path.posix.isAbsolute(repoPath) || repoPath.split('/').includes('..') || !changed.has(repoPath)) {
    throw new Error(`${label} ${index + 1} cites a path outside the review scope: ${item.path}`);
  }
  if (!Number.isInteger(item.line_start) || item.line_start < 1) {
    throw new Error(`${label} ${index + 1}.line_start must be a positive integer`);
  }
  if (!Number.isInteger(item.line_end) || item.line_end < item.line_start) {
    throw new Error(`${label} ${index + 1}.line_end must be >= line_start`);
  }
  const pathEvidence = evidence.path_evidence?.find((entry) => entry.path === repoPath);
  if (!pathEvidence || pathEvidence.disposition !== 'complete' || !pathEvidence.transmitted) {
    throw new Error(`${label} ${index + 1} cites incomplete or untransmitted evidence`);
  }
  const lineSide = item.line_side ?? 'new';
  if (!['new', 'old'].includes(lineSide)) throw new Error(`${label} ${index + 1}.line_side must be new or old`);
  if (pathEvidence.file_state === 'deleted' && lineSide !== 'old') {
    throw new Error(`${label} ${index + 1} must cite the old side of a deleted file`);
  }
  const ranges = (evidence.hunk_ranges?.[repoPath] ?? []).filter(
    (range) => (range.side ?? 'new') === lineSide
  );
  const containingRanges = ranges.filter(
    (range) => item.line_start >= range.start && item.line_end <= range.end
  );
  if (!containingRanges.length) {
    throw new Error(`${label} ${index + 1} is not contained in a transmitted changed range`);
  }
  const usesSyntheticAnchor = lineSide === 'new'
    && containingRanges.some((range) => ['deletion', 'metadata'].includes(range.kind));
  const lineCount = lineSide === 'old'
    ? evidence.old_line_counts?.[repoPath]
    : evidence.line_counts?.[repoPath];
  if (!usesSyntheticAnchor && (!Number.isInteger(lineCount) || item.line_end > lineCount)) {
    throw new Error(lineSide === 'new'
      ? `${label} ${index + 1} cites a line range outside the current file`
      : `${label} ${index + 1} cites a line range outside the old file side`);
  }
  return { repoPath, lineSide };
}

export function validateReviewResult(raw, evidence, options = {}) {
  const minConfidence = options.minConfidence ?? 0.75;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('review result must be an object');
  rejectUnknownKeys(raw, RESULT_KEYS, 'review result');
  if (![REVIEW_SCHEMA_VERSION, '1'].includes(raw.schema_version)) throw new Error('unsupported review schema version');
  if (!VALID_STATUS.has(raw.status)) throw new Error(`invalid review status: ${raw.status}`);
  assertString(raw.summary, 'summary', 1200);
  if (!Array.isArray(raw.findings) || raw.findings.length > 5) throw new Error('findings must be an array with at most five items');
  if (raw.status !== 'findings' && raw.findings.length !== 0) throw new Error(`${raw.status} must not include findings`);
  if (raw.status === 'findings' && raw.findings.length === 0) throw new Error('findings status requires at least one finding');

  const changed = new Set(evidence.changed_paths.map(normalizeRepoPath));
  const findings = raw.findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      throw new Error(`finding ${index + 1} must be an object`);
    }
    rejectUnknownKeys(finding, FINDING_KEYS, `finding ${index + 1}`);
    if (!VALID_SEVERITY.has(finding.severity)) throw new Error(`finding ${index + 1} has invalid severity`);
    if (typeof finding.confidence !== 'number' || finding.confidence < 0 || finding.confidence > 1) {
      throw new Error(`finding ${index + 1} has invalid confidence`);
    }
    for (const [field, max] of [
      ['title', 160], ['body', 2000], ['impact', 1000], ['path', 500], ['evidence', 1600], ['recommendation', 1600]
    ]) assertString(finding[field], `finding ${index + 1}.${field}`, max);

    const { repoPath, lineSide } = validateGrounding(finding, index, 'finding', evidence, changed);
    return { ...finding, path: repoPath, line_side: lineSide };
  });

  const rawComments = raw.comments ?? [];
  if (!Array.isArray(rawComments) || rawComments.length > 3) {
    throw new Error('comments must be an array with at most three items');
  }
  if (raw.status === 'abstain' && rawComments.length !== 0) {
    throw new Error('abstain must not include comments');
  }
  const comments = rawComments.map((comment, index) => {
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)) {
      throw new Error(`comment ${index + 1} must be an object`);
    }
    rejectUnknownKeys(comment, COMMENT_KEYS, `comment ${index + 1}`);
    if (!VALID_COMMENT_CATEGORY.has(comment.category)) {
      throw new Error(`comment ${index + 1} has invalid category`);
    }
    if (typeof comment.confidence !== 'number' || comment.confidence < 0 || comment.confidence > 1) {
      throw new Error(`comment ${index + 1} has invalid confidence`);
    }
    for (const [field, max] of [
      ['title', 160], ['body', 1600], ['path', 500], ['evidence', 1600], ['recommendation', 1600]
    ]) assertString(comment[field], `comment ${index + 1}.${field}`, max);
    const { repoPath, lineSide } = validateGrounding(comment, index, 'comment', evidence, changed);
    return { ...comment, path: repoPath, line_side: lineSide };
  });

  const incompleteCount = (evidence.incomplete_paths?.length ?? 0)
    + (evidence.excluded_paths?.length ?? 0)
    + (evidence.sensitive_change_count ?? 0)
    + (evidence.ignored_change_count ?? 0);
  if (raw.status === 'no_findings' && incompleteCount > 0) {
    return {
      schema_version: REVIEW_SCHEMA_VERSION,
      status: 'abstain',
      summary: `Review evidence was incomplete for ${incompleteCount} changed path(s).`,
      findings: [],
      comments: []
    };
  }

  const publishable = findings.filter((finding) => finding.confidence >= minConfidence);
  if (raw.status === 'findings' && publishable.length === 0) {
    return {
      schema_version: REVIEW_SCHEMA_VERSION,
      status: 'abstain',
      summary: `Reviewer returned findings below the ${minConfidence.toFixed(2)} publication threshold.`,
      findings: [],
      comments: []
    };
  }

  const publishableComments = comments.filter((comment) => comment.confidence >= minConfidence);
  return {
    ...raw,
    schema_version: REVIEW_SCHEMA_VERSION,
    findings: publishable,
    comments: publishableComments
  };
}
