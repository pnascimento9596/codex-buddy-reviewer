import { hasUnsafeTerminalControls } from './policy.mjs';
import {
  derivePresentationState,
  deterministicChoice,
  validatePresentationPersonality,
  validatePresentationState
} from './presentation-state.mjs';

const REVIEW_KEY_PATTERN = /^[0-9a-f]{64}$/;
const MAX_UTTERANCE_CHARS = 180;

const UTTERANCES = Object.freeze({
  precise: Object.freeze({
    idle: Object.freeze(['Ready for the next turn.']),
    working: Object.freeze(['Tracking the turn. I will review the observed changes when it finishes.']),
    reviewing: Object.freeze([
      'Reviewing the completed turn against its captured diff.',
      'Checking the observed changes independently now.'
    ]),
    success: Object.freeze([
      'Review complete. No validated defects in the reviewable evidence.',
      'Independent pass complete. The reviewable evidence is clear.'
    ]),
    findings: Object.freeze([
      'Review complete. I found validated issues worth another pass.',
      'Independent pass complete. There are grounded findings to inspect.'
    ]),
    abstain: Object.freeze([
      'Review complete, but the evidence was not sufficient for a clean conclusion.',
      'I finished the pass and abstained where the evidence was incomplete.'
    ]),
    error: Object.freeze(['The independent review could not complete. The coding result is unchanged.'])
  }),
  warm: Object.freeze({
    idle: Object.freeze(['I am here when you are ready.']),
    working: Object.freeze(['I am keeping an eye on the turn and will review it when the work lands.']),
    reviewing: Object.freeze([
      'Nice handoff. I am giving the completed changes a careful second look.',
      'I have the diff. Let me check it with a fresh set of eyes.'
    ]),
    success: Object.freeze([
      'Second look complete. I did not find a validated defect in the reviewable evidence.',
      'All checked. The independent pass came back clear.'
    ]),
    findings: Object.freeze([
      'Second look complete. I found a few grounded points we should inspect together.',
      'I found validated issues in the diff. Let us give them one more pass.'
    ]),
    abstain: Object.freeze([
      'I finished the pass, but the available evidence was not enough for a clean call.',
      'I could not verify this one fully, so I am leaving an honest abstention.'
    ]),
    error: Object.freeze(['The second look could not complete, but your coding result is still intact.'])
  }),
  wry: Object.freeze({
    idle: Object.freeze(['Standing by, professionally nosy.']),
    working: Object.freeze(['I will wait for the code to stop moving before I become opinionated.']),
    reviewing: Object.freeze([
      'The first pass had its turn. Now the diff gets a second opinion.',
      'Reviewing the diff now. Confidence is nice; evidence is nicer.'
    ]),
    success: Object.freeze([
      'Second opinion complete. The reviewable evidence declined to provide drama.',
      'The diff survived another engineer. Respectfully uneventful.'
    ]),
    findings: Object.freeze([
      'The diff had notes. Of course it had notes.',
      'Second opinion complete. A few gremlins left forwarding addresses.'
    ]),
    abstain: Object.freeze([
      'The evidence was coy, so I abstained instead of inventing confidence.',
      'Not enough signal for a verdict. Even the gremlins deserve due process.'
    ]),
    error: Object.freeze(['The review tripped over its own shoelaces. The coding result is unchanged.'])
  })
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

function validateOptionalReviewKey(value) {
  if (value !== null && (typeof value !== 'string' || !REVIEW_KEY_PATTERN.test(value))) {
    throw new Error('Buddy presentation review key must be null or a lowercase SHA-256 digest');
  }
  return value;
}

function assertSafeUtterance(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_UTTERANCE_CHARS) {
    throw new Error(`Buddy utterance must contain 1 to ${MAX_UTTERANCE_CHARS} characters`);
  }
  if (/[\r\n\t]/u.test(value) || hasUnsafeTerminalControls(value)) {
    throw new Error('Buddy utterance contains unsafe terminal characters');
  }
  return value;
}

export function selectPetUtterance(options) {
  assertExactKeys(
    options,
    ['personality', 'presentationState', 'reviewKey'],
    'Buddy utterance options'
  );
  const personality = validatePresentationPersonality(options.personality);
  const presentationState = validatePresentationState(options.presentationState);
  const reviewKey = validateOptionalReviewKey(options.reviewKey);
  const utterance = deterministicChoice(
    UTTERANCES[personality][presentationState],
    `${personality}:${presentationState}:${reviewKey ?? 'no-review'}`
  );
  return assertSafeUtterance(utterance);
}

export function buildPetPresentation(options) {
  assertExactKeys(
    options,
    ['personality', 'presentationState', 'reviewKey', 'completedReviewKeys'],
    'Buddy presentation options'
  );
  const reviewKey = validateOptionalReviewKey(options.reviewKey);
  const state = derivePresentationState({
    personality: options.personality,
    presentationState: options.presentationState,
    completedReviewKeys: options.completedReviewKeys
  });
  return Object.freeze({
    ...state,
    presentation_state: options.presentationState,
    review_key: reviewKey,
    utterance: selectPetUtterance({
      personality: state.personality,
      presentationState: options.presentationState,
      reviewKey
    })
  });
}
