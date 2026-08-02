import {
  excludedRenameDestinations,
  literalPathspec,
  parseGitIndexEntries,
  runGit,
  splitNull
} from './git-privacy-kernel.mjs';
import { pathPolicy } from './policy.mjs';

const MAX_PATHSPEC_ARGUMENT_BYTES = 16 * 1024;
const MAX_PATHSPEC_BATCH_PATHS = 128;
const MAX_ATTRIBUTE_OUTPUT_BYTES = 64 * 1024 * 1024;

function decodeLosslessUtf8(value) {
  const text = value.toString('utf8');
  if (!Buffer.from(text).equals(value)) {
    throw new Error('Git clean-filter attributes could not be resolved safely');
  }
  return text;
}

function nullFields(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError('Git attribute output must be bytes');
  const fields = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    fields.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start !== value.length) throw new Error('Git clean-filter attributes could not be resolved safely');
  return fields;
}

function attributeInput(paths) {
  if (paths.length === 0) return Buffer.alloc(0);
  return Buffer.from(`${paths.join('\0')}\0`);
}

async function cleanFilterPathsFrom(root, trackedPaths, sourceArgs, options) {
  const result = await runGit(root, ['check-attr', '-z', ...sourceArgs, '--stdin', 'filter'], {
    ...options,
    encoding: null,
    input: attributeInput(trackedPaths),
    maxOutputBytes: MAX_ATTRIBUTE_OUTPUT_BYTES
  });
  const fields = nullFields(result.stdout);
  if (fields.length !== trackedPaths.length * 3) {
    throw new Error('Git clean-filter attributes could not be resolved safely');
  }
  const active = new Set();
  for (let index = 0; index < trackedPaths.length; index += 1) {
    const pathField = decodeLosslessUtf8(fields[index * 3]);
    const attribute = decodeLosslessUtf8(fields[(index * 3) + 1]);
    const value = decodeLosslessUtf8(fields[(index * 3) + 2]);
    if (pathField !== trackedPaths[index] || attribute !== 'filter') {
      throw new Error('Git clean-filter attributes could not be resolved safely');
    }
    if (!['unspecified', 'unset', 'set'].includes(value)) active.add(pathField);
  }
  return active;
}

async function cleanFilterPaths(root, candidatePaths, options) {
  if (candidatePaths.length === 0) return new Set();
  const head = await runGit(root, ['rev-parse', '--verify', 'HEAD'], {
    ...options,
    acceptedExitCodes: [0, 128]
  });
  const sources = [[], ['--cached']];
  if (head.stdout.trim()) sources.push([`--source=${head.stdout.trim()}`]);
  const resolved = await Promise.all(
    sources.map((sourceArgs) => cleanFilterPathsFrom(root, candidatePaths, sourceArgs, options))
  );
  return new Set(resolved.flatMap((paths) => [...paths]));
}

function pathspecBytes(paths) {
  return paths.reduce((total, repoPath) => total + Buffer.byteLength(repoPath, 'utf8') + 24, 0);
}

function pathBatches(paths) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const repoPath of paths) {
    const nextBytes = Buffer.byteLength(repoPath, 'utf8') + 20;
    if (batch.length > 0
        && (batch.length >= MAX_PATHSPEC_BATCH_PATHS || bytes + nextBytes > MAX_PATHSPEC_ARGUMENT_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(repoPath);
    bytes += nextBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function worktreeDiffWithoutFilters(root, args, trackedPaths, filteredPaths, options) {
  if (filteredPaths.size === 0) return runGit(root, args, { ...options, encoding: null });
  const exclusions = [...filteredPaths].sort().map((repoPath) => `:(exclude,literal)${repoPath}`);
  if (pathspecBytes(exclusions) <= MAX_PATHSPEC_ARGUMENT_BYTES) {
    return runGit(root, [...args, '--', '.', ...exclusions], { ...options, encoding: null });
  }

  const safePaths = trackedPaths.filter((repoPath) => !filteredPaths.has(repoPath));
  const outputs = [];
  for (const batch of pathBatches(safePaths)) {
    const result = await runGit(root, [...args, '--', ...batch.map(literalPathspec)], {
      ...options,
      encoding: null
    });
    outputs.push(result.stdout);
  }
  return { stdout: Buffer.concat(outputs) };
}

export async function filterSafeWorkingInventory(root, options = {}) {
  const [staged, untracked, stagedRenames, tracked, fileMode] = await Promise.all([
    runGit(root, ['diff', '--name-only', '--no-renames', '-z', '--cached'], { ...options, encoding: null }),
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], { ...options, encoding: null }),
    runGit(root, ['diff', '--name-status', '--find-renames', '--find-copies-harder', '-z', '--cached'], {
      ...options,
      encoding: null
    }),
    runGit(root, ['ls-files', '--stage', '-z'], { ...options, encoding: null }),
    runGit(root, ['config', '--bool', 'core.fileMode'], {
      ...options,
      acceptedExitCodes: [0, 1]
    })
  ]);
  const stagedPaths = splitNull(staged.stdout);
  const indexEntries = parseGitIndexEntries(tracked.stdout);
  const conflictedPaths = new Set(
    indexEntries.filter((entry) => entry.stage !== '0').map((entry) => entry.path)
  );
  const stagedPathSet = new Set([...stagedPaths, ...conflictedPaths]);
  const trackedPaths = [...new Set(indexEntries.map((entry) => entry.path))].sort();
  const indexModes = new Map(
    indexEntries.filter((entry) => entry.stage === '0').map((entry) => [entry.path, entry.mode])
  );
  const indexObjects = new Map(
    indexEntries
      .filter((entry) => entry.stage === '0')
      .map((entry) => [entry.path, { mode: entry.mode, objectId: entry.objectId }])
  );
  const attributeCandidatePaths = [...new Set([...trackedPaths, ...stagedPaths])].sort();
  const filteredPaths = await cleanFilterPaths(root, attributeCandidatePaths, options);
  const [unstaged, unstagedRenames] = await Promise.all([
    worktreeDiffWithoutFilters(
      root,
      ['diff', '--name-only', '--no-renames', '-z'],
      trackedPaths,
      filteredPaths,
      options
    ),
    worktreeDiffWithoutFilters(
      root,
      ['diff', '--name-status', '--find-renames', '--find-copies-harder', '-z'],
      trackedPaths,
      filteredPaths,
      options
    )
  ]);
  const unstagedPaths = [...new Set([...splitNull(unstaged.stdout), ...conflictedPaths])].sort();
  const untrackedPaths = splitNull(untracked.stdout);
  // The staged representation is provably changed through index/tree
  // metadata. The filtered worktree representation remains unproven because
  // classifying it would execute the clean filter.
  const stagedCleanFilterChanges = new Set(
    [...filteredPaths].filter((repoPath) => stagedPathSet.has(repoPath))
  );
  const unprovenCleanFilterChanges = new Set(filteredPaths);
  const forcedExcluded = new Set([
    ...excludedRenameDestinations(stagedRenames.stdout),
    ...excludedRenameDestinations(unstagedRenames.stdout)
  ]);
  const hasDeniedFilteredSource = [...filteredPaths].some((repoPath) => !pathPolicy(repoPath).allowed);
  // A clean filter is intentionally never run to reconstruct a denied source's
  // raw historical bytes. Conservatively exclude every changed destination
  // while one exists rather than permitting filter-based copy laundering into
  // either an untracked path or an already-tracked path.
  if (hasDeniedFilteredSource) {
    for (const repoPath of [...stagedPaths, ...unstagedPaths, ...untrackedPaths]) {
      forcedExcluded.add(repoPath);
    }
  }
  return {
    allPaths: [...new Set([
      ...stagedPaths,
      ...unstagedPaths,
      ...untrackedPaths,
      ...unprovenCleanFilterChanges
    ])].sort(),
    staged: stagedPathSet,
    unstaged: new Set(unstagedPaths),
    untracked: new Set(untrackedPaths),
    activeCleanFilters: filteredPaths,
    stagedCleanFilterChanges,
    unprovenCleanFilterChanges,
    coreFileMode: fileMode.stdout.trim() !== 'false',
    indexModes,
    indexObjects,
    forcedExcluded
  };
}

export function filterSafeInventoryBytes(inventory) {
  return Buffer.from(JSON.stringify({
    allPaths: inventory.allPaths,
    staged: [...inventory.staged].sort(),
    unstaged: [...inventory.unstaged].sort(),
    untracked: [...inventory.untracked].sort(),
    activeCleanFilters: [...inventory.activeCleanFilters].sort(),
    stagedCleanFilterChanges: [...inventory.stagedCleanFilterChanges].sort(),
    unprovenCleanFilterChanges: [...inventory.unprovenCleanFilterChanges].sort(),
    coreFileMode: inventory.coreFileMode,
    indexModes: [...inventory.indexModes].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    indexObjects: [...inventory.indexObjects].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    forcedExcluded: [...inventory.forcedExcluded].sort()
  }));
}

// git(1), GIT_ALTERNATE_OBJECT_DIRECTORIES, says entries beginning with `"`
// are C-style quoted. This mirrors Git's quote.c::quote_c_style named escapes
// and three-digit octal encoding so separators and arbitrary path bytes survive.
export function quoteGitAlternateObjectDirectory(directory) {
  const namedEscapes = new Map([
    [7, 'a'], [8, 'b'], [9, 't'], [10, 'n'], [11, 'v'], [12, 'f'], [13, 'r']
  ]);
  let quoted = '"';
  for (const byte of Buffer.from(directory)) {
    if (namedEscapes.has(byte)) quoted += `\\${namedEscapes.get(byte)}`;
    else if (byte === 34) quoted += '\\"';
    else if (byte === 92) quoted += '\\\\';
    else if (byte < 32 || byte >= 127) quoted += `\\${byte.toString(8).padStart(3, '0')}`;
    else quoted += String.fromCharCode(byte);
  }
  return `${quoted}"`;
}
