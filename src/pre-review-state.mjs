import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  ensurePrivateStatePath,
  readPrivateJson,
  withFileLock,
  writePrivateJsonAtomic
} from './state.mjs';

export const MAX_SPECULATIVE_GENERATIONS = 2;
export const PRE_REVIEW_DEBOUNCE_MS = 1_500;
export const PRE_REVIEW_POLL_MS = 100;
const STATE_SCHEMA_VERSION = '1';
const ACTIVE_STATES = new Set(['starting', 'debouncing', 'capturing', 'reviewing']);
const ALL_STATES = new Set([
  ...ACTIVE_STATES,
  'idle',
  'ready',
  'superseded',
  'failed',
  'disabled',
  'expired'
]);
const NONCE_PATTERN = /^[0-9a-f]{48}$/u;
const REVIEW_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const STATE_LOCK_TIMEOUT_MS = 30_000;

function initialState() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    generation: 0,
    speculative_launches: 0,
    worker_nonce: null,
    worker_state: 'idle',
    active_generation: null,
    active_review_key: null,
    ready_review_key: null,
    final_requested: false,
    final_review_key: null,
    updated_at: new Date(0).toISOString()
  };
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Buddy pre-review state must be one object');
  }
  const expected = Object.keys(initialState()).sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('Buddy pre-review state contains unsupported or missing fields');
  }
  if (value.schema_version !== STATE_SCHEMA_VERSION
      || !Number.isSafeInteger(value.generation) || value.generation < 0
      || !Number.isSafeInteger(value.speculative_launches)
      || value.speculative_launches < 0 || value.speculative_launches > MAX_SPECULATIVE_GENERATIONS
      || !ALL_STATES.has(value.worker_state)
      || (value.worker_nonce !== null && !NONCE_PATTERN.test(value.worker_nonce))
      || (value.active_generation !== null
        && (!Number.isSafeInteger(value.active_generation) || value.active_generation < 1))
      || (value.active_review_key !== null && !REVIEW_KEY_PATTERN.test(value.active_review_key))
      || (value.ready_review_key !== null && !REVIEW_KEY_PATTERN.test(value.ready_review_key))
      || typeof value.final_requested !== 'boolean'
      || (value.final_review_key !== null && !REVIEW_KEY_PATTERN.test(value.final_review_key))
      || !Number.isFinite(Date.parse(value.updated_at))) {
    throw new Error('Buddy pre-review state is invalid');
  }
  if (ACTIVE_STATES.has(value.worker_state) !== (value.worker_nonce !== null)) {
    throw new Error('Buddy pre-review worker state has an invalid owner');
  }
  if (!ACTIVE_STATES.has(value.worker_state)
      && (value.active_generation !== null || value.active_review_key !== null)) {
    throw new Error('Buddy terminal pre-review state cannot retain an active generation');
  }
  if (!value.final_requested && value.final_review_key !== null) {
    throw new Error('Buddy pre-review final key requires a final request');
  }
  return value;
}

export function preReviewStateFile(directory) {
  return path.join(directory, 'pre-review.json');
}

export function preReviewIsActive(state) {
  return ACTIVE_STATES.has(state?.worker_state);
}

export async function readPreReviewState(directory) {
  const value = await readPrivateJson(preReviewStateFile(directory));
  return value ? validateState(value) : initialState();
}

async function mutateState(directory, callback) {
  const runtimeRoot = path.resolve(directory, '..', '..', '..', '..');
  await ensurePrivateStatePath(runtimeRoot, directory);
  const file = preReviewStateFile(directory);
  return withFileLock(file, async () => {
    const current = await readPreReviewState(directory);
    const next = validateState(await callback({ ...current }));
    await writePrivateJsonAtomic(file, next);
    return next;
  }, { timeoutMs: STATE_LOCK_TIMEOUT_MS, staleMs: STATE_LOCK_TIMEOUT_MS });
}

function nowState(state) {
  return { ...state, updated_at: new Date().toISOString() };
}

export async function notePreReviewMutation(directory) {
  let launched = false;
  const state = await mutateState(directory, (current) => {
    const next = {
      ...current,
      generation: current.generation + 1,
      ready_review_key: null
    };
    if (!current.final_requested
        && !preReviewIsActive(current)
        && current.speculative_launches < MAX_SPECULATIVE_GENERATIONS) {
      launched = true;
      next.worker_nonce = randomBytes(24).toString('hex');
      next.worker_state = 'starting';
    }
    return nowState(next);
  });
  return { state, launched, workerNonce: launched ? state.worker_nonce : null };
}

export async function markPreReviewLaunchFailed(directory, workerNonce) {
  return mutateState(directory, (current) => {
    if (current.worker_nonce !== workerNonce || current.worker_state !== 'starting') return current;
    return nowState({
      ...current,
      worker_nonce: null,
      worker_state: 'failed',
      active_generation: null,
      active_review_key: null
    });
  });
}

export async function claimPreReviewWorker(directory, workerNonce) {
  let claimed = false;
  const state = await mutateState(directory, (current) => {
    if (current.worker_nonce !== workerNonce || current.worker_state !== 'starting') return current;
    claimed = true;
    return nowState({ ...current, worker_state: 'debouncing' });
  });
  return { claimed, state };
}

export async function updatePreReviewWorker(directory, workerNonce, update) {
  let updated = false;
  const state = await mutateState(directory, (current) => {
    if (current.worker_nonce !== workerNonce || !preReviewIsActive(current)) return current;
    updated = true;
    return nowState({ ...current, ...update });
  });
  return { updated, state };
}

export async function finishPreReviewWorker(directory, workerNonce, status, readyReviewKey = null) {
  if (!['ready', 'superseded', 'failed', 'disabled', 'expired'].includes(status)) {
    throw new Error('Buddy pre-review worker terminal status is invalid');
  }
  return mutateState(directory, (current) => {
    if (current.worker_nonce !== workerNonce) return current;
    return nowState({
      ...current,
      worker_nonce: null,
      worker_state: status,
      active_generation: null,
      active_review_key: null,
      ready_review_key: status === 'ready' ? readyReviewKey : null
    });
  });
}

export async function incrementPreReviewLaunch(directory, workerNonce, generation, reviewKey) {
  let incremented = false;
  const state = await mutateState(directory, (current) => {
    if (current.worker_nonce !== workerNonce || !preReviewIsActive(current)
        || current.speculative_launches >= MAX_SPECULATIVE_GENERATIONS) return current;
    incremented = true;
    return nowState({
      ...current,
      speculative_launches: current.speculative_launches + 1,
      worker_state: 'reviewing',
      active_generation: generation,
      active_review_key: reviewKey
    });
  });
  return { incremented, state };
}

export async function requestFinalReview(directory, reviewKey) {
  return mutateState(directory, (current) => {
    const safeTakeover = preReviewIsActive(current) && current.active_review_key === null;
    return nowState({
      ...current,
      worker_nonce: safeTakeover ? null : current.worker_nonce,
      worker_state: safeTakeover ? 'superseded' : current.worker_state,
      active_generation: safeTakeover ? null : current.active_generation,
      active_review_key: safeTakeover ? null : current.active_review_key,
      ready_review_key: safeTakeover ? null : current.ready_review_key,
      final_requested: true,
      final_review_key: reviewKey
    });
  });
}

export async function waitForPreReviewFinalization(directory, reviewKey, receipt, timeoutMs) {
  await requestFinalReview(directory, reviewKey);
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 0;
  const deadline = Date.now() + boundedTimeout;
  let exactTerminal = null;
  while (true) {
    const [state, terminal] = await Promise.all([
      readPreReviewState(directory),
      readPrivateJson(receipt)
    ]);
    if (terminal?.review_key === reviewKey) exactTerminal = terminal;
    if (!preReviewIsActive(state)) {
      return exactTerminal
        ? { status: 'ready', state, terminal: exactTerminal, ownerActive: false }
        : { status: 'not_ready', state, terminal: null, ownerActive: false };
    }
    if (Date.now() >= deadline) {
      if (exactTerminal) {
        return { status: 'ready', state, terminal: exactTerminal, ownerActive: true };
      }
      const exactOwner = state.final_review_key === reviewKey
        && (state.active_review_key === null || state.active_review_key === reviewKey);
      return {
        status: exactOwner ? 'ambiguous' : 'not_ready',
        state,
        terminal: null,
        ownerActive: true
      };
    }
    await new Promise((resolve) => setTimeout(resolve, PRE_REVIEW_POLL_MS));
  }
}
