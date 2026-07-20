import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { hasUnsafeTerminalControls } from './policy.mjs';
import {
  ensurePrivateStatePath,
  readPrivateJson,
  resolveDataDir,
  withFileLock,
  workspaceKey,
  writePrivateJsonAtomic,
  writePrivateJsonExclusive
} from './state.mjs';

export const PRESENTATION_PERSONALITIES = Object.freeze(['precise', 'warm', 'wry']);
export const REVIEW_COMPLETION_XP = 10;

const PERSONALITY_SET = new Set(PRESENTATION_PERSONALITIES);
const REVIEW_KEY_PATTERN = /^[0-9a-f]{64}$/;
const PET_ID_PATTERN = /^(?:native:selected|buddy-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?)$/;
const PRESENTATION_SCHEMA_VERSION = '1';
const PRESENTATION_LOCK_TIMEOUT_MS = 30_000;
const PRESENTATION_STATES = new Set([
  'idle',
  'working',
  'reviewing',
  'success',
  'findings',
  'abstain',
  'error'
]);
const MOOD_BY_STATE = Object.freeze({
  idle: 'calm',
  working: 'engaged',
  reviewing: 'focused',
  success: 'content',
  findings: 'alert',
  abstain: 'uncertain',
  error: 'concerned'
});

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

export function validatePresentationPersonality(value) {
  if (!PERSONALITY_SET.has(value)) {
    throw new Error(`Buddy presentation personality must be one of ${PRESENTATION_PERSONALITIES.join(', ')}`);
  }
  return value;
}

export function validatePresentationState(value) {
  if (!PRESENTATION_STATES.has(value)) {
    throw new Error(`unsupported Buddy presentation state: ${String(value)}`);
  }
  return value;
}

function validateReviewKey(value, label = 'Buddy review key') {
  if (typeof value !== 'string' || !REVIEW_KEY_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function uniqueReviewKeys(values) {
  if (!Array.isArray(values)) {
    throw new Error('Buddy completed review keys must be an array');
  }
  const unique = new Set();
  for (const [index, value] of values.entries()) {
    unique.add(validateReviewKey(value, `Buddy completed review key ${index + 1}`));
  }
  return unique;
}

export function completionXp(reviewKey) {
  return Object.freeze({
    review_key: validateReviewKey(reviewKey),
    xp: REVIEW_COMPLETION_XP
  });
}

export function derivePresentationState(options = {}) {
  assertExactKeys(
    options,
    ['personality', 'presentationState', 'completedReviewKeys'],
    'Buddy presentation state options'
  );
  const personality = validatePresentationPersonality(options.personality);
  const presentationState = validatePresentationState(options.presentationState);
  const completed = uniqueReviewKeys(options.completedReviewKeys);
  const xp = completed.size * REVIEW_COMPLETION_XP;
  if (!Number.isSafeInteger(xp)) throw new Error('Buddy presentation XP exceeds the safe integer range');
  return Object.freeze({
    schema_version: '1',
    personality,
    mood: MOOD_BY_STATE[presentationState],
    xp,
    completed_reviews: completed.size
  });
}

export function deterministicChoice(values, seed) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Buddy presentation choices must be a non-empty array');
  }
  if (typeof seed !== 'string' || seed.length > 512 || hasUnsafeTerminalControls(seed)) {
    throw new Error('Buddy presentation seed must be a bounded terminal-safe string');
  }
  const digest = createHash('sha256').update(seed).digest();
  return values[digest.readUInt32BE(0) % values.length];
}

function presentationPaths(root, dataDir) {
  const dataRoot = resolveDataDir(dataDir);
  const key = workspaceKey(root);
  const directory = path.join(dataRoot, 'presentation', key);
  return {
    dataRoot,
    directory,
    file: path.join(directory, 'profile.json'),
    credits: path.join(directory, 'credits'),
    lock: path.join(directory, 'profile')
  };
}

function defaultPresentationProfile(root) {
  return Object.freeze({
    schema_version: PRESENTATION_SCHEMA_VERSION,
    workspace_root: root,
    config_revision: 0,
    pet_id: 'native:selected',
    personality: 'precise',
    updated_at: null
  });
}

function validateTimestamp(value) {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

export function validatePresentationProfile(profile, root) {
  assertExactKeys(
    profile,
    ['schema_version', 'workspace_root', 'config_revision', 'pet_id', 'personality', 'updated_at'],
    'Buddy presentation profile'
  );
  if (profile.schema_version !== PRESENTATION_SCHEMA_VERSION || profile.workspace_root !== root) {
    throw new Error('Buddy presentation profile belongs to another workspace or schema');
  }
  if (!Number.isSafeInteger(profile.config_revision) || profile.config_revision < 0) {
    throw new Error('Buddy presentation profile has an invalid revision');
  }
  if (typeof profile.pet_id !== 'string' || !PET_ID_PATTERN.test(profile.pet_id)) {
    throw new Error('Buddy presentation profile has an unsupported pet id');
  }
  validatePresentationPersonality(profile.personality);
  if (!validateTimestamp(profile.updated_at)) {
    throw new Error('Buddy presentation profile has an invalid update timestamp');
  }
  return Object.freeze({ ...profile });
}

export async function readPresentationProfile({ root, dataDir }) {
  const paths = presentationPaths(root, dataDir);
  await ensurePrivateStatePath(paths.dataRoot, paths.directory);
  return validatePresentationProfile(
    await readPrivateJson(paths.file) ?? defaultPresentationProfile(root),
    root
  );
}

export async function changePresentationProfile({ root, dataDir, petId, personality }) {
  if (petId === undefined && personality === undefined) return readPresentationProfile({ root, dataDir });
  if (petId !== undefined && (typeof petId !== 'string' || !PET_ID_PATTERN.test(petId))) {
    throw new Error('Buddy presentation pet must be native:selected or a bounded buddy-* pet id');
  }
  if (personality !== undefined) validatePresentationPersonality(personality);
  const paths = presentationPaths(root, dataDir);
  await ensurePrivateStatePath(paths.dataRoot, paths.directory);
  return withFileLock(paths.lock, async () => {
    const current = await readPresentationProfile({ root, dataDir });
    const next = validatePresentationProfile({
      ...current,
      pet_id: petId ?? current.pet_id,
      personality: personality ?? current.personality,
      config_revision: current.config_revision + 1,
      updated_at: new Date().toISOString()
    }, root);
    await writePrivateJsonAtomic(paths.file, next);
    return next;
  }, { timeoutMs: PRESENTATION_LOCK_TIMEOUT_MS, staleMs: PRESENTATION_LOCK_TIMEOUT_MS });
}

export async function creditCompletedReview({ root, dataDir, reviewKey }) {
  validateReviewKey(reviewKey);
  const paths = presentationPaths(root, dataDir);
  await ensurePrivateStatePath(paths.dataRoot, paths.credits);
  const file = path.join(paths.credits, `${reviewKey}.json`);
  const created = await writePrivateJsonExclusive(file, {
    schema_version: '1',
    review_key: reviewKey,
    xp: REVIEW_COMPLETION_XP,
    credited_at: new Date().toISOString()
  });
  return Object.freeze({ created, file, review_key: reviewKey, xp: REVIEW_COMPLETION_XP });
}

export async function readCompletedReviewKeys({ root, dataDir }) {
  const paths = presentationPaths(root, dataDir);
  await ensurePrivateStatePath(paths.dataRoot, paths.credits);
  const entries = await readdir(paths.credits, { withFileTypes: true });
  const keys = [];
  for (const entry of entries) {
    const match = entry.name.match(/^([0-9a-f]{64})\.json$/);
    if (!match || entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Buddy presentation credits contain an unsupported entry: ${entry.name}`);
    }
    const file = path.join(paths.credits, entry.name);
    const details = await lstat(file);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error('Buddy presentation credit must be a regular non-symlink file');
    }
    const credit = await readPrivateJson(file);
    assertExactKeys(credit, ['schema_version', 'review_key', 'xp', 'credited_at'], 'Buddy presentation credit');
    if (credit.schema_version !== '1' || credit.review_key !== match[1]
        || credit.xp !== REVIEW_COMPLETION_XP
        || typeof credit.credited_at !== 'string'
        || !validateTimestamp(credit.credited_at)) {
      throw new Error('Buddy presentation credit is invalid');
    }
    keys.push(match[1]);
  }
  return Object.freeze(keys.sort());
}
