import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPetPresentation, selectPetUtterance } from '../src/presentation.mjs';
import { parsePresentationArgs } from '../src/presentation-cli.mjs';
import {
  REVIEW_COMPLETION_XP,
  changePresentationProfile,
  completionXp,
  creditCompletedReview,
  derivePresentationState,
  readCompletedReviewKeys,
  readPresentationProfile
} from '../src/presentation-state.mjs';
import { workspaceKey } from '../src/state.mjs';

const reviewA = 'a'.repeat(64);
const reviewB = 'b'.repeat(64);

test('presentation CLI rejects mutation options for read-only status', () => {
  assert.equal(parsePresentationArgs(['status', '--json']).action, 'status');
  assert.equal(parsePresentationArgs(['set', '--pet-id', 'buddy-bella']).petId, 'buddy-bella');
  assert.throws(
    () => parsePresentationArgs(['status', '--personality', 'warm']),
    /only valid for presentation set/
  );
});

test('presentation XP is idempotent by review key and gives every completed review equal credit', () => {
  assert.deepEqual(completionXp(reviewA), { review_key: reviewA, xp: REVIEW_COMPLETION_XP });
  assert.deepEqual(completionXp(reviewA), completionXp(reviewA));
  assert.deepEqual(completionXp(reviewB), { review_key: reviewB, xp: REVIEW_COMPLETION_XP });

  const state = derivePresentationState({
    personality: 'precise',
    presentationState: 'findings',
    completedReviewKeys: [reviewA, reviewA, reviewB]
  });
  assert.equal(state.completed_reviews, 2);
  assert.equal(state.xp, REVIEW_COMPLETION_XP * 2);
  assert.equal(state.mood, 'alert');
  assert.equal(Object.hasOwn(state, 'finding_count'), false);
  assert.equal(Object.hasOwn(state, 'status_credit'), false);
});

test('mood and personality are closed deterministic presentation values', () => {
  const first = buildPetPresentation({
    personality: 'wry',
    presentationState: 'reviewing',
    reviewKey: reviewA,
    completedReviewKeys: [reviewA]
  });
  const second = buildPetPresentation({
    personality: 'wry',
    presentationState: 'reviewing',
    reviewKey: reviewA,
    completedReviewKeys: [reviewA]
  });
  assert.deepEqual(first, second);
  assert.equal(first.personality, 'wry');
  assert.equal(first.mood, 'focused');
  assert.throws(
    () => derivePresentationState({
      personality: 'chaotic', presentationState: 'idle', completedReviewKeys: []
    }),
    /personality must be one of precise, warm, wry/
  );
  assert.throws(
    () => derivePresentationState({
      personality: 'warm', presentationState: 'celebrating', completedReviewKeys: []
    }),
    /unsupported Buddy presentation state/
  );
});

test('all pet utterances are bounded single-line terminal-safe text', () => {
  const personalities = ['precise', 'warm', 'wry'];
  const states = ['idle', 'working', 'reviewing', 'success', 'findings', 'abstain', 'error'];
  for (const personality of personalities) {
    for (const presentationState of states) {
      const utterance = selectPetUtterance({ personality, presentationState, reviewKey: reviewA });
      assert.equal(utterance.length > 0 && utterance.length <= 180, true);
      assert.doesNotMatch(utterance, /[\r\n\t\u001b\u202e]/u);
    }
  }
});

test('presentation output is additive and accepts no technical-review content', () => {
  const presentation = buildPetPresentation({
    personality: 'warm',
    presentationState: 'success',
    reviewKey: reviewA,
    completedReviewKeys: [reviewA]
  });
  assert.deepEqual(Object.keys(presentation).sort(), [
    'completed_reviews',
    'mood',
    'personality',
    'presentation_state',
    'review_key',
    'schema_version',
    'utterance',
    'xp'
  ]);
  assert.throws(
    () => buildPetPresentation({
      personality: 'warm',
      presentationState: 'success',
      reviewKey: reviewA,
      completedReviewKeys: [reviewA],
      technicalReview: { status: 'findings' }
    }),
    /unsupported or missing fields/
  );
});

test('workspace presentation preferences and completion credits persist separately from review mode', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-presentation-'));
  const root = '/tmp/buddy-presentation-workspace';
  try {
    assert.equal((await readPresentationProfile({ root, dataDir })).pet_id, 'native:selected');
    const profile = await changePresentationProfile({
      root,
      dataDir,
      petId: 'buddy-bella',
      personality: 'wry'
    });
    assert.equal(profile.pet_id, 'buddy-bella');
    assert.equal(profile.personality, 'wry');
    assert.equal(profile.config_revision, 1);
    assert.equal((await creditCompletedReview({ root, dataDir, reviewKey: reviewA })).created, true);
    assert.equal((await creditCompletedReview({ root, dataDir, reviewKey: reviewA })).created, false);
    assert.equal((await creditCompletedReview({ root, dataDir, reviewKey: reviewB })).created, true);
    assert.deepEqual(await readCompletedReviewKeys({ root, dataDir }), [reviewA, reviewB]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('completion credit timestamps cannot use the nullable profile timestamp sentinel', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-presentation-credit-'));
  const root = '/tmp/buddy-presentation-credit-workspace';
  try {
    await creditCompletedReview({ root, dataDir, reviewKey: reviewA });
    const creditFile = path.join(
      dataDir,
      'presentation',
      workspaceKey(root),
      'credits',
      `${reviewA}.json`
    );
    await writeFile(creditFile, `${JSON.stringify({
      schema_version: '1',
      review_key: reviewA,
      xp: REVIEW_COMPLETION_XP,
      credited_at: null
    })}\n`, { encoding: 'utf8' });
    await assert.rejects(
      () => readCompletedReviewKeys({ root, dataDir }),
      /presentation credit is invalid/
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
