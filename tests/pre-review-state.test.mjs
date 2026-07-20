import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claimPreReviewWorker,
  finishPreReviewWorker,
  incrementPreReviewLaunch,
  notePreReviewMutation,
  requestFinalReview,
  updatePreReviewWorker,
  waitForPreReviewFinalization
} from '../src/pre-review-state.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'buddy-pre-review-state-'));
  const directory = path.join(root, 'turns', 'workspace', 'session', 'turn');
  const receipt = path.join(root, 'automatic-reviews', 'receipt.json');
  await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(receipt), { recursive: true });
  return { directory, receipt };
}

test('Stop atomically takes over a worker that has not fenced a provider attempt', async () => {
  const { directory, receipt } = await fixture();
  const noted = await notePreReviewMutation(directory);
  await claimPreReviewWorker(directory, noted.workerNonce);
  await updatePreReviewWorker(directory, noted.workerNonce, {
    worker_state: 'capturing',
    active_generation: 1,
    active_review_key: null
  });
  const reviewKey = 'a'.repeat(64);
  const result = await waitForPreReviewFinalization(directory, reviewKey, receipt, 0);
  assert.equal(result.status, 'not_ready');
  assert.equal(result.ownerActive, false);
  assert.equal(result.terminal, null);
  assert.equal(result.state.worker_state, 'superseded');
  assert.equal(result.state.worker_nonce, null);
  assert.equal(result.state.active_generation, null);
  assert.equal(result.state.active_review_key, null);
  assert.equal(result.state.final_review_key, reviewKey);
  const lateLaunch = await incrementPreReviewLaunch(
    directory,
    noted.workerNonce,
    1,
    reviewKey
  );
  assert.equal(lateLaunch.incremented, false);
  assert.equal(lateLaunch.state.worker_state, 'superseded');
});

test('Stop preserves an active exact attempt as ambiguous and never takes ownership', async () => {
  const { directory, receipt } = await fixture();
  const noted = await notePreReviewMutation(directory);
  await claimPreReviewWorker(directory, noted.workerNonce);
  const reviewKey = 'd'.repeat(64);
  const launched = await incrementPreReviewLaunch(directory, noted.workerNonce, 1, reviewKey);
  assert.equal(launched.incremented, true);
  const result = await waitForPreReviewFinalization(directory, reviewKey, receipt, 0);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.ownerActive, true);
  assert.equal(result.state.worker_nonce, noted.workerNonce);
  assert.equal(result.state.worker_state, 'reviewing');
  assert.equal(result.state.active_review_key, reviewKey);
});

test('final request and launch race resolves to either safe takeover or fenced ambiguity', async () => {
  const { directory } = await fixture();
  const noted = await notePreReviewMutation(directory);
  await claimPreReviewWorker(directory, noted.workerNonce);
  const reviewKey = 'e'.repeat(64);
  const [requested, launched] = await Promise.all([
    requestFinalReview(directory, reviewKey),
    incrementPreReviewLaunch(directory, noted.workerNonce, 1, reviewKey)
  ]);
  const finalState = launched.state.final_requested ? launched.state : requested;
  assert.equal(finalState.final_requested, true);
  assert.equal(finalState.final_review_key, reviewKey);
  if (launched.incremented) {
    assert.equal(finalState.worker_state, 'reviewing');
    assert.equal(finalState.active_review_key, reviewKey);
  } else {
    assert.equal(finalState.worker_state, 'superseded');
    assert.equal(finalState.worker_nonce, null);
    assert.equal(finalState.active_review_key, null);
  }
});

test('an exact immutable receipt can be adopted at the deadline while its owner is active', async () => {
  const { directory, receipt } = await fixture();
  const noted = await notePreReviewMutation(directory);
  const reviewKey = 'b'.repeat(64);
  await claimPreReviewWorker(directory, noted.workerNonce);
  await incrementPreReviewLaunch(directory, noted.workerNonce, 1, reviewKey);
  const terminal = { schema_version: '1', review_key: reviewKey, terminal_status: 'no_findings' };
  await writeFile(receipt, `${JSON.stringify(terminal)}\n`);
  const result = await waitForPreReviewFinalization(directory, reviewKey, receipt, 0);
  assert.equal(result.status, 'ready');
  assert.equal(result.ownerActive, true);
  assert.deepEqual(result.terminal, terminal);
});

test('wait prefers a prompt terminal owner before returning an exact receipt', async () => {
  const { directory, receipt } = await fixture();
  const noted = await notePreReviewMutation(directory);
  const reviewKey = 'c'.repeat(64);
  await claimPreReviewWorker(directory, noted.workerNonce);
  await incrementPreReviewLaunch(directory, noted.workerNonce, 1, reviewKey);
  const terminal = { schema_version: '1', review_key: reviewKey, terminal_status: 'no_findings' };
  await writeFile(receipt, `${JSON.stringify(terminal)}\n`);
  setTimeout(() => {
    void finishPreReviewWorker(directory, noted.workerNonce, 'ready', reviewKey);
  }, 10);
  const result = await waitForPreReviewFinalization(directory, reviewKey, receipt, 1_000);
  assert.equal(result.status, 'ready');
  assert.equal(result.ownerActive, false);
  assert.equal(result.state.worker_state, 'ready');
  assert.deepEqual(result.terminal, terminal);
});
