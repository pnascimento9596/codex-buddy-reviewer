import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareReviewRequest } from '../src/cli.mjs';
import { collectEvidence } from '../src/evidence.mjs';
import {
  createPrivacyCoverage,
  createPrivacyCoverageIndex,
  matchPrivacyCandidate,
  PRIVACY_LIMITS,
  privacyCoverageIsCurrentComplete
} from '../src/privacy-inventory.mjs';
import {
  createPrivacyFragmentSalt,
  privacyFragmentFingerprints
} from '../src/privacy-fragments.mjs';
import { runProcess } from '../src/process.mjs';
import { buildTurnEvidence, captureTurnSnapshot } from '../src/turn-snapshot.mjs';

const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function git(root, args) {
  return runProcess('git', args, { cwd: root });
}

async function makeRepository() {
  const root = await temporaryDirectory('buddy-privacy-kernel-');
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Buddy Test']);
  await git(root, ['config', 'user.email', 'buddy@example.invalid']);
  await writeFile(path.join(root, 'app.js'), 'export const baseline = true;\n');
  await git(root, ['add', 'app.js']);
  await git(root, ['commit', '-q', '-m', 'baseline']);
  return root;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture(kind) {
  const marker = kind === 'wrapped'
    ? 'SYNTHETIC_DENIED_WRAP_KERNEL_MARKER'
    : 'SYNTHETIC_DENIED_EXCERPT_KERNEL_MARKER';
  if (kind === 'wrapped') {
    const denied = Array.from(
      { length: 8 },
      (_, index) => `private_${index}=${marker}_${index}_${'q'.repeat(8)}`
    ).join('\n');
    return {
      denied,
      candidate: `${'export const prefix = true;\n'.repeat(20)}${denied}\n${'export const suffix = true;\n'.repeat(20)}`,
      marker
    };
  }
  const excerpt = `${marker}_${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(3)}`.slice(0, 96);
  const denied = `${'private-prefix-'.repeat(28)}${excerpt}${'private-suffix-'.repeat(28)}`;
  return { denied, candidate: excerpt, marker };
}

function assertWithheld(evidence, marker, candidatePath) {
  assert.equal(evidence.changed_paths.includes(candidatePath), false);
  assert.equal(evidence.excluded_paths.some((item) => item.path === candidatePath), true);
  assert.doesNotMatch(evidence.patch, new RegExp(marker));
  assert.doesNotMatch(prepareReviewRequest(evidence, { summaryGuardPacket: null }).prompt, new RegExp(marker));
}

test('current complete coverage gate validates metadata without private salt access', () => {
  const salt = createPrivacyFragmentSalt();
  const coverage = createPrivacyCoverage({
    salt,
    scope: 'turn_evidence',
    requiredSourceClasses: ['denied_tree'],
    completedSourceClasses: ['denied_tree']
  });
  assert.equal(privacyCoverageIsCurrentComplete(coverage, 'turn_evidence'), true);
  assert.equal(privacyCoverageIsCurrentComplete(coverage, 'manual_working'), false);
  assert.equal(privacyCoverageIsCurrentComplete({ ...coverage, status: 'incomplete' }), false);
  assert.equal(privacyCoverageIsCurrentComplete({
    ...coverage,
    counters: {
      ...coverage.counters,
      window_fingerprints: PRIVACY_LIMITS.maxWindowFingerprints + 1
    }
  }), false);
  assert.equal(privacyCoverageIsCurrentComplete({ ...coverage, unexpected: true }), false);
});

test('typed privacy index detects wrapped sources and long-source excerpts', () => {
  for (const kind of ['wrapped', 'excerpt']) {
    const { denied, candidate } = fixture(kind);
    const salt = createPrivacyFragmentSalt();
    const source = privacyFragmentFingerprints(Buffer.from(denied), salt);
    const coverage = createPrivacyCoverage({
      salt,
      scope: 'test',
      requiredSourceClasses: ['denied_tree'],
      completedSourceClasses: ['denied_tree'],
      counters: {
        sources: 1,
        source_bytes: Buffer.byteLength(denied),
        source_window_work: source.shortFingerprints.length,
        exact_fingerprints: 1,
        fragment_fingerprints: source.fingerprints.length,
        window_fingerprints: source.shortFingerprints.length
      }
    });
    const index = createPrivacyCoverageIndex({
      salt,
      exactFingerprints: [sha256(Buffer.from(denied))],
      fragmentFingerprints: source.fingerprints,
      windowFingerprints: source.shortFingerprints,
      coverage
    });
    assert.deepEqual(matchPrivacyCandidate(Buffer.from(candidate), index), {
      status: 'match',
      relation: 'normalized_window_32'
    });
    assert.deepEqual(matchPrivacyCandidate(Buffer.from('export const unrelated = true;'), index), {
      status: 'no_match',
      relation: null
    });
  }
});

for (const kind of ['wrapped', 'excerpt']) {
  test(`manual working-tree privacy kernel blocks ${kind} denied content`, async () => {
    const root = await makeRepository();
    const { denied, candidate, marker } = fixture(kind);
    await writeFile(path.join(root, '.env'), denied);
    await writeFile(path.join(root, 'candidate.txt'), candidate);
    const evidence = await collectEvidence({ cwd: root });
    assertWithheld(evidence, marker, 'candidate.txt');
    assert.equal(evidence.privacy_coverage.status, 'complete');
  });

  test(`manual branch privacy kernel blocks ${kind} denied content`, async () => {
    const root = await makeRepository();
    const { denied, candidate, marker } = fixture(kind);
    await writeFile(path.join(root, '.env'), denied);
    await git(root, ['add', '-f', '.env']);
    await git(root, ['commit', '-q', '-m', 'denied baseline']);
    const base = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(path.join(root, 'candidate.txt'), candidate);
    await git(root, ['add', 'candidate.txt']);
    await git(root, ['commit', '-q', '-m', 'candidate']);
    const evidence = await collectEvidence({ cwd: root, scope: 'branch', base });
    assertWithheld(evidence, marker, 'candidate.txt');
    assert.equal(evidence.privacy_coverage.status, 'complete');
  });

  test(`automatic privacy kernel blocks ${kind} denied content`, async () => {
    const root = await makeRepository();
    const snapshotDir = await temporaryDirectory('buddy-privacy-snapshot-');
    const { denied, candidate, marker } = fixture(kind);
    await writeFile(path.join(root, '.env'), denied);
    const baseline = await captureTurnSnapshot({ root, workDir: snapshotDir });
    await writeFile(path.join(root, 'candidate.txt'), candidate);
    const final = await captureTurnSnapshot({
      root,
      workDir: snapshotDir,
      privacySalt: baseline.privacy_fragment_salt
    });
    const evidence = await buildTurnEvidence({ baseline, final, sessionId: 's', turnId: kind });
    assertWithheld(evidence, marker, 'candidate.txt');
    assert.equal(evidence.privacy_coverage.status, 'complete');
  });
}

for (const scope of ['working', 'branch', 'automatic']) {
  test(`${scope} privacy inventory blocks exact live Git config copies`, async () => {
    const root = await makeRepository();
    const marker = `private-live-git-${scope}.example.invalid`;
    await git(root, ['remote', 'add', 'origin', `https://${marker}/private/repository.git`]);
    const source = path.join(root, '.git', 'config');
    if (scope === 'working') {
      await copyFile(source, path.join(root, 'git-copy.txt'));
      const evidence = await collectEvidence({ cwd: root });
      assertWithheld(evidence, marker, 'git-copy.txt');
      return;
    }
    if (scope === 'branch') {
      const base = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
      await copyFile(source, path.join(root, 'git-copy.txt'));
      await git(root, ['add', 'git-copy.txt']);
      await git(root, ['commit', '-q', '-m', 'copy live metadata']);
      const evidence = await collectEvidence({ cwd: root, scope: 'branch', base });
      assertWithheld(evidence, marker, 'git-copy.txt');
      return;
    }
    const snapshotDir = await temporaryDirectory('buddy-live-git-snapshot-');
    const baseline = await captureTurnSnapshot({ root, workDir: snapshotDir });
    await copyFile(source, path.join(root, 'git-copy.txt'));
    const final = await captureTurnSnapshot({
      root,
      workDir: snapshotDir,
      privacySalt: baseline.privacy_fragment_salt
    });
    const evidence = await buildTurnEvidence({ baseline, final, sessionId: 's', turnId: scope });
    assertWithheld(evidence, marker, 'git-copy.txt');
  });
}

test('automatic snapshots bind current privacy and path-encoding generations', async () => {
  const root = await makeRepository();
  const snapshotDir = await temporaryDirectory('buddy-generation-snapshot-');
  const baseline = await captureTurnSnapshot({ root, workDir: snapshotDir });
  await writeFile(path.join(root, 'new.js'), 'export const newValue = true;\n');
  const final = await captureTurnSnapshot({
    root,
    workDir: snapshotDir,
    privacySalt: baseline.privacy_fragment_salt
  });
  const incompatible = structuredClone(baseline);
  delete incompatible.path_encoding;
  const evidence = await buildTurnEvidence({
    baseline: incompatible,
    final,
    sessionId: 's',
    turnId: 'old-generation'
  });
  assert.equal(evidence.privacy_coverage.status, 'incomplete');
  assert.equal(evidence.privacy_coverage.incomplete_reason, 'snapshot_incompatible');
  assert.equal(evidence.patch, '');
  assert.equal(evidence.path_evidence.some((item) => item.transmitted), false);
});
