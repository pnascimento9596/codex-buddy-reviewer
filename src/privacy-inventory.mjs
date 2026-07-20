import { createHash, createHmac } from 'node:crypto';

import { matchesPrivacyFragments } from './privacy-fragments.mjs';
import { isProbablyText } from './policy.mjs';

export const PRIVACY_COVERAGE_SCHEMA_VERSION = '2';
export const PRIVACY_SOURCE_REGISTRY_VERSION = '1';
export const PRIVACY_RELATION_FLOOR_BYTES = 32;

export const PRIVACY_LIMITS = Object.freeze({
  maxSources: 8_192,
  maxSourceBytes: 1024 * 1024,
  maxCandidateBytes: 1024 * 1024,
  maxFragmentFingerprints: 8_192,
  maxWindowFingerprints: 65_536,
  maxSourceWindowWork: 262_144,
  maxCandidateMatchWork: 262_144,
  maxSerializedInventoryBytes: 4 * 1024 * 1024
});

const SAFE_INCOMPLETE_REASONS = new Set([
  'source_resolution_failed',
  'source_unreadable',
  'source_type_unsupported',
  'source_changed',
  'source_size_exceeded',
  'source_count_exceeded',
  'source_work_exceeded',
  'index_capacity_exceeded',
  'candidate_size_exceeded',
  'candidate_work_exceeded',
  'unsupported_text',
  'serialization_limit_exceeded',
  'snapshot_incompatible',
  'registry_incomplete',
  'malformed_inventory',
  'generation_mismatch'
]);

const HEX_64 = /^[0-9a-f]{64}$/;
const SCOPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const COVERAGE_KEYS = Object.freeze([
  'completed_source_classes',
  'counters',
  'generation_id',
  'incomplete_reason',
  'registry_version',
  'required_source_classes',
  'schema_version',
  'scope',
  'status'
]);
const COUNTER_KEYS = Object.freeze([
  'exact_fingerprints',
  'fragment_fingerprints',
  'source_bytes',
  'source_window_work',
  'sources',
  'window_fingerprints'
]);
const INDEX_VALUES = new WeakMap();

function sortedUniqueStrings(values, pattern = HEX_64) {
  const array = [...values];
  if (array.some((value) => typeof value !== 'string' || !pattern.test(value))) return null;
  array.sort();
  return array.every((value, index) => index === 0 || value !== array[index - 1]) ? array : null;
}

function canonicalStringArray(values, pattern) {
  if (!Array.isArray(values)) return null;
  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== 'string' || !pattern.test(values[index])) return null;
    if (index > 0 && values[index - 1] >= values[index]) return null;
  }
  return values;
}

function validReason(reason) {
  return reason === null || SAFE_INCOMPLETE_REASONS.has(reason);
}

function hasExactEnumerableKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== expected.length) return false;
  const actual = keys.sort();
  return actual.every((key, index) => key === expected[index]
    && descriptors[key]?.enumerable === true
    && Object.hasOwn(descriptors[key], 'value'));
}

export function privacyGenerationId(salt) {
  if (typeof salt !== 'string' || !HEX_64.test(salt)) {
    throw new TypeError('privacy generation salt is invalid');
  }
  return createHmac('sha256', Buffer.from(salt, 'hex'))
    .update('buddy-privacy-generation-v2\0')
    .digest('hex');
}

export function createPrivacyCoverage(options) {
  const status = options.status ?? 'complete';
  const incompleteReason = status === 'complete' ? null : options.incompleteReason;
  if (!['complete', 'incomplete'].includes(status) || !validReason(incompleteReason)
      || (status === 'incomplete' && incompleteReason === null)) {
    throw new TypeError('privacy coverage status is invalid');
  }
  if (typeof options.scope !== 'string' || !SCOPE_PATTERN.test(options.scope)) {
    throw new TypeError('privacy coverage scope is invalid');
  }
  const required = sortedUniqueStrings(options.requiredSourceClasses ?? [], /^[a-z][a-z0-9_]{0,63}$/);
  const completed = sortedUniqueStrings(options.completedSourceClasses ?? [], /^[a-z][a-z0-9_]{0,63}$/);
  if (!required || !completed) throw new TypeError('privacy coverage source classes are invalid');
  if (status === 'complete'
      && (required.length !== completed.length || required.some((value, index) => value !== completed[index]))) {
    throw new TypeError('complete privacy coverage must complete every required source class');
  }
  const counters = {
    sources: options.counters?.sources ?? 0,
    source_bytes: options.counters?.source_bytes ?? 0,
    source_window_work: options.counters?.source_window_work ?? 0,
    exact_fingerprints: options.counters?.exact_fingerprints ?? 0,
    fragment_fingerprints: options.counters?.fragment_fingerprints ?? 0,
    window_fingerprints: options.counters?.window_fingerprints ?? 0
  };
  if (Object.values(counters).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError('privacy coverage counters are invalid');
  }
  return Object.freeze({
    schema_version: PRIVACY_COVERAGE_SCHEMA_VERSION,
    registry_version: PRIVACY_SOURCE_REGISTRY_VERSION,
    generation_id: privacyGenerationId(options.salt),
    scope: options.scope,
    status,
    incomplete_reason: incompleteReason,
    required_source_classes: Object.freeze(required),
    completed_source_classes: Object.freeze(completed),
    counters: Object.freeze(counters)
  });
}

/**
 * Validate only public privacy-coverage metadata. This is the canonical
 * provider-eligibility gate for evidence consumers that intentionally do not
 * possess the private generation salt.
 */
export function privacyCoverageIsCurrentComplete(value, expectedScope = null) {
  if (!hasExactEnumerableKeys(value, COVERAGE_KEYS)
      || value.schema_version !== PRIVACY_COVERAGE_SCHEMA_VERSION
      || value.registry_version !== PRIVACY_SOURCE_REGISTRY_VERSION
      || typeof value.generation_id !== 'string'
      || !HEX_64.test(value.generation_id)
      || typeof value.scope !== 'string'
      || !SCOPE_PATTERN.test(value.scope)
      || value.status !== 'complete'
      || value.incomplete_reason !== null
      || (expectedScope !== null && value.scope !== expectedScope)) return false;
  const required = canonicalStringArray(value.required_source_classes, /^[a-z][a-z0-9_]{0,63}$/);
  const completed = canonicalStringArray(value.completed_source_classes, /^[a-z][a-z0-9_]{0,63}$/);
  if (!required || !completed || required.length !== completed.length
      || !required.every((item, index) => item === completed[index])) return false;
  if (!hasExactEnumerableKeys(value.counters, COUNTER_KEYS)) return false;
  const counters = value.counters;
  if (Object.values(counters).some((counter) => !Number.isSafeInteger(counter) || counter < 0)) {
    return false;
  }
  return counters.sources <= PRIVACY_LIMITS.maxSources
    && counters.source_bytes <= PRIVACY_LIMITS.maxSources * PRIVACY_LIMITS.maxSourceBytes
    && counters.source_window_work <= PRIVACY_LIMITS.maxSourceWindowWork
    && counters.exact_fingerprints <= PRIVACY_LIMITS.maxSources
    && counters.fragment_fingerprints <= PRIVACY_LIMITS.maxFragmentFingerprints
    && counters.window_fingerprints <= PRIVACY_LIMITS.maxWindowFingerprints;
}

export function privacyCoverageIsCompatible(value, salt, expectedScope = null) {
  return privacyCoverageIsCurrentComplete(value, expectedScope)
    && value.generation_id === privacyGenerationId(salt);
}

export function createPrivacyCoverageIndex(options) {
  const exact = new Set(options.exactFingerprints ?? []);
  const fragments = new Set(options.fragmentFingerprints ?? []);
  const windows = new Set(options.windowFingerprints ?? []);
  const coverage = options.coverage;
  const valuesValid = sortedUniqueStrings(exact) && sortedUniqueStrings(fragments)
    && sortedUniqueStrings(windows, /^(?:[1-9][0-9]{0,2}):(?:[0-9a-f]{32}|[0-9a-f]{64})$/);
  const withinLimits = exact.size <= PRIVACY_LIMITS.maxSources
    && fragments.size <= PRIVACY_LIMITS.maxFragmentFingerprints
    && windows.size <= PRIVACY_LIMITS.maxWindowFingerprints;
  const effectiveCoverage = valuesValid && withinLimits ? coverage : createPrivacyCoverage({
    salt: options.salt,
    scope: coverage?.scope ?? 'unknown',
    status: 'incomplete',
    incompleteReason: valuesValid ? 'index_capacity_exceeded' : 'malformed_inventory',
    requiredSourceClasses: coverage?.required_source_classes ?? [],
    completedSourceClasses: coverage?.completed_source_classes ?? [],
    counters: coverage?.counters
  });
  const index = Object.freeze({ coverage: effectiveCoverage });
  INDEX_VALUES.set(index, Object.freeze({ salt: options.salt, exact, fragments, windows }));
  return index;
}

export function matchPrivacyCandidate(content, index, options = {}) {
  if (!Buffer.isBuffer(content)) throw new TypeError('privacy candidate must be a Buffer');
  const values = INDEX_VALUES.get(index);
  if (!values || !privacyCoverageIsCompatible(index.coverage, values.salt)) {
    return { status: 'incomplete', reason: 'registry_incomplete' };
  }
  if (content.length > (options.maxBytes ?? PRIVACY_LIMITS.maxCandidateBytes)) {
    return { status: 'incomplete', reason: 'candidate_size_exceeded' };
  }
  const exact = createHash('sha256').update(content).digest('hex');
  if (values.exact.has(exact)) return { status: 'match', relation: 'raw_exact' };
  if (!isProbablyText(content)) return { status: 'incomplete', reason: 'unsupported_text' };
  const decoded = content.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(content)) {
    return { status: 'incomplete', reason: 'unsupported_text' };
  }
  const result = matchesPrivacyFragments(content, values.salt, {
    fingerprints: values.fragments,
    shortFingerprints: values.windows
  }, {
    maxBytes: options.maxBytes ?? PRIVACY_LIMITS.maxCandidateBytes,
    maxFragments: PRIVACY_LIMITS.maxFragmentFingerprints,
    maxShortFragments: PRIVACY_LIMITS.maxWindowFingerprints,
    maxShortMatchWork: options.maxWork ?? PRIVACY_LIMITS.maxCandidateMatchWork
  });
  if (!result.complete) return { status: 'incomplete', reason: 'candidate_work_exceeded' };
  return result.matches
    ? { status: 'match', relation: 'normalized_window_32' }
    : { status: 'no_match', relation: null };
}

export function privacyCoverageDigest(coverage) {
  return createHash('sha256').update(JSON.stringify(coverage)).digest('hex');
}
