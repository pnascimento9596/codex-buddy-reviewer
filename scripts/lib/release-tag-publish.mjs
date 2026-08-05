/**
 * Remote annotated-tag publication reconcile for the release workflow.
 *
 * Root-cause class this guards (rc.4 run 31013433126 attempt 1):
 * git push of the exact local tag ref succeeded, then a single immediate
 * REST read of /git/ref/tags/... returned a non-match (empty/404 under
 * eventual consistency). The immutable-tag ruleset makes a false mismatch
 * after push operationally expensive: the version number is burned if the
 * tag is real, and a false failure leaves a partial publish (tag, no Release).
 *
 * Contract:
 * - Pre-push: every check that does not require the remote tag happens first.
 * - Idempotent: remote tag_object == receipt.tag_object is success (no push).
 * - Conflict: remote tag present with a different object fails closed before push.
 * - Post-push: bounded backoff on consistency-sensitive reads; genuine SHA
 *   mismatch still fails closed immediately; the mismatch check is not weakened.
 */

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;

export const DEFAULT_POST_PUSH_BACKOFF_MS = Object.freeze([200, 400, 800, 1600, 3200]);

export function isSha1(value) {
  return typeof value === 'string' && SHA1_PATTERN.test(value);
}

/**
 * Classify one GitHub "get a reference" response for refs/tags/<tag>.
 *
 * `gh api --jq '.object.sha'` on HTTP success prints the 40-hex object SHA.
 * On HTTP failure (including 404), gh prints the error JSON body to stdout and
 * exits non-zero — jq is not applied — so 404 detection must read that body.
 */
export function classifyRemoteTagLookup({
  exitCode,
  stdout,
  expectedTagObject,
  objectType = null
}) {
  if (!isSha1(expectedTagObject)) {
    return { status: 'invalid', detail: 'expected tag object must be a 40-character lowercase SHA-1' };
  }

  const body = typeof stdout === 'string' ? stdout.trim() : '';

  if (exitCode === 0) {
    if (!isSha1(body)) {
      return { status: 'invalid', detail: 'remote release tag returned an invalid object identity', remoteSha: body || null };
    }
    if (objectType !== null && objectType !== undefined && objectType !== 'tag' && objectType !== 'commit') {
      return { status: 'invalid', detail: `remote release tag has unsupported object type ${String(objectType)}`, remoteSha: body };
    }
    // Annotated tags must compare the tag object, not a peeled commit. Callers
    // that can observe object.type=commit for an annotated tag must treat that
    // as not-yet-consistent rather than a match against receipt.tag_object.
    if (objectType === 'commit' && body !== expectedTagObject) {
      return {
        status: 'inconsistent',
        detail: 'remote ref currently names a commit object rather than the annotated tag object',
        remoteSha: body
      };
    }
    if (body === expectedTagObject) {
      return { status: 'match', remoteSha: body };
    }
    return {
      status: 'mismatch',
      detail: 'remote tag object does not match the verified distribution receipt',
      remoteSha: body
    };
  }

  if (body) {
    try {
      const parsed = JSON.parse(body);
      const status = parsed && typeof parsed === 'object' ? parsed.status : undefined;
      const message = parsed && typeof parsed === 'object' ? parsed.message : undefined;
      if ((String(status) === '404' || status === 404) && message === 'Not Found') {
        return { status: 'absent', remoteSha: null };
      }
    } catch {
      // Fall through to generic lookup failure.
    }
  }

  return {
    status: 'error',
    detail: 'the remote release tag lookup failed without proving absence or identity',
    remoteSha: null
  };
}

/**
 * Decide whether publication may push, must reuse, or must abort — before any
 * mutation. Ordering invariant: call only after local receipt/bundle verification.
 */
export function planPrePushAction(classification) {
  switch (classification.status) {
    case 'match':
      return { action: 'reuse', reason: 'remote tag already equals the verified distribution receipt' };
    case 'absent':
      return { action: 'push', reason: 'remote tag is proven absent' };
    case 'mismatch':
      return {
        action: 'abort_conflict',
        reason: 'The release tag already exists with a different object. Publication refuses to overwrite it.'
      };
    case 'inconsistent':
      return {
        action: 'retry_lookup',
        reason: classification.detail || 'remote tag ref is not yet consistent'
      };
    case 'invalid':
      return {
        action: 'abort_invalid',
        reason: classification.detail || 'The remote release tag returned an invalid object identity.'
      };
    case 'error':
      return {
        action: 'abort_lookup',
        reason: classification.detail || 'The remote release tag lookup failed without proving absence.'
      };
    default:
      return { action: 'abort_lookup', reason: 'unknown remote tag classification' };
  }
}

/**
 * Post-push verification policy. Genuine mismatch fails closed with no retry.
 * Absent/error/inconsistent after a successful push may retry with backoff.
 */
export function planPostPushVerification({
  classification,
  pushSucceeded,
  attempt,
  maxAttempts
}) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('attempt must be a positive integer');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }

  if (classification.status === 'match') {
    return { action: 'success', reason: 'published tag object matches the verified distribution receipt' };
  }

  if (classification.status === 'mismatch') {
    return {
      action: 'fail_mismatch',
      reason: 'Published tag object does not match the verified distribution receipt.'
    };
  }

  if (!pushSucceeded) {
    return {
      action: 'fail_push',
      reason: 'Tag publication failed and exact remote reconciliation did not prove success.'
    };
  }

  if (attempt < maxAttempts
      && (classification.status === 'absent'
        || classification.status === 'error'
        || classification.status === 'inconsistent'
        || classification.status === 'invalid')) {
    return {
      action: 'retry',
      reason: classification.detail || 'post-push remote tag read is not yet consistent'
    };
  }

  return {
    action: 'fail_mismatch',
    reason: 'Published tag object does not match the verified distribution receipt.'
  };
}

function delay(ms, sleep) {
  if (ms <= 0) return Promise.resolve();
  return sleep(ms);
}

/**
 * Ensure the remote annotated tag equals receipt.tag_object.
 *
 * `lookup` must return `{ exitCode, stdout, objectType? }` for one read.
 * `push` is invoked at most once and only after pre-push classification is absent.
 * `sleep(ms)` injects backoff (tests use a no-op or fake clock).
 */
export async function ensureRemoteTagMatches({
  expectedTagObject,
  lookup,
  push,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  prePushLookupAttempts = 3,
  prePushBackoffMs = Object.freeze([150, 300, 600]),
  postPushBackoffMs = DEFAULT_POST_PUSH_BACKOFF_MS
}) {
  if (!isSha1(expectedTagObject)) {
    throw new Error('expected tag object must be a 40-character lowercase SHA-1');
  }
  if (typeof lookup !== 'function') throw new Error('lookup function is required');
  if (typeof push !== 'function') throw new Error('push function is required');
  if (typeof sleep !== 'function') throw new Error('sleep function is required');

  const preAttempts = Math.max(1, prePushLookupAttempts);
  let classification = null;
  let plan = null;

  for (let attempt = 1; attempt <= preAttempts; attempt += 1) {
    const raw = await lookup();
    classification = classifyRemoteTagLookup({
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      expectedTagObject,
      objectType: raw.objectType ?? null
    });
    plan = planPrePushAction(classification);
    if (plan.action !== 'retry_lookup' || attempt === preAttempts) break;
    await delay(prePushBackoffMs[Math.min(attempt - 1, prePushBackoffMs.length - 1)] ?? 0, sleep);
  }

  if (plan.action === 'abort_conflict'
      || plan.action === 'abort_invalid'
      || plan.action === 'abort_lookup'
      || plan.action === 'retry_lookup') {
    const error = new Error(plan.reason);
    error.code = plan.action;
    error.classification = classification;
    throw error;
  }

  if (plan.action === 'reuse') {
    return {
      outcome: 'already_present',
      remoteSha: classification.remoteSha,
      pushed: false
    };
  }

  const pushResult = await push();
  const pushSucceeded = pushResult && pushResult.exitCode === 0;
  const postAttempts = Math.max(1, postPushBackoffMs.length + 1);

  for (let attempt = 1; attempt <= postAttempts; attempt += 1) {
    const raw = await lookup();
    classification = classifyRemoteTagLookup({
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      expectedTagObject,
      objectType: raw.objectType ?? null
    });
    const verification = planPostPushVerification({
      classification,
      pushSucceeded,
      attempt,
      maxAttempts: postAttempts
    });

    if (verification.action === 'success') {
      return {
        outcome: pushSucceeded ? 'pushed' : 'reconciled_after_push_failure',
        remoteSha: classification.remoteSha,
        pushed: Boolean(pushSucceeded)
      };
    }

    if (verification.action === 'retry') {
      await delay(postPushBackoffMs[Math.min(attempt - 1, postPushBackoffMs.length - 1)] ?? 0, sleep);
      continue;
    }

    const error = new Error(verification.reason);
    error.code = verification.action;
    error.classification = classification;
    error.pushSucceeded = pushSucceeded;
    throw error;
  }

  const error = new Error('Published tag object does not match the verified distribution receipt.');
  error.code = 'fail_mismatch';
  error.classification = classification;
  error.pushSucceeded = pushSucceeded;
  throw error;
}
