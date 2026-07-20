import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { CaptureBudget } from './capture-budget.mjs';
import { pathPolicy, isProbablyText, SENSITIVE_IGNORED_PATHSPECS } from './policy.mjs';
import {
  classifyPaths as classifyRepoPaths,
  countTextLines,
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
import { applyPatchBudget } from './patch-evidence.mjs';
import {
  createPrivacyCoverage,
  createPrivacyCoverageIndex,
  matchPrivacyCandidate,
  privacyCoverageIsCompatible
} from './privacy-inventory.mjs';
import { captureLiveGitPrivacySources } from './privacy-source-registry.mjs';
import {
  createPrivacyFragmentSalt,
  mergePrivacyFragmentFingerprints,
  mergePrivacyShortFingerprints,
  privacyFragmentFingerprints
} from './privacy-fragments.mjs';
import { scanSecretMaterial } from './secret-scan.mjs';

const DEFAULT_MAX_PATCH_BYTES = 256 * 1024;
const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
const MAX_SINGLE_DIFF_BYTES = 64 * 1024 * 1024;
const captureBudgetContext = new AsyncLocalStorage();

function activeBudget() {
  return captureBudgetContext.getStore() ?? null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function privacyDecision(content, privacySalt, privacyInventory) {
  if (!privacySalt || !privacyInventory) return { status: 'no_match', relation: null };
  if (privacyInventory.index) return matchPrivacyCandidate(content, privacyInventory.index);
  return { status: 'incomplete', reason: 'registry_incomplete' };
}

async function git(root, args, options = {}) {
  const result = await runGit(root, args, { ...options, budget: activeBudget() });
  return result.stdout;
}

async function fingerprintWorkingPath(
  root,
  repoPath,
  maxFileBytes = MAX_SINGLE_DIFF_BYTES,
  privacySalt = null,
  privacyInventory = null
) {
  const absolute = path.join(root, repoPath);
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      const targetBytes = await readlink(absolute, { encoding: 'buffer' });
      activeBudget()?.chargeFileBytes(targetBytes.length);
      const target = decodeSymlinkTarget(targetBytes);
      return {
        hash: sha256(Buffer.concat([Buffer.from('symlink:'), targetBytes])),
        privacyHash: sha256(targetBytes),
        lineCount: null,
        symlinkTarget: target,
        privacyFragments: [],
        privacyShortFragments: [],
        privacyFragmentMatch: false,
        privacyFragmentsComplete: true
      };
    }
    if (!stat.isFile()) {
      return { hash: sha256(`non-file:${stat.mode}:${stat.size}`), privacyHash: null, lineCount: null };
    }
    if (stat.size > maxFileBytes) {
      return {
        hash: sha256(`oversized:${stat.mode}:${stat.size}:${stat.mtimeMs}`),
        privacyHash: null,
        lineCount: null,
        oversized: true,
        privacyFragments: [],
        privacyShortFragments: [],
        privacyFragmentMatch: false,
        privacyFragmentsComplete: false
      };
    }
    const content = await readFile(absolute);
    activeBudget()?.chargeFileBytes(content.length);
    const secretScan = scanSecretMaterial(content);
    const fragments = privacySalt
      ? privacyFragmentFingerprints(content, privacySalt)
      : { complete: true, fingerprints: [], shortFingerprints: [] };
    const match = privacyDecision(content, privacySalt, privacyInventory);
    return {
      hash: sha256(content), privacyHash: sha256(content), lineCount: countTextLines(content),
      privacyFragments: fragments.fingerprints,
      privacyShortFragments: fragments.shortFingerprints,
      privacyFragmentMatch: match.status === 'match',
      privacyFragmentsComplete: fragments.complete && match.status !== 'incomplete',
      secretDetected: secretScan.detected,
      secretScanComplete: secretScan.complete
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { hash: null, privacyHash: null, lineCount: null };
    throw error;
  }
}

async function fingerprintTreePath(
  root,
  headSha,
  repoPath,
  disposition,
  privacySalt = null,
  privacyInventory = null
) {
  const treeEntry = await git(root, ['ls-tree', '-z', headSha, '--', literalPathspec(repoPath)], {
    encoding: null
  });
  const parsedTreeEntry = parseGitTreeEntry(treeEntry, repoPath);
  if (!parsedTreeEntry) return { hash: null, privacyHash: null, lineCount: null };
  const { mode, objectId } = parsedTreeEntry;
  if (mode === '120000' && disposition === 'complete') {
    const targetBytes = await git(root, ['cat-file', 'blob', objectId], {
      maxOutputBytes: 1024 * 1024,
      encoding: null
    });
    return {
      hash: `git-object:${objectId}`,
      privacyHash: sha256(targetBytes),
      lineCount: null,
      symlinkTarget: decodeSymlinkTarget(targetBytes),
      privacyFragments: [],
      privacyShortFragments: [],
      privacyFragmentMatch: false,
      privacyFragmentsComplete: true
    };
  }
  if (mode !== '100644' && mode !== '100755') {
    return { hash: `git-object:${objectId}`, privacyHash: null, lineCount: null };
  }
  if (disposition !== 'complete') return { hash: `git-object:${objectId}`, privacyHash: null, lineCount: null };
  const content = await git(root, ['cat-file', 'blob', objectId], {
    maxOutputBytes: MAX_SINGLE_DIFF_BYTES,
    encoding: null
  });
  const secretScan = scanSecretMaterial(content);
  const fragments = privacySalt
    ? privacyFragmentFingerprints(content, privacySalt)
    : { complete: true, fingerprints: [], shortFingerprints: [] };
  const matchResult = privacyDecision(content, privacySalt, privacyInventory);
  return {
    hash: `git-object:${objectId}`, privacyHash: sha256(content), lineCount: countTextLines(content),
    privacyFragments: fragments.fingerprints,
    privacyShortFragments: fragments.shortFingerprints,
    privacyFragmentMatch: matchResult.status === 'match',
    privacyFragmentsComplete: fragments.complete && matchResult.status !== 'incomplete',
    secretDetected: secretScan.detected,
    secretScanComplete: secretScan.complete
  };
}

async function sensitiveIndexHashes(root, privacySalt) {
  const raw = await git(root, ['ls-files', '--stage', '-z'], {
    maxOutputBytes: MAX_SINGLE_DIFF_BYTES,
    encoding: null
  });
  const hashes = new Set();
  const fragments = new Set();
  const shortFragments = new Set();
  let complete = true;
  for (const entry of parseGitIndexEntries(raw)) {
    const { mode, objectId, path: repoPath } = entry;
    if (pathPolicy(repoPath).allowed) continue;
    if (!['100644', '100755', '120000'].includes(mode)) continue;
    const bytes = await git(root, ['cat-file', 'blob', objectId], {
      maxOutputBytes: MAX_SINGLE_DIFF_BYTES,
      encoding: null
    });
    hashes.add(sha256(bytes));
    if (mode !== '120000') {
      const fragmentResult = privacyFragmentFingerprints(bytes, privacySalt);
      complete &&= fragmentResult.complete;
      complete &&= mergePrivacyFragmentFingerprints(fragments, fragmentResult.fingerprints);
      complete &&= mergePrivacyShortFingerprints(shortFragments, fragmentResult.shortFingerprints);
    }
  }
  return { hashes, fragments, shortFragments, complete };
}

async function sensitiveWorkingHashes(root, privacySalt, explicitExcluded = [], baselineRefs = []) {
  const [tracked, ignored] = await Promise.all([
    git(root, ['ls-files', '-z'], { maxOutputBytes: MAX_SINGLE_DIFF_BYTES, encoding: null }),
    git(root, [
      'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--',
      ...SENSITIVE_IGNORED_PATHSPECS
    ], { maxOutputBytes: MAX_SINGLE_DIFF_BYTES, encoding: null })
  ]);
  const ignoredPaths = splitNull(ignored).filter((repoPath) => !pathPolicy(repoPath).allowed);
  const candidates = [...new Set([
    ...splitNull(tracked),
    ...ignoredPaths,
    ...explicitExcluded.map((item) => item.path)
  ])].filter((repoPath) => !pathPolicy(repoPath).allowed);
  activeBudget()?.chargePaths(candidates.length);
  const [indexValues, baselineValues, liveValues] = await Promise.all([
    sensitiveIndexHashes(root, privacySalt),
    sensitiveTreeHashes(root, baselineRefs, privacySalt, { includeLiveGit: false }),
    captureLiveGitPrivacySources({
      root,
      privacySalt,
      budget: activeBudget(),
      scope: 'manual_working'
    })
  ]);
  const hashes = new Set([...indexValues.hashes, ...baselineValues.hashes, ...liveValues.exact]);
  const fragments = new Set();
  const shortFragments = new Set();
  let complete = indexValues.complete && baselineValues.complete && liveValues.complete;
  complete &&= mergePrivacyFragmentFingerprints(fragments, indexValues.fragments);
  complete &&= mergePrivacyFragmentFingerprints(fragments, baselineValues.fragments);
  complete &&= mergePrivacyShortFingerprints(shortFragments, indexValues.shortFragments);
  complete &&= mergePrivacyShortFingerprints(shortFragments, baselineValues.shortFragments);
  complete &&= mergePrivacyFragmentFingerprints(fragments, liveValues.fragments);
  complete &&= mergePrivacyShortFingerprints(shortFragments, liveValues.windows);
  for (const repoPath of candidates) {
    const fingerprint = await fingerprintWorkingPath(root, repoPath, MAX_SINGLE_DIFF_BYTES, privacySalt);
    if (fingerprint.privacyHash) hashes.add(fingerprint.privacyHash);
    complete &&= fingerprint.privacyFragmentsComplete !== false;
    complete &&= mergePrivacyFragmentFingerprints(fragments, fingerprint.privacyFragments);
    complete &&= mergePrivacyShortFingerprints(shortFragments, fingerprint.privacyShortFragments);
  }
  const requiredSourceClasses = [
    'denied_ignored_high_risk', 'denied_index', 'denied_tree', 'denied_worktree',
    'git_common_config', 'git_worktree_config'
  ];
  const coverage = createPrivacyCoverage({
    salt: privacySalt,
    scope: 'manual_working',
    status: complete ? 'complete' : 'incomplete',
    incompleteReason: complete ? null : (liveValues.coverage.incomplete_reason ?? 'index_capacity_exceeded'),
    requiredSourceClasses,
    completedSourceClasses: complete ? requiredSourceClasses : [],
    counters: {
      sources: hashes.size,
      source_bytes: liveValues.coverage.counters.source_bytes,
      source_window_work: shortFragments.size,
      exact_fingerprints: hashes.size,
      fragment_fingerprints: fragments.size,
      window_fingerprints: shortFragments.size
    }
  });
  const index = createPrivacyCoverageIndex({
    salt: privacySalt,
    exactFingerprints: hashes,
    fragmentFingerprints: fragments,
    windowFingerprints: shortFragments,
    coverage
  });
  complete &&= privacyCoverageIsCompatible(index.coverage, privacySalt, 'manual_working');
  return { hashes, fragments, shortFragments, complete, ignoredPaths, coverage: index.coverage, index };
}

async function sensitiveTreeHashes(root, refs, privacySalt, options = {}) {
  const hashes = new Set();
  const fragments = new Set();
  const shortFragments = new Set();
  let complete = true;
  for (const ref of refs) {
    const paths = splitNull(await git(root, ['ls-tree', '-r', '--name-only', '-z', ref], {
      maxOutputBytes: MAX_SINGLE_DIFF_BYTES,
      encoding: null
    })).filter((repoPath) => !pathPolicy(repoPath).allowed);
    activeBudget()?.chargePaths(paths.length);
    for (const repoPath of paths) {
      const fingerprint = await fingerprintTreePath(root, ref, repoPath, 'complete', privacySalt);
      if (fingerprint.privacyHash) hashes.add(fingerprint.privacyHash);
      complete &&= fingerprint.privacyFragmentsComplete !== false;
      complete &&= mergePrivacyFragmentFingerprints(fragments, fingerprint.privacyFragments);
      complete &&= mergePrivacyShortFingerprints(shortFragments, fingerprint.privacyShortFragments);
    }
  }
  let liveValues = null;
  if (options.includeLiveGit !== false) {
    liveValues = await captureLiveGitPrivacySources({
      root,
      privacySalt,
      budget: activeBudget(),
      scope: 'manual_branch'
    });
    complete &&= liveValues.complete;
    for (const value of liveValues.exact) hashes.add(value);
    complete &&= mergePrivacyFragmentFingerprints(fragments, liveValues.fragments);
    complete &&= mergePrivacyShortFingerprints(shortFragments, liveValues.windows);
  }
  const requiredSourceClasses = options.includeLiveGit === false
    ? ['denied_tree']
    : ['denied_tree', 'git_common_config', 'git_worktree_config'];
  const coverage = createPrivacyCoverage({
    salt: privacySalt,
    scope: options.includeLiveGit === false ? 'tree_only' : 'manual_branch',
    status: complete ? 'complete' : 'incomplete',
    incompleteReason: complete ? null : (liveValues?.coverage.incomplete_reason ?? 'index_capacity_exceeded'),
    requiredSourceClasses,
    completedSourceClasses: complete ? requiredSourceClasses : [],
    counters: {
      sources: hashes.size,
      source_bytes: liveValues?.coverage.counters.source_bytes ?? 0,
      source_window_work: shortFragments.size,
      exact_fingerprints: hashes.size,
      fragment_fingerprints: fragments.size,
      window_fingerprints: shortFragments.size
    }
  });
  const index = createPrivacyCoverageIndex({
    salt: privacySalt,
    exactFingerprints: hashes,
    fragmentFingerprints: fragments,
    windowFingerprints: shortFragments,
    coverage
  });
  complete &&= privacyCoverageIsCompatible(index.coverage, privacySalt, coverage.scope);
  return { hashes, fragments, shortFragments, complete, coverage: index.coverage, index };
}

async function untrackedPatch(root, repoPath, maxFileBytes) {
  const absolute = path.join(root, repoPath);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    return {
      disposition: 'non_file_omitted',
      patch: `diff --git a/${repoPath} b/${repoPath}\nnew file mode 120000\n[SYMLINK TARGET OMITTED]\n`
    };
  }
  if (!stat.isFile()) {
    return {
      disposition: 'non_file_omitted',
      patch: `diff --git a/${repoPath} b/${repoPath}\n[NON-FILE PATH OMITTED]\n`
    };
  }
  if (stat.size > maxFileBytes) {
    return {
      disposition: 'size_omitted',
      patch: `diff --git a/${repoPath} b/${repoPath}\n[UNTRACKED FILE OMITTED: ${stat.size} BYTES]\n`
    };
  }
  const content = await readFile(absolute);
  activeBudget()?.chargeFileBytes(content.length);
  if (!isProbablyText(content)) {
    return {
      disposition: 'binary_omitted',
      patch: `diff --git a/${repoPath} b/${repoPath}\n[BINARY UNTRACKED FILE OMITTED]\n`
    };
  }
  const text = content.toString('utf8');
  const trailingNewline = text.endsWith('\n');
  const lines = text ? text.split('\n') : [];
  if (trailingNewline) lines.pop();
  const mode = stat.mode & 0o111 ? '100755' : '100644';
  const header = `diff --git a/${repoPath} b/${repoPath}\nnew file mode ${mode}\n--- /dev/null\n+++ b/${repoPath}\n`;
  if (lines.length === 0) return { disposition: 'complete', patch: header };
  const body = lines.map((line) => `+${line}`).join('\n');
  const marker = trailingNewline ? '\n' : '\n\\ No newline at end of file\n';
  return {
    disposition: 'complete',
    patch: `${header}@@ -0,0 +1,${lines.length} @@\n${body}${marker}`
  };
}

function dispositionForTrackedPatch(patchText, fingerprint) {
  if (/^Binary files .* differ$/m.test(patchText)) return 'binary_omitted';
  if (fingerprint.hash === null) return 'complete';
  if (fingerprint.oversized) return 'size_omitted';
  if (fingerprint.lineCount === null) return 'non_file_omitted';
  return 'complete';
}

async function resolveRoot(cwd) {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

async function resolveHead(root) {
  return (await git(root, ['rev-parse', '--verify', 'HEAD'], { acceptedExitCodes: [0, 128] })).trim() || 'UNBORN';
}

async function emptyTree(root) {
  return (await git(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim();
}

function classifyPaths(allPaths, forcedExcluded = new Set()) {
  const result = classifyRepoPaths(allPaths, forcedExcluded);
  return { allowedPaths: result.allowed, excludedPaths: result.excluded };
}

async function workingPathInventory(root) {
  const inventory = await workingInventory(root, { budget: activeBudget() });
  activeBudget()?.chargePaths(inventory.allPaths.length);
  return {
    staged: [...inventory.staged],
    unstaged: [...inventory.unstaged],
    untracked: [...inventory.untracked],
    allPaths: inventory.allPaths,
    excludedRenameDestinations: inventory.forcedExcluded
  };
}

async function captureWorkingSnapshot(root, options) {
  const head = await resolveHead(root);
  const statusBefore = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: null
  });
  const inventory = await workingPathInventory(root);
  const classified = classifyPaths(
    inventory.allPaths,
    inventory.excludedRenameDestinations
  );
  const allowedPaths = [];
  const excludedPaths = [...classified.excludedPaths];
  const untracked = new Set(inventory.untracked);
  const staged = new Set(inventory.staged);
  const unstaged = new Set(inventory.unstaged);
  const tracked = new Set([...inventory.staged, ...inventory.unstaged]);
  const baseline = head === 'UNBORN' ? await emptyTree(root) : head;
  const entries = [];
  const contentHashes = {};
  const lineCounts = {};
  const oldLineCounts = {};
  const sensitive = await sensitiveWorkingHashes(root, options.privacySalt, excludedPaths, [baseline]);
  const sensitiveHashes = sensitive.hashes;
  const excludedSet = new Set(excludedPaths.map((item) => item.path));
  for (const repoPath of sensitive.ignoredPaths) {
    if (!excludedSet.has(repoPath)) {
      excludedPaths.push({ path: repoPath, reason: pathPolicy(repoPath).reason });
      excludedSet.add(repoPath);
    }
  }

  for (const repoPath of classified.allowedPaths) {
    const fingerprint = await fingerprintWorkingPath(
      root,
      repoPath,
      untracked.has(repoPath) && !tracked.has(repoPath)
        ? options.maxUntrackedFileBytes
        : MAX_SINGLE_DIFF_BYTES,
      options.privacySalt,
      sensitive
    );
    const baselineFingerprint = await fingerprintTreePath(
      root,
      baseline,
      repoPath,
      'complete',
      options.privacySalt,
      sensitive
    );
    oldLineCounts[repoPath] = baselineFingerprint.lineCount;
    if (fingerprint.secretDetected || baselineFingerprint.secretDetected) {
      excludedPaths.push({ path: repoPath, reason: 'high-confidence secret material' });
      continue;
    }
    if (fingerprint.secretScanComplete === false || baselineFingerprint.secretScanComplete === false) {
      excludedPaths.push({ path: repoPath, reason: 'secret scan incomplete' });
      continue;
    }
    if ((fingerprint.privacyHash && sensitiveHashes.has(fingerprint.privacyHash))
      || (baselineFingerprint.privacyHash && sensitiveHashes.has(baselineFingerprint.privacyHash))
      || (fingerprint.symlinkTarget !== undefined && symlinkTargetIsDenied(repoPath, fingerprint.symlinkTarget))
      || (baselineFingerprint.symlinkTarget !== undefined
        && symlinkTargetIsDenied(repoPath, baselineFingerprint.symlinkTarget))) {
      excludedPaths.push({
        path: repoPath,
        reason: fingerprint.symlinkTarget !== undefined ? 'symlink targets denied path' : 'content matches denied path'
      });
      continue;
    }
    if (!sensitive.complete || (!fingerprint.oversized
      && (fingerprint.privacyFragmentsComplete === false
        || baselineFingerprint.privacyFragmentsComplete === false))) {
      excludedPaths.push({ path: repoPath, reason: 'privacy fragment scan incomplete' });
      continue;
    }
    if (fingerprint.privacyFragmentMatch || baselineFingerprint.privacyFragmentMatch) {
      excludedPaths.push({ path: repoPath, reason: 'content fragment matches denied path' });
      continue;
    }
    if (staged.has(repoPath) && (unstaged.has(repoPath) || untracked.has(repoPath))) {
      allowedPaths.push(repoPath);
      entries.push({
        path: repoPath,
        disposition: 'index_worktree_diverged',
        patch: `diff --git a/${repoPath} b/${repoPath}\n[INDEX AND WORKTREE REPRESENTATIONS DIVERGE]\n`
      });
      contentHashes[repoPath] = fingerprint.hash;
      lineCounts[repoPath] = fingerprint.lineCount;
      continue;
    }
    let entry;
    if (untracked.has(repoPath) && !tracked.has(repoPath)) {
      entry = await untrackedPatch(root, repoPath, options.maxUntrackedFileBytes);
      contentHashes[repoPath] = fingerprint.hash;
      lineCounts[repoPath] = fingerprint.lineCount;
    } else {
      const patchText = await git(root, [
        'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--unified=80', baseline, '--', literalPathspec(repoPath)
      ], { maxOutputBytes: MAX_SINGLE_DIFF_BYTES });
      entry = { disposition: dispositionForTrackedPatch(patchText, fingerprint), patch: patchText };
      contentHashes[repoPath] = fingerprint.hash;
      lineCounts[repoPath] = fingerprint.lineCount;
    }
    allowedPaths.push(repoPath);
    entries.push({
      path: repoPath,
      ...entry,
      ...(fingerprint.hash === null ? { fileState: 'deleted', oldLineCount: baselineFingerprint.lineCount } : {})
    });
  }

  const status = allowedPaths.length
    ? (await git(root, [
        'status', '--short', '--no-renames', '--untracked-files=all', '--', ...allowedPaths.map(literalPathspec)
      ])).trim()
    : '';
  const statusAfter = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: null
  });
  const endingHead = await resolveHead(root);
  if (head !== endingHead || !statusBefore.equals(statusAfter)) {
    throw new Error('review scope changed during evidence capture; retry');
  }

  return {
    head,
    base: null,
    requestedBase: null,
    allPaths: inventory.allPaths,
    allowedPaths,
    excludedPaths,
    entries,
    contentHashes,
    lineCounts,
    oldLineCounts,
    privacyCoverage: sensitive.coverage,
    status
  };
}

function snapshotSignature(snapshot) {
  return sha256(JSON.stringify({
    head: snapshot.head,
    allPaths: snapshot.allPaths,
    allowedPaths: snapshot.allowedPaths,
    excludedPaths: snapshot.excludedPaths,
    entries: snapshot.entries,
    contentHashes: snapshot.contentHashes,
    lineCounts: snapshot.lineCounts,
    oldLineCounts: snapshot.oldLineCounts,
    privacyCoverage: snapshot.privacyCoverage,
    status: snapshot.status
  }));
}

async function collectStableWorkingTree(root, options) {
  const first = await captureWorkingSnapshot(root, options);
  if (options.afterFirstCapture) await options.afterFirstCapture();
  const second = await captureWorkingSnapshot(root, options);
  if (snapshotSignature(first) !== snapshotSignature(second)) {
    throw new Error('review scope changed during evidence capture; retry');
  }
  return second;
}

async function collectBranch(root, requestedBase, privacySalt) {
  if (!requestedBase) throw new Error('--base is required for --scope branch');
  const head = await resolveHead(root);
  if (head === 'UNBORN') throw new Error('branch scope requires an existing HEAD commit');
  const base = (await git(root, ['rev-parse', '--verify', `${requestedBase}^{commit}`])).trim();
  const mergeBase = (await git(root, ['merge-base', base, head])).trim();
  const names = splitNull(await git(root, [
    'diff', '--name-only', '--no-renames', '-z', `${base}...${head}`
  ], { encoding: null }));
  const allPaths = [...new Set(names)].sort();
  const renameStatus = await git(root, [
    'diff', '--name-status', '--find-renames', '--find-copies-harder', '-z', `${base}...${head}`
  ], { encoding: null });
  const classified = classifyPaths(allPaths, excludedRenameDestinations(renameStatus));
  const allowedPaths = [];
  const excludedPaths = [...classified.excludedPaths];
  const entries = [];
  const contentHashes = {};
  const lineCounts = {};
  const oldLineCounts = {};
  const sensitive = await sensitiveTreeHashes(root, [mergeBase, head], privacySalt);
  const sensitiveHashes = sensitive.hashes;

  for (const repoPath of classified.allowedPaths) {
    const patchText = await git(root, [
      'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--unified=80',
      `${base}...${head}`, '--', literalPathspec(repoPath)
    ], { maxOutputBytes: MAX_SINGLE_DIFF_BYTES });
    const provisional = /^Binary files .* differ$/m.test(patchText) ? 'binary_omitted' : 'complete';
    const fingerprint = await fingerprintTreePath(
      root,
      head,
      repoPath,
      provisional,
      privacySalt,
      sensitive
    );
    const baselineFingerprint = await fingerprintTreePath(
      root,
      mergeBase,
      repoPath,
      provisional,
      privacySalt,
      sensitive
    );
    oldLineCounts[repoPath] = baselineFingerprint.lineCount;
    if (fingerprint.secretDetected || baselineFingerprint.secretDetected) {
      excludedPaths.push({ path: repoPath, reason: 'high-confidence secret material' });
      continue;
    }
    if (fingerprint.secretScanComplete === false || baselineFingerprint.secretScanComplete === false) {
      excludedPaths.push({ path: repoPath, reason: 'secret scan incomplete' });
      continue;
    }
    if ((fingerprint.privacyHash && sensitiveHashes.has(fingerprint.privacyHash))
      || (baselineFingerprint.privacyHash && sensitiveHashes.has(baselineFingerprint.privacyHash))
      || (fingerprint.symlinkTarget !== undefined && symlinkTargetIsDenied(repoPath, fingerprint.symlinkTarget))
      || (baselineFingerprint.symlinkTarget !== undefined
        && symlinkTargetIsDenied(repoPath, baselineFingerprint.symlinkTarget))) {
      excludedPaths.push({
        path: repoPath,
        reason: fingerprint.symlinkTarget !== undefined ? 'symlink targets denied path' : 'content matches denied path'
      });
      continue;
    }
    if (!sensitive.complete || fingerprint.privacyFragmentsComplete === false
      || baselineFingerprint.privacyFragmentsComplete === false) {
      excludedPaths.push({ path: repoPath, reason: 'privacy fragment scan incomplete' });
      continue;
    }
    if (fingerprint.privacyFragmentMatch || baselineFingerprint.privacyFragmentMatch) {
      excludedPaths.push({ path: repoPath, reason: 'content fragment matches denied path' });
      continue;
    }
    const disposition = dispositionForTrackedPatch(patchText, fingerprint);
    allowedPaths.push(repoPath);
    entries.push({
      path: repoPath,
      disposition,
      patch: patchText,
      ...(fingerprint.hash === null ? { fileState: 'deleted', oldLineCount: baselineFingerprint.lineCount } : {})
    });
    contentHashes[repoPath] = fingerprint.hash;
    lineCounts[repoPath] = fingerprint.lineCount;
  }

  return {
    head,
    base,
    requestedBase,
    allPaths,
    allowedPaths,
    excludedPaths,
    entries,
    contentHashes,
    lineCounts,
    oldLineCounts,
    privacyCoverage: sensitive.coverage,
    status: `branch ${head} compared with merge-base of ${base}`
  };
}

async function collectEvidenceWithinBudget(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? 'working-tree';
  const root = await resolveRoot(cwd);
  const privacySalt = createPrivacyFragmentSalt();
  const captured = scope === 'branch'
    ? await collectBranch(root, options.base, privacySalt)
    : await collectStableWorkingTree(root, {
        maxUntrackedFileBytes: options.maxUntrackedFileBytes ?? DEFAULT_MAX_UNTRACKED_FILE_BYTES,
        afterFirstCapture: options.afterFirstCapture,
        privacySalt
      });
  const bounded = applyPatchBudget(captured.entries, options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES);

  return {
    schema_version: '1',
    review_id: randomUUID(),
    captured_at: new Date().toISOString(),
    repository_root: root,
    head: captured.head,
    scope,
    base: captured.base,
    requested_base: captured.requestedBase,
    changed_paths: captured.allowedPaths,
    excluded_paths: captured.excludedPaths,
    sensitive_change_count: 0,
    ignored_change_count: 0,
    privacy_coverage: captured.privacyCoverage,
    path_evidence: bounded.pathEvidence,
    incomplete_paths: bounded.incompletePaths,
    hunk_ranges: bounded.hunkRanges,
    status: captured.status,
    patch: bounded.patch,
    patch_hash: bounded.patchHash,
    patch_bytes: bounded.patchBytes,
    truncated: bounded.truncated,
    content_hashes: captured.contentHashes,
    line_counts: captured.lineCounts,
    old_line_counts: captured.oldLineCounts
  };
}

export async function collectEvidence(options = {}) {
  const budget = options.budget ?? new CaptureBudget(options.budgetOptions);
  return captureBudgetContext.run(budget, () => collectEvidenceWithinBudget(options));
}

export function receiptEvidence(evidence, retainEvidence = false) {
  const excludedReasonCounts = Object.fromEntries(
    [...new Set((evidence.excluded_paths ?? []).map((item) => item.reason))]
      .sort()
      .map((reason) => [
        reason,
        evidence.excluded_paths.filter((item) => item.reason === reason).length
      ])
  );
  return {
    ...evidence,
    excluded_paths: retainEvidence ? evidence.excluded_paths : [],
    excluded_path_count: evidence.excluded_paths?.length ?? 0,
    excluded_reason_counts: excludedReasonCounts,
    patch: retainEvidence ? evidence.patch : null,
    evidence_material_retained: retainEvidence
  };
}
