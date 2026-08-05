import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyRemoteTagLookup,
  ensureRemoteTagMatches,
  planPostPushVerification,
  planPrePushAction
} from '../scripts/lib/release-tag-publish.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const expected = 'b5d8fbc47515b6ae0ab96491b4125cc6ea8f9149';
const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const peeled = 'ac9f870f455645613c9f3dc8de4196fdc8a25d6d';
const notFoundBody = JSON.stringify({
  message: 'Not Found',
  documentation_url: 'https://docs.github.com/rest/git/refs#get-a-reference',
  status: '404'
});

test('classifyRemoteTagLookup treats 404 JSON body as proven absence', () => {
  assert.deepEqual(
    classifyRemoteTagLookup({ exitCode: 1, stdout: notFoundBody, expectedTagObject: expected }),
    { status: 'absent', remoteSha: null }
  );
});

test('classifyRemoteTagLookup matches annotated tag object identity', () => {
  assert.deepEqual(
    classifyRemoteTagLookup({
      exitCode: 0,
      stdout: `${expected}\n`,
      expectedTagObject: expected,
      objectType: 'tag'
    }),
    { status: 'match', remoteSha: expected }
  );
});

test('classifyRemoteTagLookup fails closed on a different remote tag object', () => {
  assert.deepEqual(
    classifyRemoteTagLookup({
      exitCode: 0,
      stdout: other,
      expectedTagObject: expected,
      objectType: 'tag'
    }),
    {
      status: 'mismatch',
      detail: 'remote tag object does not match the verified distribution receipt',
      remoteSha: other
    }
  );
});

test('classifyRemoteTagLookup treats peeled-commit reads as inconsistent, not as a match', () => {
  assert.equal(
    classifyRemoteTagLookup({
      exitCode: 0,
      stdout: peeled,
      expectedTagObject: expected,
      objectType: 'commit'
    }).status,
    'inconsistent'
  );
});

test('planPrePushAction is idempotent for an already-matching remote tag', () => {
  assert.deepEqual(
    planPrePushAction({ status: 'match', remoteSha: expected }),
    {
      action: 'reuse',
      reason: 'remote tag already equals the verified distribution receipt'
    }
  );
  assert.equal(planPrePushAction({ status: 'absent', remoteSha: null }).action, 'push');
  assert.equal(
    planPrePushAction({
      status: 'mismatch',
      remoteSha: other,
      detail: 'remote tag object does not match the verified distribution receipt'
    }).action,
    'abort_conflict'
  );
});

test('planPostPushVerification retries stale absence after successful push and fails closed on mismatch', () => {
  assert.equal(
    planPostPushVerification({
      classification: { status: 'absent', remoteSha: null },
      pushSucceeded: true,
      attempt: 1,
      maxAttempts: 5
    }).action,
    'retry'
  );
  assert.equal(
    planPostPushVerification({
      classification: { status: 'match', remoteSha: expected },
      pushSucceeded: true,
      attempt: 2,
      maxAttempts: 5
    }).action,
    'success'
  );
  assert.deepEqual(
    planPostPushVerification({
      classification: {
        status: 'mismatch',
        remoteSha: other,
        detail: 'remote tag object does not match the verified distribution receipt'
      },
      pushSucceeded: true,
      attempt: 1,
      maxAttempts: 5
    }),
    {
      action: 'fail_mismatch',
      reason: 'Published tag object does not match the verified distribution receipt.'
    }
  );
});

test('ensureRemoteTagMatches: stale-read-then-match after successful push passes', async () => {
  const reads = [];
  const sleeps = [];
  let pushed = 0;

  const result = await ensureRemoteTagMatches({
    expectedTagObject: expected,
    postPushBackoffMs: [1, 1, 1],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    lookup: async () => {
      reads.push('lookup');
      // 1: pre-push absence, 2: stale 404 after push, 3: match
      if (reads.length === 1 || reads.length === 2) {
        return { exitCode: 1, stdout: notFoundBody };
      }
      return { exitCode: 0, stdout: expected, objectType: 'tag' };
    },
    push: async () => {
      pushed += 1;
      return { exitCode: 0, stdout: '*\trefs/tags/v0.5.0-rc.4:refs/tags/v0.5.0-rc.4\t[new tag]\nDone\n' };
    }
  });

  assert.equal(pushed, 1);
  assert.equal(result.outcome, 'pushed');
  assert.equal(result.remoteSha, expected);
  assert.equal(result.pushed, true);
  assert.ok(reads.length >= 3);
  assert.ok(sleeps.length >= 1);
});

test('ensureRemoteTagMatches: genuine post-push mismatch fails closed without retrying into success', async () => {
  let lookups = 0;
  await assert.rejects(
    ensureRemoteTagMatches({
      expectedTagObject: expected,
      postPushBackoffMs: [1, 1, 1],
      sleep: async () => {},
      lookup: async () => {
        lookups += 1;
        if (lookups === 1) return { exitCode: 1, stdout: notFoundBody };
        return { exitCode: 0, stdout: other, objectType: 'tag' };
      },
      push: async () => ({ exitCode: 0, stdout: 'Done\n' })
    }),
    /Published tag object does not match the verified distribution receipt/
  );
  // Pre-push lookup + one post-push mismatch (no backoff retries on mismatch).
  assert.equal(lookups, 2);
});

test('ensureRemoteTagMatches: already-present-and-matching is idempotent and does not push', async () => {
  let pushed = 0;
  const result = await ensureRemoteTagMatches({
    expectedTagObject: expected,
    sleep: async () => {},
    lookup: async () => ({ exitCode: 0, stdout: expected, objectType: 'tag' }),
    push: async () => {
      pushed += 1;
      return { exitCode: 0, stdout: 'should-not-run\n' };
    }
  });
  assert.equal(pushed, 0);
  assert.equal(result.outcome, 'already_present');
  assert.equal(result.pushed, false);
  assert.equal(result.remoteSha, expected);
});

test('ensureRemoteTagMatches: pre-existing conflicting tag aborts before push', async () => {
  let pushed = 0;
  await assert.rejects(
    ensureRemoteTagMatches({
      expectedTagObject: expected,
      sleep: async () => {},
      lookup: async () => ({ exitCode: 0, stdout: other, objectType: 'tag' }),
      push: async () => {
        pushed += 1;
        return { exitCode: 0, stdout: 'Done\n' };
      }
    }),
    /already exists with a different object/
  );
  assert.equal(pushed, 0);
});

test('release workflow verifies receipt, attestations, and local bundle before tag mutation', async () => {
  const workflow = await readFile(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const publishStart = workflow.indexOf('  publish:\n');
  assert.ok(publishStart > -1);
  const publishJob = workflow.slice(publishStart);

  const receiptCheck = publishJob.indexOf('distribution receipt has an unexpected schema');
  const attestation = publishJob.indexOf('verify_attestation');
  const localBundle = publishJob.indexOf('downloaded distribution bundle does not match its verified receipt');
  const ensureInvoke = publishJob.indexOf('node scripts/ensure-release-tag.mjs');
  const releaseCreate = publishJob.indexOf('gh release create');

  assert.ok(receiptCheck > -1, 'receipt schema check present');
  assert.ok(attestation > receiptCheck, 'attestation after receipt check');
  assert.ok(localBundle > attestation, 'local bundle verify after attestation');
  assert.ok(ensureInvoke > localBundle, 'tag ensure after local verification');
  assert.ok(releaseCreate > ensureInvoke, 'GitHub Release only after tag ensure');

  // Tag mutation is owned by the tested ensure helper; no inline git push of tags.
  assert.doesNotMatch(publishJob, /git -C "\$repository" push --porcelain origin "\$tag_ref:\$tag_ref"/);
  assert.match(publishJob, /^\s+node scripts\/ensure-release-tag\.mjs \\$/mu);
  assert.match(publishJob, /--expected-tag-object "\$expected_tag_object"/);

  // Workflow still requires the owner-only authorize job before reusable validation.
  assert.match(workflow, /needs: authorize/);
});

test('ensure-release-tag helper is path-stable for the workflow', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'ensure-release-tag.mjs'), 'utf8');
  assert.match(source, /ensureRemoteTagMatches/);
  assert.match(source, /Never force-pushes or deletes/);
});
