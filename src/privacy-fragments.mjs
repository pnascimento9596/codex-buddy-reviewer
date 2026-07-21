import { createHmac, randomBytes } from 'node:crypto';

import { isProbablyText } from './policy.mjs';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_FRAGMENTS = 8_192;
const DEFAULT_MAX_SHORT_FRAGMENTS = 65_536;
const DEFAULT_MAX_SHORT_SOURCE_WORK = 262_144;
const DEFAULT_MAX_SHORT_MATCH_WORK = 262_144;
const SHORT_MATCH_WINDOW = 32;
const ROLLING_WINDOW = 64;
const MIN_CHUNK = 128;
const MAX_CHUNK = 512;
const BOUNDARY_MASK = 0xff;
const SHORT_FRAGMENT_PATTERN = /^([1-9][0-9]{0,2}):([0-9a-f]{32}|[0-9a-f]{64})$/;

function rotl32(value, amount) {
  const shift = amount & 31;
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

const GEAR = Object.freeze(Array.from({ length: 256 }, (_, byte) => {
  let value = (byte + 1) * 0x9e3779b1;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  return value >>> 0;
}));

function normalizeContent(content) {
  if (!Buffer.isBuffer(content) || !isProbablyText(content)) return null;
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content)) return null;
  return Buffer.from(text.normalize('NFC').replace(/\s/gu, ''), 'utf8');
}

function chunkRanges(content) {
  if (content.length < MIN_CHUNK) return [];
  const ranges = [];
  const window = new Uint8Array(ROLLING_WINDOW);
  let rolling = 0;
  let chunkStart = 0;
  for (let index = 0; index < content.length; index += 1) {
    const slot = index % ROLLING_WINDOW;
    rolling = rotl32(rolling, 1);
    if (index >= ROLLING_WINDOW) rolling ^= rotl32(GEAR[window[slot]], ROLLING_WINDOW);
    window[slot] = content[index];
    rolling = (rolling ^ GEAR[content[index]]) >>> 0;
    const chunkLength = index + 1 - chunkStart;
    const boundary = index >= ROLLING_WINDOW
      && chunkLength >= MIN_CHUNK
      && ((rolling & BOUNDARY_MASK) === 0 || chunkLength >= MAX_CHUNK);
    if (boundary) {
      ranges.push([chunkStart, index + 1]);
      chunkStart = index + 1;
    }
  }
  if (content.length - chunkStart >= MIN_CHUNK) ranges.push([chunkStart, content.length]);
  return ranges;
}

function saltBuffer(salt) {
  if (typeof salt !== 'string' || !/^[0-9a-f]{64}$/.test(salt)) throw new TypeError('privacy fragment salt is invalid');
  return Buffer.from(salt, 'hex');
}

function boundedInteger(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return resolved;
}

function shortFragmentFingerprint(fragment, key) {
  // A 128-bit prefix keeps the bounded sliding-window inventory compact. Any
  // digest collision can only over-block a candidate, never hide denied bytes.
  return `${fragment.length}:${createHmac('sha256', key)
    .update('buddy-privacy-short-fragment-v1\0')
    .update(String(fragment.length))
    .update('\0')
    .update(fragment)
    .digest('hex')
    .slice(0, 32)}`;
}

function parseShortFragment(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(SHORT_FRAGMENT_PATTERN);
  if (!match) return null;
  const length = Number(match[1]);
  if (length >= MIN_CHUNK) return null;
  return { length, fingerprint: match[2] };
}

function boundedShortFingerprints(normalized, length, key, maximumEntries, maximumWork) {
  const windows = normalized.length - length + 1;
  if (windows > maximumWork) return null;
  const fingerprints = new Set();
  for (let start = 0; start < windows; start += 1) {
    fingerprints.add(shortFragmentFingerprint(normalized.subarray(start, start + length), key));
    if (fingerprints.size > maximumEntries) return null;
  }
  return [...fingerprints];
}

function fragmentResult(normalized, key, maxFragments, maxShortFragments, maxShortSourceWork) {
  if (normalized.length === 0) {
    return { complete: true, fingerprints: [], shortFingerprints: [] };
  }
  if (normalized.length < MIN_CHUNK) {
    const length = Math.min(normalized.length, SHORT_MATCH_WINDOW);
    const fingerprints = boundedShortFingerprints(
      normalized,
      length,
      key,
      maxShortFragments,
      maxShortSourceWork
    );
    if (!fingerprints) {
      return { complete: false, fingerprints: [], shortFingerprints: [] };
    }
    return {
      complete: true,
      fingerprints: [],
      shortFingerprints: fingerprints
    };
  }
  const ranges = chunkRanges(normalized);
  const shortFingerprints = boundedShortFingerprints(
    normalized,
    SHORT_MATCH_WINDOW,
    key,
    maxShortFragments,
    maxShortSourceWork
  );
  if (ranges.length > maxFragments || !shortFingerprints) {
    return { complete: false, fingerprints: [], shortFingerprints: [] };
  }
  return {
    complete: true,
    fingerprints: ranges.map(([start, end]) => createHmac('sha256', key)
      .update('buddy-privacy-fragment-v1\0')
      .update(normalized.subarray(start, end))
      .digest('hex')),
    shortFingerprints
  };
}

function candidateFragmentResult(normalized, key, maxFragments) {
  if (normalized.length < MIN_CHUNK) {
    return { complete: true, fingerprints: [] };
  }
  const ranges = chunkRanges(normalized);
  if (ranges.length > maxFragments) return { complete: false, fingerprints: [] };
  return {
    complete: true,
    fingerprints: ranges.map(([start, end]) => createHmac('sha256', key)
      .update('buddy-privacy-fragment-v1\0')
      .update(normalized.subarray(start, end))
      .digest('hex'))
  };
}

export function createPrivacyFragmentSalt() {
  return randomBytes(32).toString('hex');
}

export function privacyFragmentFingerprints(content, salt, options = {}) {
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'privacy fragment byte limit');
  const maxFragments = boundedInteger(
    options.maxFragments,
    DEFAULT_MAX_FRAGMENTS,
    'privacy fragment count limit'
  );
  const maxShortFragments = boundedInteger(
    options.maxShortFragments,
    DEFAULT_MAX_SHORT_FRAGMENTS,
    'privacy short-fragment count limit'
  );
  const maxShortSourceWork = boundedInteger(
    options.maxShortSourceWork,
    DEFAULT_MAX_SHORT_SOURCE_WORK,
    'privacy short-fragment source work limit'
  );
  if (!Buffer.isBuffer(content)) throw new TypeError('privacy fragment content must be a Buffer');
  if (content.length > maxBytes) {
    return { complete: false, fingerprints: [], shortFingerprints: [] };
  }
  const normalized = normalizeContent(content);
  if (!normalized) return { complete: false, fingerprints: [], shortFingerprints: [] };
  const key = saltBuffer(salt);
  return fragmentResult(normalized, key, maxFragments, maxShortFragments, maxShortSourceWork);
}

export function sharesPrivacyFragment(candidateFingerprints, deniedFingerprints) {
  for (const fingerprint of candidateFingerprints ?? []) {
    if (deniedFingerprints.has(fingerprint)) return true;
  }
  return false;
}

export function mergePrivacyFragmentFingerprints(target, values, options = {}) {
  if (!(target instanceof Set)) throw new TypeError('privacy fragment inventory must be a Set');
  const maximum = boundedInteger(
    options.maxFragments,
    DEFAULT_MAX_FRAGMENTS,
    'privacy fragment inventory limit'
  );
  if (values !== undefined && !Array.isArray(values) && !(values instanceof Set)) return false;
  if ((Array.isArray(values) ? values.length : values?.size ?? 0) > maximum) return false;
  for (const value of values ?? []) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return false;
    if (target.has(value)) continue;
    if (target.size >= maximum) return false;
    target.add(value);
  }
  return true;
}

export function mergePrivacyShortFingerprints(target, values, options = {}) {
  if (!(target instanceof Set)) throw new TypeError('privacy short-fragment inventory must be a Set');
  const maximum = boundedInteger(
    options.maxShortFragments,
    DEFAULT_MAX_SHORT_FRAGMENTS,
    'privacy short-fragment inventory limit'
  );
  if (values !== undefined && !Array.isArray(values) && !(values instanceof Set)) return false;
  if ((Array.isArray(values) ? values.length : values?.size ?? 0) > maximum) return false;
  for (const value of values ?? []) {
    if (!parseShortFragment(value)) return false;
    if (target.has(value)) continue;
    if (target.size >= maximum) return false;
    target.add(value);
  }
  return true;
}

export function matchesPrivacyFragments(content, salt, deniedInventory, options = {}) {
  if (!Buffer.isBuffer(content)) throw new TypeError('privacy fragment content must be a Buffer');
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'privacy fragment byte limit');
  const maxFragments = boundedInteger(
    options.maxFragments,
    DEFAULT_MAX_FRAGMENTS,
    'privacy fragment count limit'
  );
  const maxShortFragments = boundedInteger(
    options.maxShortFragments,
    DEFAULT_MAX_SHORT_FRAGMENTS,
    'privacy short-fragment inventory limit'
  );
  const maxShortMatchWork = boundedInteger(
    options.maxShortMatchWork,
    DEFAULT_MAX_SHORT_MATCH_WORK,
    'privacy short-fragment work limit'
  );
  if (content.length > maxBytes) return { complete: false, matches: false };
  const normalized = normalizeContent(content);
  if (!normalized) return { complete: false, matches: false };
  const key = saltBuffer(salt);
  // Candidate short-window work is accounted below against maxShortMatchWork.
  // Do not apply the denied-inventory entry cap to candidate length: the two
  // limits protect different resources and conflating them would turn an
  // 8,193-byte candidate into an unexplained false incomplete result.
  const candidate = candidateFragmentResult(normalized, key, maxFragments);
  if (!candidate.complete) return { complete: false, matches: false };

  const deniedFingerprintValues = deniedInventory?.fingerprints ?? new Set();
  if (!Array.isArray(deniedFingerprintValues) && !(deniedFingerprintValues instanceof Set)) {
    return { complete: false, matches: false };
  }
  if ((Array.isArray(deniedFingerprintValues)
    ? deniedFingerprintValues.length
    : deniedFingerprintValues.size) > maxFragments) {
    return { complete: false, matches: false };
  }
  const deniedFingerprints = new Set();
  if (!mergePrivacyFragmentFingerprints(deniedFingerprints, deniedFingerprintValues, { maxFragments })) {
    return { complete: false, matches: false };
  }
  if (sharesPrivacyFragment(candidate.fingerprints, deniedFingerprints)) {
    return { complete: true, matches: true };
  }

  const deniedShortFingerprints = deniedInventory?.shortFingerprints ?? new Set();
  if (!Array.isArray(deniedShortFingerprints) && !(deniedShortFingerprints instanceof Set)) {
    return { complete: false, matches: false };
  }
  if ((Array.isArray(deniedShortFingerprints)
    ? deniedShortFingerprints.length
    : deniedShortFingerprints.size) > maxShortFragments) {
    return { complete: false, matches: false };
  }
  const byLength = new Map();
  for (const encoded of deniedShortFingerprints) {
    const parsed = parseShortFragment(encoded);
    if (!parsed) return { complete: false, matches: false };
    if (!byLength.has(parsed.length)) byLength.set(parsed.length, new Set());
    byLength.get(parsed.length).add(parsed.fingerprint);
  }

  let work = 0;
  for (const [length, fingerprints] of byLength) {
    if (length > normalized.length) continue;
    const windows = normalized.length - length + 1;
    if (work + windows > maxShortMatchWork) return { complete: false, matches: false };
    work += windows;
    for (let start = 0; start < windows; start += 1) {
      const fingerprint = createHmac('sha256', key)
        .update('buddy-privacy-short-fragment-v1\0')
        .update(String(length))
        .update('\0')
        .update(normalized.subarray(start, start + length))
        .digest('hex');
      if (fingerprints.has(fingerprint) || fingerprints.has(fingerprint.slice(0, 32))) {
        return { complete: true, matches: true };
      }
    }
  }
  return { complete: true, matches: false };
}
