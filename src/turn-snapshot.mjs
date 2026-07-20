import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { CaptureBudget } from './capture-budget.mjs';
import { applyPatchBudget } from './patch-evidence.mjs';
import { isProbablyText, pathPolicy, SENSITIVE_IGNORED_PATHSPECS } from './policy.mjs';
import {
  classifyPaths as classifyRepoPaths,
  decodeSymlinkTarget,
  excludedRenameDestinations,
  literalPathspec,
  parseGitIndexEntries,
  parseGitTreeEntry,
  runGit,
  splitNull,
  symlinkTargetIsDenied,
  workingInventory
} from './git-privacy-kernel.mjs';
import {
  createPrivacyCoverage,
  createPrivacyCoverageIndex,
  matchPrivacyCandidate,
  privacyCoverageIsCompatible,
  PRIVACY_LIMITS
} from './privacy-inventory.mjs';
import { captureLiveGitPrivacySources } from './privacy-source-registry.mjs';
import {
  createPrivacyFragmentSalt,
  mergePrivacyFragmentFingerprints,
  mergePrivacyShortFingerprints,
  privacyFragmentFingerprints
} from './privacy-fragments.mjs';
import { scanSecretMaterial } from './secret-scan.mjs';

const DEFAULT_MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_IGNORED_INVENTORY_PATHS = 50_000;
const MAX_IGNORED_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_IGNORED_FILE_BYTES = 1024 * 1024;
const PATH_ENCODING = 'utf8-strict-v1';
const TURN_SNAPSHOT_PRIVACY_SOURCE_CLASSES = Object.freeze([
  'denied_ignored_high_risk',
  'denied_index',
  'denied_worktree',
  'git_common_config',
  'git_worktree_config'
]);
const captureBudgetContext = new AsyncLocalStorage();

function activeBudget() {
  return captureBudgetContext.getStore() ?? null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function rawPrivacyFingerprint(value) {
  if (typeof value !== 'string') return null;
  const typed = value.match(/^(?:file|symlink):([0-9a-f]{64})$/);
  if (typed) return typed[1];
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    activeBudget()?.chargeFileBytes(chunk.length);
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function git(root, args, options = {}) {
  return runGit(root, args, { ...options, budget: activeBudget() });
}

async function resolveHead(root) {
  const result = await git(root, ['rev-parse', '--verify', 'HEAD'], { acceptedExitCodes: [0, 128] });
  return result.stdout.trim() || 'UNBORN';
}

async function repositoryObjectDirectory(root) {
  const result = await git(root, ['rev-parse', '--git-path', 'objects']);
  return path.resolve(root, result.stdout.trim());
}

function classifyPaths(inventory) {
  return classifyRepoPaths(inventory.allPaths, inventory.forcedExcluded);
}

async function stageWorkingPath(root, repoPath, env, maxFileBytes) {
  const absolute = path.join(root, repoPath);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await git(root, ['update-index', '--force-remove', '--', repoPath], { env });
    return { disposition: 'complete', contentHash: null, lineCount: null };
  }

  let content;
  let mode;
  if (stat.isSymbolicLink()) {
    content = await readlink(absolute, { encoding: 'buffer' });
    activeBudget()?.chargeFileBytes(content.length);
    mode = '120000';
  } else if (stat.isFile()) {
    if (stat.size > maxFileBytes) {
      return { disposition: 'size_omitted', contentHash: `sha256:${await sha256File(absolute)}`, lineCount: null };
    }
    content = await readFile(absolute);
    activeBudget()?.chargeFileBytes(content.length);
    mode = stat.mode & 0o111 ? '100755' : '100644';
  } else {
    return { disposition: 'non_file_omitted', contentHash: null, lineCount: null };
  }

  activeBudget()?.chargeObjectBytes(content.length);
  const object = await git(root, ['hash-object', '--no-filters', '-w', '--stdin'], {
    env,
    input: content,
    maxOutputBytes: 1024 * 1024
  });
  const objectId = object.stdout.trim();
  await git(root, ['update-index', '--add', '--cacheinfo', `${mode},${objectId},${repoPath}`], { env });
  const lineCount = stat.isFile() && isProbablyText(content)
    ? content.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0) + (content.length && content.at(-1) !== 10 ? 1 : 0)
    : null;
  return { disposition: 'complete', contentHash: `git-object:${objectId}`, lineCount };
}

async function fingerprintExcludedPath(root, repoPath) {
  const absolute = path.join(root, repoPath);
  try {
    const details = await lstat(absolute);
    if (details.isSymbolicLink()) {
      const target = await readlink(absolute, { encoding: 'buffer' });
      activeBudget()?.chargeFileBytes(target.length);
      return `symlink:${sha256(target)}`;
    }
    if (details.isFile()) return `file:${await sha256File(absolute)}`;
    return `non-file:${details.mode}:${details.size}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function fragmentFingerprintExcludedPath(root, repoPath, privacySalt) {
  const absolute = path.join(root, repoPath);
  try {
    const details = await lstat(absolute);
    if (!details.isFile()) return { complete: true, fingerprints: [], shortFingerprints: [] };
    if (details.size > 1024 * 1024) {
      return { complete: false, fingerprints: [], shortFingerprints: [] };
    }
    const content = await readFile(absolute);
    activeBudget()?.chargeFileBytes(content.length);
    return privacyFragmentFingerprints(content, privacySalt);
  } catch (error) {
    if (error.code === 'ENOENT') return { complete: true, fingerprints: [], shortFingerprints: [] };
    throw error;
  }
}

function incompleteSensitiveFingerprintInventory(privacySalt, reason, counters = {}) {
  return {
    exact: {},
    fragments: [],
    shortFragments: [],
    fragmentsComplete: false,
    coverage: createPrivacyCoverage({
      salt: privacySalt,
      scope: 'turn_snapshot',
      status: 'incomplete',
      incompleteReason: reason,
      requiredSourceClasses: TURN_SNAPSHOT_PRIVACY_SOURCE_CLASSES,
      completedSourceClasses: [],
      counters
    })
  };
}

async function sensitiveFingerprintInventory(root, privacySalt, observedExcludedPaths = []) {
  const [tracked, ignored, index] = await Promise.all([
    git(root, ['ls-files', '-z'], { maxOutputBytes: MAX_GIT_OUTPUT_BYTES, encoding: null }),
    git(root, [
      'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--',
      ...SENSITIVE_IGNORED_PATHSPECS
    ], { maxOutputBytes: MAX_GIT_OUTPUT_BYTES, encoding: null }),
    git(root, ['ls-files', '--stage', '-z'], { maxOutputBytes: MAX_GIT_OUTPUT_BYTES, encoding: null })
  ]);
  const candidates = [...new Set([
    ...splitNull(tracked.stdout),
    ...splitNull(ignored.stdout),
    ...observedExcludedPaths
  ])].filter((repoPath) => !pathPolicy(repoPath).allowed).sort();
  activeBudget()?.chargePaths(candidates.length);
  const deniedIndexEntries = parseGitIndexEntries(index.stdout).filter((entry) => (
    !pathPolicy(entry.path).allowed && ['100644', '100755', '120000'].includes(entry.mode)
  ));
  const sourceCount = candidates.length + deniedIndexEntries.length
    + TURN_SNAPSHOT_PRIVACY_SOURCE_CLASSES.filter((value) => value.startsWith('git_')).length;
  if (sourceCount > PRIVACY_LIMITS.maxSources) {
    return incompleteSensitiveFingerprintInventory(privacySalt, 'source_count_exceeded', {
      sources: sourceCount
    });
  }
  const fingerprints = {};
  const fragmentFingerprints = new Set();
  const shortFragmentFingerprints = new Set();
  let fragmentsComplete = true;
  for (const repoPath of candidates) {
    fingerprints[repoPath] = await fingerprintExcludedPath(root, repoPath);
    const fragments = await fragmentFingerprintExcludedPath(root, repoPath, privacySalt);
    fragmentsComplete &&= fragments.complete;
    fragmentsComplete &&= mergePrivacyFragmentFingerprints(fragmentFingerprints, fragments.fingerprints);
    fragmentsComplete &&= mergePrivacyShortFingerprints(
      shortFragmentFingerprints,
      fragments.shortFingerprints
    );
  }
  for (const entry of deniedIndexEntries) {
    const { mode, objectId, stage, path: repoPath } = entry;
    const blob = await git(root, ['cat-file', 'blob', objectId], {
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      encoding: null
    });
    fingerprints[`index:${stage}:${objectId}`] = mode === '120000'
      ? `symlink:${sha256(blob.stdout)}`
      : `file:${sha256(blob.stdout)}`;
    if (mode !== '120000') {
      const fragments = privacyFragmentFingerprints(blob.stdout, privacySalt);
      fragmentsComplete &&= fragments.complete;
      fragmentsComplete &&= mergePrivacyFragmentFingerprints(fragmentFingerprints, fragments.fingerprints);
      fragmentsComplete &&= mergePrivacyShortFingerprints(
        shortFragmentFingerprints,
        fragments.shortFingerprints
      );
    }
  }
  const liveValues = await captureLiveGitPrivacySources({
    root,
    privacySalt,
    budget: activeBudget(),
    scope: 'turn_snapshot'
  });
  Object.assign(fingerprints, liveValues.observations);
  fragmentsComplete &&= liveValues.complete;
  fragmentsComplete &&= mergePrivacyFragmentFingerprints(
    fragmentFingerprints,
    liveValues.fragments
  );
  fragmentsComplete &&= mergePrivacyShortFingerprints(
    shortFragmentFingerprints,
    liveValues.windows
  );
  const sortedFragments = [...fragmentFingerprints].sort();
  const sortedShortFragments = [...shortFragmentFingerprints].sort();
  const exactFingerprintCount = Object.values(fingerprints)
    .filter((value) => rawPrivacyFingerprint(value) !== null).length;
  const serializedInventoryBytes = Buffer.byteLength(JSON.stringify({
    exact: fingerprints,
    fragments: sortedFragments,
    shortFragments: sortedShortFragments
  }), 'utf8');
  if (serializedInventoryBytes > PRIVACY_LIMITS.maxSerializedInventoryBytes) {
    return incompleteSensitiveFingerprintInventory(privacySalt, 'serialization_limit_exceeded', {
      sources: exactFingerprintCount,
      source_bytes: liveValues.coverage.counters.source_bytes,
      source_window_work: shortFragmentFingerprints.size,
      exact_fingerprints: exactFingerprintCount,
      fragment_fingerprints: fragmentFingerprints.size,
      window_fingerprints: shortFragmentFingerprints.size
    });
  }
  const coverage = createPrivacyCoverage({
    salt: privacySalt,
    scope: 'turn_snapshot',
    status: fragmentsComplete ? 'complete' : 'incomplete',
    incompleteReason: fragmentsComplete
      ? null
      : (liveValues.coverage.incomplete_reason ?? 'index_capacity_exceeded'),
    requiredSourceClasses: TURN_SNAPSHOT_PRIVACY_SOURCE_CLASSES,
    completedSourceClasses: fragmentsComplete ? TURN_SNAPSHOT_PRIVACY_SOURCE_CLASSES : [],
    counters: {
      sources: exactFingerprintCount,
      source_bytes: liveValues.coverage.counters.source_bytes,
      source_window_work: shortFragmentFingerprints.size,
      exact_fingerprints: exactFingerprintCount,
      fragment_fingerprints: fragmentFingerprints.size,
      window_fingerprints: shortFragmentFingerprints.size
    }
  });
  return {
    exact: fingerprints,
    fragments: sortedFragments,
    shortFragments: sortedShortFragments,
    fragmentsComplete,
    coverage
  };
}

async function ignoredReviewableInventory(root) {
  let raw;
  try {
    raw = await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], {
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      encoding: null
    });
  } catch (error) {
    if (/exceeded .* bytes/.test(error.message)) {
      return { complete: false, fingerprint: sha256('ignored-inventory-output-limit') };
    }
    throw error;
  }
  const paths = splitNull(raw.stdout).filter((repoPath) => pathPolicy(repoPath).allowed).sort();
  activeBudget()?.chargePaths(paths.length);
  if (paths.length > MAX_IGNORED_INVENTORY_PATHS) {
    return { complete: false, fingerprint: sha256(`ignored-inventory-path-limit:${paths.length}`) };
  }
  const aggregate = createHash('sha256');
  let contentBudget = MAX_IGNORED_CONTENT_BYTES;
  for (const repoPath of paths) {
    const absolute = path.join(root, repoPath);
    let details;
    try {
      details = await lstat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') {
        aggregate.update(`${repoPath}\0missing\0`);
        continue;
      }
      throw error;
    }
    aggregate.update(`${repoPath}\0${details.mode}\0${details.size}\0${details.mtimeMs}\0${details.ctimeMs}\0`);
    if (details.isSymbolicLink()) {
      const target = await readlink(absolute, { encoding: 'buffer' });
      activeBudget()?.chargeFileBytes(target.length);
      aggregate.update(sha256(target));
    } else if (details.isFile() && details.size <= MAX_IGNORED_FILE_BYTES && details.size <= contentBudget) {
      const content = await readFile(absolute);
      activeBudget()?.chargeFileBytes(content.length);
      aggregate.update(content);
      contentBudget -= details.size;
    }
    aggregate.update('\0');
  }
  return { complete: true, fingerprint: aggregate.digest('hex') };
}

function snapshotSignature(snapshot) {
  return sha256(JSON.stringify({
    head: snapshot.head,
    tree: snapshot.tree,
    all_paths: snapshot.all_paths,
    excluded_paths: snapshot.excluded_paths,
    incomplete_paths: snapshot.incomplete_paths,
    content_hashes: snapshot.content_hashes,
    excluded_fingerprints: snapshot.excluded_fingerprints,
    sensitive_fingerprints: snapshot.sensitive_fingerprints,
    privacy_fragment_salt: snapshot.privacy_fragment_salt,
    sensitive_fragment_fingerprints: snapshot.sensitive_fragment_fingerprints,
    sensitive_short_fragment_fingerprints: snapshot.sensitive_short_fragment_fingerprints,
    sensitive_fragment_complete: snapshot.sensitive_fragment_complete,
    privacy_coverage: snapshot.privacy_coverage,
    path_encoding: snapshot.path_encoding,
    ignored_reviewable_complete: snapshot.ignored_reviewable_complete,
    ignored_reviewable_fingerprint: snapshot.ignored_reviewable_fingerprint,
    line_counts: snapshot.line_counts,
    status_hash: snapshot.status_hash
  }));
}

async function captureOnce({ root, objectDir, workDir, maxFileBytes, privacySalt }) {
  const indexFile = path.join(workDir, `index-${randomUUID()}`);
  const originalObjects = await repositoryObjectDirectory(root);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_OBJECT_DIRECTORY: objectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: originalObjects
  };
  const statusBefore = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: null
  });
  const head = await resolveHead(root);
  const inventory = await workingInventory(root, { budget: activeBudget() });
  activeBudget()?.chargePaths(inventory.allPaths.length);
  const { allowed, excluded } = classifyPaths(inventory);
  const incomplete = {};
  const contentHashes = {};
  const lineCounts = {};
  const excludedFingerprints = {};
  const sensitiveInventory = await sensitiveFingerprintInventory(
    root,
    privacySalt,
    excluded.map((item) => item.path)
  );
  const ignoredReviewable = await ignoredReviewableInventory(root);

  try {
    if (head === 'UNBORN') await git(root, ['read-tree', '--empty'], { env });
    else await git(root, ['read-tree', head], { env });
    for (const repoPath of allowed) {
      const staged = await stageWorkingPath(root, repoPath, env, maxFileBytes);
      contentHashes[repoPath] = staged.contentHash;
      lineCounts[repoPath] = staged.lineCount;
      if (inventory.staged.has(repoPath)
        && (inventory.unstaged.has(repoPath) || inventory.untracked.has(repoPath))) {
        incomplete[repoPath] = 'index_worktree_diverged';
      } else if (staged.disposition !== 'complete') incomplete[repoPath] = staged.disposition;
    }
    for (const item of excluded) excludedFingerprints[item.path] = await fingerprintExcludedPath(root, item.path);
    const tree = (await git(root, ['write-tree'], { env })).stdout.trim();
    const statusAfter = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      encoding: null
    });
    const endingHead = await resolveHead(root);
    if (head !== endingHead || !statusBefore.stdout.equals(statusAfter.stdout)) {
      throw new Error('turn snapshot changed during capture; retry');
    }
    return {
      schema_version: '1',
      captured_at: new Date().toISOString(),
      repository_root: root,
      head,
      tree,
      object_directory: objectDir,
      all_paths: inventory.allPaths,
      excluded_paths: excluded,
      incomplete_paths: incomplete,
      content_hashes: contentHashes,
      excluded_fingerprints: excludedFingerprints,
      sensitive_fingerprints: sensitiveInventory.exact,
      privacy_fragment_salt: privacySalt,
      sensitive_fragment_fingerprints: sensitiveInventory.fragments,
      sensitive_short_fragment_fingerprints: sensitiveInventory.shortFragments,
      sensitive_fragment_complete: sensitiveInventory.fragmentsComplete,
      privacy_coverage: sensitiveInventory.coverage,
      path_encoding: PATH_ENCODING,
      ignored_reviewable_complete: ignoredReviewable.complete,
      ignored_reviewable_fingerprint: ignoredReviewable.fingerprint,
      line_counts: lineCounts,
      status_hash: sha256(statusAfter.stdout)
    };
  } finally {
    await rm(indexFile, { force: true });
  }
}

async function captureTurnSnapshotWithinBudget(options) {
  const root = options.root;
  const workDir = options.workDir;
  const objectDir = path.join(workDir, 'objects');
  const workDirExisted = await lstat(workDir).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  try {
    await mkdir(objectDir, { recursive: true, mode: 0o700 });
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const captureOptions = {
      root,
      objectDir,
      workDir,
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_SNAPSHOT_FILE_BYTES,
      privacySalt: options.privacySalt ?? createPrivacyFragmentSalt()
    };
    const first = await captureOnce(captureOptions);
    if (options.afterFirstCapture) await options.afterFirstCapture();
    const second = await captureOnce(captureOptions);
    if (snapshotSignature(first) !== snapshotSignature(second)) {
      throw new Error('turn snapshot changed during capture; retry');
    }
    return second;
  } catch (error) {
    if (!workDirExisted) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function captureTurnSnapshot(options) {
  const budget = options.budget ?? new CaptureBudget(options.budgetOptions);
  return captureBudgetContext.run(budget, () => captureTurnSnapshotWithinBudget(options));
}

async function treePathFingerprint(
  root,
  tree,
  repoPath,
  env,
  disposition,
  privacySalt = null,
  privacyInventory = null
) {
  const entry = await git(root, ['ls-tree', '-z', tree, '--', literalPathspec(repoPath)], {
    env,
    encoding: null
  });
  const parsedTreeEntry = parseGitTreeEntry(entry.stdout, repoPath);
  if (!parsedTreeEntry) return { hash: null, lineCount: null, privacyFingerprint: null };
  const { mode, objectId } = parsedTreeEntry;
  if (mode === '120000' && disposition === 'complete') {
    const blob = await git(root, ['cat-file', 'blob', objectId], {
      env,
      maxOutputBytes: 1024 * 1024,
      encoding: null
    });
    const targetBytes = blob.stdout;
    return {
      hash: `git-object:${objectId}`,
      lineCount: null,
      privacyFingerprint: sha256(targetBytes),
      symlinkTarget: decodeSymlinkTarget(targetBytes)
    };
  }
  if (!['100644', '100755'].includes(mode) || disposition !== 'complete') {
    return { hash: `git-object:${objectId}`, lineCount: null, privacyFingerprint: null };
  }
  const blob = await git(root, ['cat-file', 'blob', objectId], {
    env,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    encoding: null
  });
  const content = blob.stdout;
  const secretScan = scanSecretMaterial(content);
  const privacyFingerprint = sha256(content);
  if (!isProbablyText(content)) {
    return {
      hash: `git-object:${objectId}`, lineCount: null, privacyFingerprint,
      privacyFragments: [], privacyShortFragments: [], privacyFragmentMatch: false,
      privacyFragmentsComplete: true,
      secretDetected: secretScan.detected,
      secretScanComplete: secretScan.complete
    };
  }
  const fragments = privacySalt
    ? privacyFragmentFingerprints(content, privacySalt)
    : { complete: true, fingerprints: [], shortFingerprints: [] };
  const matchResult = privacySalt && privacyInventory
    ? (privacyInventory.index
        ? matchPrivacyCandidate(content, privacyInventory.index)
        : { status: 'incomplete', reason: 'registry_incomplete' })
    : { status: 'no_match', relation: null };
  let lineCount = content.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
  if (content.length && content.at(-1) !== 10) lineCount += 1;
  return {
    hash: `git-object:${objectId}`,
    lineCount,
    privacyFingerprint,
    privacyFragments: fragments.fingerprints,
    privacyShortFragments: fragments.shortFingerprints,
    privacyFragmentMatch: matchResult.status === 'match',
    privacyFragmentsComplete: fragments.complete && matchResult.status !== 'incomplete',
    secretDetected: secretScan.detected,
    secretScanComplete: secretScan.complete
  };
}

function dispositionForPatch(patchText, fingerprint) {
  if (/^Binary files .* differ$/m.test(patchText)) return 'binary_omitted';
  if (fingerprint.hash === null) return 'complete';
  if (fingerprint.lineCount === null) return 'non_file_omitted';
  return 'complete';
}

function mergeExcluded(baseline, final, allPaths, forcedExcluded) {
  const prior = new Map([
    ...baseline.excluded_paths.map((item) => [item.path, item.reason]),
    ...final.excluded_paths.map((item) => [item.path, item.reason])
  ]);
  const excluded = [];
  const allowed = [];
  for (const repoPath of allPaths) {
    const policy = pathPolicy(repoPath);
    const reason = forcedExcluded.has(repoPath)
      ? 'renamed from denied path'
      : prior.get(repoPath) ?? (policy.allowed ? null : policy.reason);
    if (reason) excluded.push({ path: repoPath, reason });
    else allowed.push(repoPath);
  }
  return { allowed, excluded };
}

async function sensitiveTreeFingerprints(root, trees, env, privacySalt) {
  const fingerprints = new Set();
  const fragmentFingerprints = new Set();
  const shortFragmentFingerprints = new Set();
  let fragmentsComplete = true;
  for (const tree of trees) {
    const listing = await git(root, ['ls-tree', '-r', '--name-only', '-z', tree], {
      env,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      encoding: null
    });
    for (const repoPath of splitNull(listing.stdout).filter((candidate) => !pathPolicy(candidate).allowed)) {
      const fingerprint = await treePathFingerprint(root, tree, repoPath, env, 'complete', privacySalt);
      if (fingerprint.privacyFingerprint) fingerprints.add(fingerprint.privacyFingerprint);
      fragmentsComplete &&= fingerprint.privacyFragmentsComplete !== false;
      fragmentsComplete &&= mergePrivacyFragmentFingerprints(
        fragmentFingerprints,
        fingerprint.privacyFragments
      );
      fragmentsComplete &&= mergePrivacyShortFingerprints(
        shortFragmentFingerprints,
        fingerprint.privacyShortFragments
      );
    }
  }
  return { fingerprints, fragmentFingerprints, shortFragmentFingerprints, fragmentsComplete };
}

async function buildTurnEvidenceWithinBudget({ baseline, final, sessionId, turnId, maxPatchBytes = 256 * 1024 }) {
  if (baseline.repository_root !== final.repository_root) throw new Error('turn snapshots belong to different repositories');
  if (baseline.object_directory !== final.object_directory) throw new Error('turn snapshots use different object stores');
  const root = final.repository_root;
  const privacySalt = baseline.privacy_fragment_salt ?? final.privacy_fragment_salt ?? null;
  if (baseline.privacy_fragment_salt && final.privacy_fragment_salt
    && baseline.privacy_fragment_salt !== final.privacy_fragment_salt) {
    throw new Error('turn snapshots use different privacy fragment salts');
  }
  const snapshotCoverageCompatible = Boolean(privacySalt
    && baseline.path_encoding === PATH_ENCODING
    && final.path_encoding === PATH_ENCODING
    && privacyCoverageIsCompatible(baseline.privacy_coverage, privacySalt, 'turn_snapshot')
    && privacyCoverageIsCompatible(final.privacy_coverage, privacySalt, 'turn_snapshot'));
  const originalObjects = await repositoryObjectDirectory(root);
  const env = {
    ...process.env,
    GIT_OBJECT_DIRECTORY: final.object_directory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: originalObjects
  };
  const names = await git(root, [
    'diff', '--name-only', '--no-renames', '-z', baseline.tree, final.tree
  ], { env, maxOutputBytes: MAX_GIT_OUTPUT_BYTES, encoding: null });
  const renameStatus = await git(root, [
    'diff', '--name-status', '--find-renames', '--find-copies-harder', '-z', baseline.tree, final.tree
  ], { env, maxOutputBytes: MAX_GIT_OUTPUT_BYTES, encoding: null });
  const observedFingerprints = new Set([
    ...Object.keys(baseline.content_hashes ?? {}),
    ...Object.keys(final.content_hashes ?? {})
  ]);
  const changedObservedPaths = [...observedFingerprints].filter(
    (repoPath) => baseline.content_hashes?.[repoPath] !== final.content_hashes?.[repoPath]
  );
  const incompletePathKeys = new Set([
    ...Object.keys(baseline.incomplete_paths ?? {}),
    ...Object.keys(final.incomplete_paths ?? {})
  ]);
  // Opaque/non-file paths cannot prove equality from endpoint metadata. Keep
  // them in scope whenever either snapshot saw them so a dirty->different-dirty
  // submodule or oversized file cannot collapse to a false clean result.
  const changedIncompletePaths = [...incompletePathKeys];
  const excludedFingerprints = new Set([
    ...Object.keys(baseline.excluded_fingerprints ?? {}),
    ...Object.keys(final.excluded_fingerprints ?? {})
  ]);
  const changedExcludedPaths = [...excludedFingerprints].filter(
    (repoPath) => baseline.excluded_fingerprints?.[repoPath] !== final.excluded_fingerprints?.[repoPath]
  );
  const directlyObservedPaths = new Set([
    ...splitNull(names.stdout),
    ...changedObservedPaths,
    ...changedIncompletePaths,
    ...changedExcludedPaths
  ]);
  const sensitivePaths = new Set([
    ...Object.keys(baseline.sensitive_fingerprints ?? {}),
    ...Object.keys(final.sensitive_fingerprints ?? {})
  ]);
  const sensitiveChangeCount = [...sensitivePaths].filter(
    (repoPath) => !directlyObservedPaths.has(repoPath)
      && baseline.sensitive_fingerprints?.[repoPath] !== final.sensitive_fingerprints?.[repoPath]
  ).length;
  const ignoredInventoryPresent = baseline.ignored_reviewable_fingerprint !== undefined
    || final.ignored_reviewable_fingerprint !== undefined;
  const ignoredChangeCount = ignoredInventoryPresent && (
    baseline.ignored_reviewable_complete === false
    || final.ignored_reviewable_complete === false
    || baseline.ignored_reviewable_fingerprint !== final.ignored_reviewable_fingerprint
  ) ? 1 : 0;
  const allPaths = [...directlyObservedPaths].sort();
  const classified = mergeExcluded(
    baseline,
    final,
    allPaths,
    excludedRenameDestinations(renameStatus.stdout)
  );
  const entries = [];
  const contentHashes = {};
  const lineCounts = {};
  const oldLineCounts = {};
  const sensitiveTreeValues = await sensitiveTreeFingerprints(root, [baseline.tree, final.tree], env, privacySalt);
  const sensitiveFingerprints = new Set([
    ...Object.values(baseline.sensitive_fingerprints ?? {}).map(rawPrivacyFingerprint),
    ...Object.values(final.sensitive_fingerprints ?? {}).map(rawPrivacyFingerprint),
    ...sensitiveTreeValues.fingerprints
  ].filter(Boolean));
  const sensitiveFragmentFingerprints = new Set();
  const sensitiveShortFragmentFingerprints = new Set();
  const shortInventoryPresent = Array.isArray(baseline.sensitive_short_fragment_fingerprints)
    && Array.isArray(final.sensitive_short_fragment_fingerprints);
  let sensitiveFragmentsComplete = Boolean(privacySalt && snapshotCoverageCompatible
    &&
    baseline.sensitive_fragment_complete !== false
    && final.sensitive_fragment_complete !== false
    && sensitiveTreeValues.fragmentsComplete
    && shortInventoryPresent);
  if (privacySalt) {
    sensitiveFragmentsComplete &&= mergePrivacyFragmentFingerprints(
      sensitiveFragmentFingerprints,
      baseline.sensitive_fragment_fingerprints
    );
    sensitiveFragmentsComplete &&= mergePrivacyFragmentFingerprints(
      sensitiveFragmentFingerprints,
      final.sensitive_fragment_fingerprints
    );
    sensitiveFragmentsComplete &&= mergePrivacyFragmentFingerprints(
      sensitiveFragmentFingerprints,
      sensitiveTreeValues.fragmentFingerprints
    );
    sensitiveFragmentsComplete &&= mergePrivacyShortFingerprints(
      sensitiveShortFragmentFingerprints,
      baseline.sensitive_short_fragment_fingerprints
    );
    sensitiveFragmentsComplete &&= mergePrivacyShortFingerprints(
      sensitiveShortFragmentFingerprints,
      final.sensitive_short_fragment_fingerprints
    );
    sensitiveFragmentsComplete &&= mergePrivacyShortFingerprints(
      sensitiveShortFragmentFingerprints,
      sensitiveTreeValues.shortFragmentFingerprints
    );
  }
  const requiredSourceClasses = [
    'denied_ignored_high_risk', 'denied_index', 'denied_tree', 'denied_worktree',
    'git_common_config', 'git_worktree_config'
  ];
  const effectivePrivacySalt = privacySalt ?? createPrivacyFragmentSalt();
  const coverage = createPrivacyCoverage({
    salt: effectivePrivacySalt,
    scope: 'turn_evidence',
    status: sensitiveFragmentsComplete ? 'complete' : 'incomplete',
    incompleteReason: sensitiveFragmentsComplete
      ? null
      : (snapshotCoverageCompatible ? 'index_capacity_exceeded' : 'snapshot_incompatible'),
    requiredSourceClasses,
    completedSourceClasses: sensitiveFragmentsComplete ? requiredSourceClasses : [],
    counters: {
      sources: sensitiveFingerprints.size,
      source_bytes: (baseline.privacy_coverage?.counters?.source_bytes ?? 0)
        + (final.privacy_coverage?.counters?.source_bytes ?? 0),
      source_window_work: sensitiveShortFragmentFingerprints.size,
      exact_fingerprints: sensitiveFingerprints.size,
      fragment_fingerprints: sensitiveFragmentFingerprints.size,
      window_fingerprints: sensitiveShortFragmentFingerprints.size
    }
  });
  const privacyIndex = createPrivacyCoverageIndex({
    salt: effectivePrivacySalt,
    exactFingerprints: sensitiveFingerprints,
    fragmentFingerprints: sensitiveFragmentFingerprints,
    windowFingerprints: sensitiveShortFragmentFingerprints,
    coverage
  });
  sensitiveFragmentsComplete &&= privacyCoverageIsCompatible(
    privacyIndex.coverage,
    effectivePrivacySalt,
    'turn_evidence'
  );
  const privacyInventory = { index: privacyIndex };

  for (const repoPath of classified.allowed) {
    const omitted = final.incomplete_paths[repoPath] ?? baseline.incomplete_paths[repoPath];
    if (omitted) {
      entries.push({
        path: repoPath,
        disposition: omitted,
        patch: `diff --git a/${repoPath} b/${repoPath}\n[TURN EVIDENCE OMITTED: ${omitted}]\n`
      });
      contentHashes[repoPath] = final.content_hashes[repoPath] ?? null;
      lineCounts[repoPath] = final.line_counts[repoPath] ?? null;
      continue;
    }

    const provisionalFingerprint = await treePathFingerprint(
      root,
      final.tree,
      repoPath,
      env,
      'complete',
      privacySalt,
      privacyInventory
    );
    const baselineFingerprint = await treePathFingerprint(
      root,
      baseline.tree,
      repoPath,
      env,
      'complete',
      privacySalt,
      privacyInventory
    );
    oldLineCounts[repoPath] = baselineFingerprint.lineCount;
    if (provisionalFingerprint.secretDetected || baselineFingerprint.secretDetected) {
      classified.excluded.push({ path: repoPath, reason: 'high-confidence secret material' });
      continue;
    }
    if (provisionalFingerprint.secretScanComplete === false
        || baselineFingerprint.secretScanComplete === false) {
      classified.excluded.push({ path: repoPath, reason: 'secret scan incomplete' });
      continue;
    }
    if ((provisionalFingerprint.symlinkTarget !== undefined
      && symlinkTargetIsDenied(repoPath, provisionalFingerprint.symlinkTarget))
      || (baselineFingerprint.symlinkTarget !== undefined
        && symlinkTargetIsDenied(repoPath, baselineFingerprint.symlinkTarget))) {
      classified.excluded.push({ path: repoPath, reason: 'symlink targets denied path' });
      continue;
    }
    const candidateFragmentsComplete = provisionalFingerprint.privacyFragmentsComplete !== false
      && baselineFingerprint.privacyFragmentsComplete !== false;
    if (!sensitiveFragmentsComplete || !candidateFragmentsComplete) {
      classified.excluded.push({ path: repoPath, reason: 'privacy fragment scan incomplete' });
      continue;
    }
    if (provisionalFingerprint.privacyFragmentMatch || baselineFingerprint.privacyFragmentMatch) {
      classified.excluded.push({ path: repoPath, reason: 'content fragment matches denied path' });
      continue;
    }
    if ((provisionalFingerprint.privacyFingerprint
      && sensitiveFingerprints.has(provisionalFingerprint.privacyFingerprint))
      || (baselineFingerprint.privacyFingerprint
        && sensitiveFingerprints.has(baselineFingerprint.privacyFingerprint))) {
      classified.excluded.push({ path: repoPath, reason: 'content matches denied path' });
      continue;
    }

    let patchText;
    try {
      patchText = (await git(root, [
        'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--unified=80',
        baseline.tree, final.tree, '--', literalPathspec(repoPath)
      ], { env, maxOutputBytes: MAX_GIT_OUTPUT_BYTES })).stdout;
    } catch (error) {
      if (!/exceeded .* bytes/.test(error.message)) throw error;
      entries.push({
        path: repoPath,
        disposition: 'size_omitted',
        patch: `diff --git a/${repoPath} b/${repoPath}\n[TURN PATCH OMITTED: SIZE LIMIT]\n`
      });
      contentHashes[repoPath] = null;
      lineCounts[repoPath] = null;
      continue;
    }
    const provisional = /^Binary files .* differ$/m.test(patchText) ? 'binary_omitted' : 'complete';
    const fingerprint = provisional === 'complete'
      ? provisionalFingerprint
      : await treePathFingerprint(root, final.tree, repoPath, env, provisional);
    const disposition = dispositionForPatch(patchText, fingerprint);
    entries.push({
      path: repoPath,
      disposition,
      patch: patchText,
      ...(fingerprint.hash === null ? { fileState: 'deleted', oldLineCount: baselineFingerprint.lineCount } : {})
    });
    contentHashes[repoPath] = fingerprint.hash;
    lineCounts[repoPath] = fingerprint.lineCount;
  }

  const bounded = applyPatchBudget(entries, maxPatchBytes);
  return {
    schema_version: '1',
    review_id: randomUUID(),
    captured_at: new Date().toISOString(),
    repository_root: root,
    head: final.head,
    scope: 'turn',
    base: baseline.tree,
    requested_base: null,
    session_id: sessionId,
    turn_id: turnId,
    baseline_tree: baseline.tree,
    final_tree: final.tree,
    changed_paths: entries.map((entry) => entry.path),
    excluded_paths: classified.excluded,
    sensitive_change_count: sensitiveChangeCount,
    ignored_change_count: ignoredChangeCount,
    privacy_coverage: privacyIndex.coverage,
    path_evidence: bounded.pathEvidence,
    incomplete_paths: bounded.incompletePaths,
    hunk_ranges: bounded.hunkRanges,
    status: `exact turn snapshot ${baseline.tree.slice(0, 12)}..${final.tree.slice(0, 12)}`,
    patch: bounded.patch,
    patch_hash: bounded.patchHash,
    patch_bytes: bounded.patchBytes,
    truncated: bounded.truncated,
    content_hashes: contentHashes,
    line_counts: lineCounts,
    old_line_counts: oldLineCounts
  };
}

export async function buildTurnEvidence(options) {
  const budget = options.budget ?? new CaptureBudget(options.budgetOptions);
  return captureBudgetContext.run(budget, () => buildTurnEvidenceWithinBudget(options));
}
