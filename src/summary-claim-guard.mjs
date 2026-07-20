import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  drainEgressCapabilities,
  snapshotActiveEgressCapabilities
} from './egress-capability.mjs';
import { escapeTerminalControls, hasUnsafeTerminalControls, pathPolicy } from './policy.mjs';
import { assessProviderModelIdentifier, scanSecretMaterial } from './secret-scan.mjs';
import {
  canonicalJson,
  ensurePrivateStatePath,
  readPrivateJson,
  resolveDataDir,
  withFileLock,
  workspaceKey,
  writePrivateJsonAtomic
} from './state.mjs';

export const SUMMARY_CLAIM_GUARD_POLICY_VERSION = '1';
export const SUMMARY_CLAIM_GUARD_SCOPE = 'worker_summary_claim_advisory';

const SUMMARY_PACKET_LIMIT = 4_000;
const REVIEW_KEY_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RESULT_STATUSES = new Set(['notes', 'no_notes', 'abstain']);
const NOTE_CATEGORIES = new Set([
  'unsupported_claim',
  'missing_verification',
  'overstatement',
  'scope_ambiguity'
]);
const FINDING_ONLY_KEYS = new Set([
  'severity',
  'title',
  'body',
  'impact',
  'path',
  'line_side',
  'line_start',
  'line_end',
  'evidence',
  'recommendation'
]);
const CONSENT_KEYS = [
  'schema_version',
  'policy_version',
  'scope',
  'enabled',
  'provider',
  'model',
  'consented_at',
  'configuration_revision'
];
const PACKET_KEYS = [
  'schema_version',
  'purpose',
  'policy_version',
  'consent_revision',
  'review_key',
  'offset_unit',
  'summary',
  'summary_sha256',
  'summary_truncated'
];
const RESULT_KEYS = ['schema_version', 'status', 'advisory', 'notes'];
const NOTE_KEYS = [
  'category',
  'confidence',
  'summary_start',
  'summary_end',
  'quote',
  'advice'
];
const CONSENT_LOCK_TIMEOUT_MS = 30_000;
const CONSENT_DRAIN_TIMEOUT_MS = 570_000;

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function assertSafeText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  if (hasUnsafeTerminalControls(value)) throw new Error(`${label} contains unsafe terminal controls`);
  return value;
}

function assertOptionalLabel(value, label, maximum) {
  if (value === null) return value;
  return assertSafeText(value, label, maximum);
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateSummaryClaimGuardConsent(raw, options = {}) {
  const expectedOptions = ['requireEnabled', 'provider', 'model'];
  const unknownOptions = Object.keys(options).filter((key) => !expectedOptions.includes(key));
  if (unknownOptions.length) throw new Error('summary-claim guard consent options contain unsupported fields');
  assertExactKeys(raw, CONSENT_KEYS, 'summary-claim guard consent');
  if (raw.schema_version !== '1') throw new Error('unsupported summary-claim guard consent schema');
  if (raw.policy_version !== SUMMARY_CLAIM_GUARD_POLICY_VERSION) {
    throw new Error('summary-claim guard consent policy is stale or unsupported');
  }
  if (raw.scope !== SUMMARY_CLAIM_GUARD_SCOPE) throw new Error('summary-claim guard consent has the wrong scope');
  if (typeof raw.enabled !== 'boolean') throw new Error('summary-claim guard consent enabled must be boolean');
  if (!Number.isSafeInteger(raw.configuration_revision) || raw.configuration_revision < 1) {
    throw new Error('summary-claim guard consent configuration revision must be a positive safe integer');
  }
  const provider = assertOptionalLabel(raw.provider, 'summary-claim guard provider', 120);
  const model = assertOptionalLabel(raw.model, 'summary-claim guard model', 200);
  if (model !== null && !assessProviderModelIdentifier(model).allowed) {
    throw new Error('summary-claim guard model is invalid or contains credential material');
  }
  if (raw.consented_at !== null && !validTimestamp(raw.consented_at)) {
    throw new Error('summary-claim guard consent timestamp is invalid');
  }
  if (raw.enabled && (!provider || !model || !validTimestamp(raw.consented_at))) {
    throw new Error('enabled summary-claim guard requires explicit provider, model, and consent timestamp');
  }
  if (options.requireEnabled === true && !raw.enabled) {
    throw new Error('worker-summary advisory egress is not explicitly enabled');
  }
  if (options.provider !== undefined && provider !== options.provider) {
    throw new Error('summary-claim guard provider changed after consent');
  }
  if (options.model !== undefined && model !== options.model) {
    throw new Error('summary-claim guard model changed after consent');
  }
  return Object.freeze({
    schema_version: '1',
    policy_version: SUMMARY_CLAIM_GUARD_POLICY_VERSION,
    scope: SUMMARY_CLAIM_GUARD_SCOPE,
    enabled: raw.enabled,
    provider,
    model,
    consented_at: raw.consented_at,
    configuration_revision: raw.configuration_revision
  });
}

function truncateUtf16Safe(value, maximum) {
  if (value.length <= maximum) return { text: value, truncated: false };
  let end = maximum - 1;
  const previous = value.charCodeAt(end - 1);
  const current = value.charCodeAt(end);
  if (previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF) end -= 1;
  return { text: `${value.slice(0, end)}…`, truncated: true };
}

function sanitizedSummary(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('worker summary must be a non-empty string');
  }
  const normalized = escapeTerminalControls(value)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n');
  return truncateUtf16Safe(normalized, SUMMARY_PACKET_LIMIT);
}

function containsBoundedPathReference(value, repoPath) {
  if (typeof repoPath !== 'string' || !repoPath) return false;
  const haystack = value.replaceAll('\\', '/').toLowerCase();
  const needle = repoPath.replaceAll('\\', '/').toLowerCase();
  let offset = haystack.indexOf(needle);
  while (offset !== -1) {
    const before = offset === 0 ? '' : haystack[offset - 1];
    const afterOffset = offset + needle.length;
    const after = afterOffset === haystack.length ? '' : haystack[afterOffset];
    const afterNext = afterOffset + 1 >= haystack.length ? '' : haystack[afterOffset + 1];
    const beforeIsPath = before && /[0-9a-z._/-]/u.test(before);
    const afterIsPath = after && (/[0-9a-z_/-]/u.test(after)
      || (after === '.' && /[0-9a-z]/u.test(afterNext)));
    if (!beforeIsPath && !afterIsPath) return true;
    offset = haystack.indexOf(needle, offset + 1);
  }
  return false;
}

function summaryPathCandidates(value) {
  return value
    .split(/[\s"'`()\[\]{}<>=:,;]+/u)
    .map((candidate) => candidate.replace(/[.!?]+$/u, ''))
    .filter((candidate) => candidate.length > 0 && candidate.length <= 512);
}

export function assessSummaryClaimGuardEgress(options) {
  assertExactKeys(options, ['summary', 'excludedPaths'], 'summary-claim guard egress options');
  if (!Array.isArray(options.excludedPaths)) {
    throw new Error('summary-claim guard excluded paths must be an array');
  }
  const summary = sanitizedSummary(options.summary).text;
  const scan = scanSecretMaterial(Buffer.from(summary, 'utf8'));
  if (!scan.complete || scan.detected) {
    return Object.freeze({ allowed: false, reason: 'secret_material' });
  }
  if (options.excludedPaths.some((entry) => {
    const repoPath = typeof entry === 'string' ? entry : entry?.path;
    return containsBoundedPathReference(summary, repoPath);
  })) {
    return Object.freeze({ allowed: false, reason: 'excluded_path_reference' });
  }
  for (const candidate of summaryPathCandidates(summary)) {
    const policy = pathPolicy(candidate.replaceAll('\\', '/').replace(/^\.\//u, ''));
    if (!policy.allowed
        && (policy.reason === 'denied directory' || policy.reason === 'potential secret material')) {
      return Object.freeze({ allowed: false, reason: 'sensitive_path_reference' });
    }
  }
  return Object.freeze({ allowed: true, reason: null });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildSummaryClaimGuardPacket(options) {
  assertExactKeys(options, ['consent', 'reviewKey', 'summary'], 'summary-claim guard packet options');
  const consent = validateSummaryClaimGuardConsent(options.consent, { requireEnabled: true });
  if (options.reviewKey !== null
      && (typeof options.reviewKey !== 'string' || !REVIEW_KEY_PATTERN.test(options.reviewKey))) {
    throw new Error('summary-claim guard review key must be null or a lowercase SHA-256 digest');
  }
  const summary = sanitizedSummary(options.summary);
  return Object.freeze({
    schema_version: '1',
    purpose: SUMMARY_CLAIM_GUARD_SCOPE,
    policy_version: SUMMARY_CLAIM_GUARD_POLICY_VERSION,
    consent_revision: consent.configuration_revision,
    review_key: options.reviewKey,
    offset_unit: 'utf16_code_unit',
    summary: summary.text,
    summary_sha256: sha256(summary.text),
    summary_truncated: summary.truncated
  });
}

export function validateSummaryClaimGuardPacket(packet) {
  assertExactKeys(packet, PACKET_KEYS, 'summary-claim guard packet');
  if (packet.schema_version !== '1') throw new Error('unsupported summary-claim guard packet schema');
  if (packet.purpose !== SUMMARY_CLAIM_GUARD_SCOPE
      || packet.policy_version !== SUMMARY_CLAIM_GUARD_POLICY_VERSION) {
    throw new Error('summary-claim guard packet has an unsupported purpose or policy');
  }
  if (!Number.isSafeInteger(packet.consent_revision) || packet.consent_revision < 1) {
    throw new Error('summary-claim guard packet has an invalid consent revision');
  }
  if (packet.review_key !== null
      && (typeof packet.review_key !== 'string' || !REVIEW_KEY_PATTERN.test(packet.review_key))) {
    throw new Error('summary-claim guard packet has an invalid review key');
  }
  if (packet.offset_unit !== 'utf16_code_unit') {
    throw new Error('summary-claim guard packet has an unsupported offset unit');
  }
  assertSafeText(packet.summary, 'summary-claim guard packet summary', SUMMARY_PACKET_LIMIT);
  if (!SHA256_PATTERN.test(packet.summary_sha256) || packet.summary_sha256 !== sha256(packet.summary)) {
    throw new Error('summary-claim guard packet summary digest does not match its contents');
  }
  if (typeof packet.summary_truncated !== 'boolean') {
    throw new Error('summary-claim guard packet truncated flag must be boolean');
  }
  return packet;
}

function boundarySplitsSurrogate(value, offset) {
  if (offset <= 0 || offset >= value.length) return false;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF;
}

function validateNote(raw, index, packet) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`summary-claim guard note ${index + 1} must be an object`);
  }
  const findingKeys = Object.keys(raw).filter((key) => FINDING_ONLY_KEYS.has(key));
  if (findingKeys.length) {
    throw new Error(`summary-claim guard note ${index + 1} contains code-finding fields: ${findingKeys.join(', ')}`);
  }
  assertExactKeys(raw, NOTE_KEYS, `summary-claim guard note ${index + 1}`);
  if (!NOTE_CATEGORIES.has(raw.category)) {
    throw new Error(`summary-claim guard note ${index + 1} has an unsupported category`);
  }
  if (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    throw new Error(`summary-claim guard note ${index + 1} has an invalid confidence`);
  }
  if (!Number.isInteger(raw.summary_start) || !Number.isInteger(raw.summary_end)
      || raw.summary_start < 0 || raw.summary_end <= raw.summary_start
      || raw.summary_end > packet.summary.length) {
    throw new Error(`summary-claim guard note ${index + 1} has an invalid summary offset range`);
  }
  if (boundarySplitsSurrogate(packet.summary, raw.summary_start)
      || boundarySplitsSurrogate(packet.summary, raw.summary_end)) {
    throw new Error(`summary-claim guard note ${index + 1} splits a Unicode surrogate pair`);
  }
  assertSafeText(raw.quote, `summary-claim guard note ${index + 1}.quote`, 600);
  assertSafeText(raw.advice, `summary-claim guard note ${index + 1}.advice`, 800);
  if (packet.summary.slice(raw.summary_start, raw.summary_end) !== raw.quote) {
    throw new Error(`summary-claim guard note ${index + 1} quote does not match its exact summary offsets`);
  }
  return Object.freeze({
    category: raw.category,
    confidence: raw.confidence,
    summary_start: raw.summary_start,
    summary_end: raw.summary_end,
    quote: raw.quote,
    advice: raw.advice
  });
}

export function validateSummaryClaimGuardResult(raw, packet, options = {}) {
  const unknownOptions = Object.keys(options).filter((key) => key !== 'minConfidence');
  if (unknownOptions.length) throw new Error('summary-claim guard result options contain unsupported fields');
  validateSummaryClaimGuardPacket(packet);
  assertExactKeys(raw, RESULT_KEYS, 'summary-claim guard result');
  if (raw.schema_version !== '1') throw new Error('unsupported summary-claim guard result schema');
  if (!RESULT_STATUSES.has(raw.status)) throw new Error('summary-claim guard result has an invalid status');
  assertSafeText(raw.advisory, 'summary-claim guard advisory', 800);
  if (!Array.isArray(raw.notes) || raw.notes.length > 5) {
    throw new Error('summary-claim guard notes must be an array of at most five items');
  }
  if (raw.status === 'notes' && raw.notes.length === 0) {
    throw new Error('summary-claim guard notes status requires at least one note');
  }
  if (raw.status !== 'notes' && raw.notes.length !== 0) {
    throw new Error(`${raw.status} summary-claim guard status must not include notes`);
  }
  const minConfidence = options.minConfidence ?? 0.75;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error('summary-claim guard confidence threshold must be between 0 and 1');
  }
  const validated = raw.notes.map((note, index) => validateNote(note, index, packet));
  const seen = new Set();
  for (const note of validated) {
    const identity = `${note.category}\0${note.summary_start}\0${note.summary_end}`;
    if (seen.has(identity)) throw new Error('summary-claim guard result contains a duplicate note');
    seen.add(identity);
  }
  const notes = validated
    .filter((note) => note.confidence >= minConfidence)
    .sort((left, right) => left.summary_start - right.summary_start
      || left.summary_end - right.summary_end
      || left.category.localeCompare(right.category));
  if (raw.status === 'notes' && notes.length === 0) {
    return Object.freeze({
      schema_version: '1',
      status: 'abstain',
      advisory: `Summary-claim notes were below the ${minConfidence.toFixed(2)} publication threshold.`,
      notes: Object.freeze([])
    });
  }
  return Object.freeze({
    schema_version: '1',
    status: raw.status,
    advisory: raw.advisory,
    notes: Object.freeze(notes)
  });
}

export function summaryClaimGuardConsentFile(root, dataDir) {
  return path.join(resolveDataDir(dataDir), 'summary-claim-guard', `${workspaceKey(root)}.json`);
}

function defaultConsent() {
  return Object.freeze({
    schema_version: '1',
    policy_version: SUMMARY_CLAIM_GUARD_POLICY_VERSION,
    scope: SUMMARY_CLAIM_GUARD_SCOPE,
    enabled: false,
    provider: null,
    model: null,
    consented_at: null,
    configuration_revision: 1
  });
}

export async function readSummaryClaimGuardConsent({ root, dataDir }) {
  const file = summaryClaimGuardConsentFile(root, dataDir);
  const dataRoot = resolveDataDir(dataDir);
  await ensurePrivateStatePath(dataRoot, path.dirname(file));
  return validateSummaryClaimGuardConsent(await readPrivateJson(file) ?? defaultConsent());
}

export async function withSummaryClaimGuardIssuance({
  root,
  dataDir,
  expectedConsent,
  provider,
  model
}, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('summary-claim guard issuance callback must be a function');
  }
  const file = summaryClaimGuardConsentFile(root, dataDir);
  const dataRoot = resolveDataDir(dataDir);
  await ensurePrivateStatePath(dataRoot, path.dirname(file));
  return withFileLock(file, async () => {
    let expected;
    let current;
    try {
      current = validateSummaryClaimGuardConsent(
        await readSummaryClaimGuardConsent({ root, dataDir }),
        { requireEnabled: true, provider, model }
      );
      expected = validateSummaryClaimGuardConsent(expectedConsent, {
        requireEnabled: true,
        provider,
        model
      });
    } catch {
      return Object.freeze({ authorized: false });
    }
    if (canonicalJson(current) !== canonicalJson(expected)) {
      return Object.freeze({ authorized: false });
    }
    return Object.freeze({ authorized: true, value: await callback(current) });
  }, { timeoutMs: CONSENT_LOCK_TIMEOUT_MS, staleMs: CONSENT_LOCK_TIMEOUT_MS });
}

export async function changeSummaryClaimGuardConsent({
  root,
  dataDir,
  action,
  provider,
  model,
  confirmSummaryEgress = false
}) {
  if (!['enable', 'disable', 'status'].includes(action)) {
    throw new Error('summary-claim guard action must be enable, disable, or status');
  }
  if (action === 'status') return readSummaryClaimGuardConsent({ root, dataDir });
  if (action === 'enable' && confirmSummaryEgress !== true) {
    throw new Error('enabling worker-summary egress requires --confirm-summary-egress');
  }
  if (action === 'enable' && (!provider || !model)) {
    throw new Error('enabling worker-summary egress requires an explicit provider and model');
  }
  const file = summaryClaimGuardConsentFile(root, dataDir);
  const dataRoot = resolveDataDir(dataDir);
  await ensurePrivateStatePath(dataRoot, path.dirname(file));
  const mutation = await withFileLock(file, async () => {
    const current = await readSummaryClaimGuardConsent({ root, dataDir });
    const next = validateSummaryClaimGuardConsent({
      ...current,
      enabled: action === 'enable',
      provider: action === 'enable' ? provider : null,
      model: action === 'enable' ? model : null,
      consented_at: action === 'enable' ? new Date().toISOString() : null,
      configuration_revision: current.configuration_revision + 1
    });
    await writePrivateJsonAtomic(file, next);
    const drainCapabilityIds = await snapshotActiveEgressCapabilities({
      root,
      dataDir,
      summaryConsentRevision: current.configuration_revision
    });
    return { next, drainCapabilityIds };
  }, { timeoutMs: CONSENT_LOCK_TIMEOUT_MS, staleMs: CONSENT_LOCK_TIMEOUT_MS });
  await drainEgressCapabilities({
    root,
    dataDir,
    capabilityIds: mutation.drainCapabilityIds,
    timeoutMs: CONSENT_DRAIN_TIMEOUT_MS
  });
  return mutation.next;
}
