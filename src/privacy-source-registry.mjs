import { createHash } from 'node:crypto';

import { runGit } from './git-privacy-kernel.mjs';
import {
  createPrivacyCoverage,
  PRIVACY_LIMITS
} from './privacy-inventory.mjs';
import {
  mergePrivacyFragmentFingerprints,
  mergePrivacyShortFingerprints,
  privacyFragmentFingerprints
} from './privacy-fragments.mjs';
import { readStableRegularFile } from './stable-source-read.mjs';

export const LIVE_GIT_PRIVACY_SOURCE_CLASSES = Object.freeze([
  'git_common_config',
  'git_worktree_config'
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function decodedGitPath(stdout) {
  if (typeof stdout !== 'string') return null;
  const value = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (!value || value.includes('\0')) return null;
  return value;
}

async function resolveGitPrivacyPath(root, name, options) {
  try {
    const result = await (options.runGit ?? runGit)(root, [
      'rev-parse', '--path-format=absolute', '--git-path', name
    ], { budget: options.budget, maxOutputBytes: 1024 * 1024 });
    const resolved = decodedGitPath(result.stdout);
    return resolved
      ? { status: 'complete', path: resolved }
      : { status: 'incomplete', reason: 'source_resolution_failed' };
  } catch {
    return { status: 'incomplete', reason: 'source_resolution_failed' };
  }
}

async function captureGitPrivacySource(root, descriptor, privacySalt, options) {
  const firstResolution = await resolveGitPrivacyPath(root, descriptor.gitPath, options);
  if (firstResolution.status !== 'complete') return firstResolution;
  const read = await readStableRegularFile(firstResolution.path, {
    optional: descriptor.optional,
    maxBytes: options.maxSourceBytes ?? PRIVACY_LIMITS.maxSourceBytes,
    budget: options.budget,
    afterOpen: options.afterOpen
  });
  if (read.status === 'incomplete') return read;
  const secondResolution = await resolveGitPrivacyPath(root, descriptor.gitPath, options);
  if (secondResolution.status !== 'complete'
      || secondResolution.path !== firstResolution.path) {
    return { status: 'incomplete', reason: 'source_changed' };
  }
  const confirmation = await readStableRegularFile(secondResolution.path, {
    optional: descriptor.optional,
    maxBytes: options.maxSourceBytes ?? PRIVACY_LIMITS.maxSourceBytes,
    budget: options.budget
  });
  if (read.status === 'absent') {
    if (confirmation.status !== 'absent') {
      return { status: 'incomplete', reason: 'source_changed' };
    }
    return { status: 'complete', absent: true, descriptor };
  }
  if (confirmation.status !== 'complete'
      || !confirmation.bytes.equals(read.bytes)) {
    return { status: 'incomplete', reason: 'source_changed' };
  }
  const fragments = privacyFragmentFingerprints(read.bytes, privacySalt, {
    maxBytes: options.maxSourceBytes ?? PRIVACY_LIMITS.maxSourceBytes,
    maxFragments: options.maxFragments ?? PRIVACY_LIMITS.maxFragmentFingerprints,
    maxShortFragments: options.maxWindows ?? PRIVACY_LIMITS.maxWindowFingerprints,
    maxShortSourceWork: options.maxSourceWork ?? PRIVACY_LIMITS.maxSourceWindowWork
  });
  if (!fragments.complete) return { status: 'incomplete', reason: 'index_capacity_exceeded' };
  return {
    status: 'complete',
    absent: false,
    descriptor,
    exact: sha256(read.bytes),
    bytes: read.bytes.length,
    fragments: fragments.fingerprints,
    windows: fragments.shortFingerprints
  };
}

const LIVE_GIT_SOURCES = Object.freeze([
  Object.freeze({ id: 'git_common_config', gitPath: 'config', optional: false }),
  Object.freeze({ id: 'git_worktree_config', gitPath: 'config.worktree', optional: true })
]);

export async function captureLiveGitPrivacySources(options) {
  const exact = new Set();
  const fragments = new Set();
  const windows = new Set();
  const observations = {};
  const completed = [];
  let sourceBytes = 0;
  let incompleteReason = null;

  for (const descriptor of LIVE_GIT_SOURCES) {
    const captured = await captureGitPrivacySource(
      options.root,
      descriptor,
      options.privacySalt,
      options
    );
    if (captured.status !== 'complete') {
      incompleteReason ??= captured.reason;
      continue;
    }
    completed.push(descriptor.id);
    if (captured.absent) {
      observations[`live:${descriptor.id}`] = null;
      continue;
    }
    exact.add(captured.exact);
    observations[`live:${descriptor.id}`] = `file:${captured.exact}`;
    sourceBytes += captured.bytes;
    const fragmentMerged = mergePrivacyFragmentFingerprints(fragments, captured.fragments, {
      maxFragments: options.maxFragments ?? PRIVACY_LIMITS.maxFragmentFingerprints
    });
    const windowMerged = mergePrivacyShortFingerprints(windows, captured.windows, {
      maxShortFragments: options.maxWindows ?? PRIVACY_LIMITS.maxWindowFingerprints
    });
    if (!fragmentMerged || !windowMerged) incompleteReason ??= 'index_capacity_exceeded';
  }

  const status = incompleteReason === null ? 'complete' : 'incomplete';
  const coverage = createPrivacyCoverage({
    salt: options.privacySalt,
    scope: options.scope ?? 'live_git',
    status,
    incompleteReason,
    requiredSourceClasses: LIVE_GIT_PRIVACY_SOURCE_CLASSES,
    completedSourceClasses: completed,
    counters: {
      sources: exact.size,
      source_bytes: sourceBytes,
      source_window_work: windows.size,
      exact_fingerprints: exact.size,
      fragment_fingerprints: fragments.size,
      window_fingerprints: windows.size
    }
  });
  return { exact, fragments, windows, observations, coverage, complete: status === 'complete' };
}
