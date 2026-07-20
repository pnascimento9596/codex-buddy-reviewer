import path from 'node:path';

import { isProbablyText, normalizeRepoPath, pathPolicy } from './policy.mjs';
import { runProcess } from './process.mjs';

export const DEFAULT_MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

export class GitPathEncodingError extends Error {
  constructor() {
    super('Git pathname could not be decoded as lossless UTF-8; privacy capture is incomplete');
    this.name = 'GitPathEncodingError';
    this.code = 'GIT_PATH_ENCODING_INCOMPLETE';
    this.failureCode = 'git_path_encoding_invalid';
  }
}

export class GitPathParseError extends Error {
  constructor() {
    super('Git pathname output was malformed; privacy capture is incomplete');
    this.name = 'GitPathParseError';
    this.code = 'GIT_PATH_PARSE_INCOMPLETE';
    this.failureCode = 'git_path_parse_incomplete';
  }
}

export async function runGit(root, args, options = {}) {
  const budget = options.budget;
  budget?.chargeGitOperation();
  if (options.input !== undefined) {
    budget?.chargeGitInputBytes(Buffer.isBuffer(options.input)
      ? options.input.length
      : Buffer.byteLength(String(options.input), 'utf8'));
  }
  const timeoutMs = Math.min(options.timeoutMs ?? 30_000, budget?.remainingMs() ?? Number.MAX_SAFE_INTEGER);
  const result = await runProcess('git', ['-c', 'color.ui=false', '-c', 'color.diff=false', ...args], {
    cwd: root,
    input: options.input,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      GIT_OPTIONAL_LOCKS: '0'
    },
    timeoutMs,
    acceptedExitCodes: options.acceptedExitCodes ?? [0],
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_GIT_OUTPUT_BYTES,
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8'
  });
  const byteLength = (value) => Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value, 'utf8');
  budget?.chargeGitBytes(byteLength(result.stdout) + byteLength(result.stderr));
  return result;
}

function nullFields(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError('Git pathname output must be a Buffer');
  if (value.length === 0) return [];
  if (value.at(-1) !== 0) throw new GitPathParseError();
  const fields = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    if (index === start) throw new GitPathParseError();
    fields.push(value.subarray(start, index));
    start = index + 1;
  }
  return fields;
}

function decodeLosslessUtf8(value) {
  const decoded = value.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(value)) throw new GitPathEncodingError();
  return decoded;
}

export function splitNullUtf8(value) {
  return nullFields(value).map(decodeLosslessUtf8);
}

export function splitNull(value) {
  return splitNullUtf8(value).map(normalizeRepoPath);
}

function strictAscii(value) {
  if (!Buffer.isBuffer(value) || [...value].some((byte) => byte > 0x7f)) throw new GitPathParseError();
  return value.toString('ascii');
}

export function parseGitIndexEntries(value) {
  return nullFields(value).map((record) => {
    const tab = record.indexOf(0x09);
    if (tab <= 0 || tab === record.length - 1) throw new GitPathParseError();
    const metadata = strictAscii(record.subarray(0, tab));
    const match = metadata.match(/^(\d{6}) ([0-9a-f]+) ([0-3])$/);
    if (!match) throw new GitPathParseError();
    return Object.freeze({
      mode: match[1],
      objectId: match[2],
      stage: match[3],
      path: normalizeRepoPath(decodeLosslessUtf8(record.subarray(tab + 1)))
    });
  });
}

export function parseGitTreeEntry(value, expectedPath) {
  const fields = nullFields(value);
  if (fields.length === 0) return null;
  if (fields.length !== 1) throw new GitPathParseError();
  const record = fields[0];
  const tab = record.indexOf(0x09);
  if (tab <= 0 || tab === record.length - 1) throw new GitPathParseError();
  const metadata = strictAscii(record.subarray(0, tab));
  const match = metadata.match(/^(\d{6}) (blob|tree|commit) ([0-9a-f]+)$/);
  if (!match) throw new GitPathParseError();
  const repoPath = normalizeRepoPath(decodeLosslessUtf8(record.subarray(tab + 1)));
  if (expectedPath !== undefined && repoPath !== expectedPath) throw new GitPathParseError();
  return Object.freeze({ mode: match[1], type: match[2], objectId: match[3], path: repoPath });
}

export function parseGitNameStatus(value) {
  const fields = nullFields(value);
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = strictAscii(fields[index++]);
    if (!/^(?:[ACDMRTUXB]|[RC][0-9]{1,3})$/.test(status)) throw new GitPathParseError();
    const sourceBytes = fields[index++];
    if (!sourceBytes) throw new GitPathParseError();
    const source = normalizeRepoPath(decodeLosslessUtf8(sourceBytes));
    let destination = null;
    if (status.startsWith('R') || status.startsWith('C')) {
      const destinationBytes = fields[index++];
      if (!destinationBytes) throw new GitPathParseError();
      destination = normalizeRepoPath(decodeLosslessUtf8(destinationBytes));
    }
    entries.push(Object.freeze({ status, source, destination }));
  }
  return Object.freeze(entries);
}

export function literalPathspec(repoPath) {
  return `:(literal)${repoPath}`;
}

export function decodeSymlinkTarget(bytes) {
  const target = bytes.toString('utf8');
  return Buffer.from(target).equals(bytes) ? target : null;
}

export function countTextLines(content) {
  if (!isProbablyText(content)) return null;
  let lines = 0;
  for (const byte of content) {
    if (byte === 10) lines += 1;
  }
  if (content.length > 0 && content.at(-1) !== 10) lines += 1;
  return lines;
}

export function excludedRenameDestinations(raw) {
  const excluded = new Set();
  for (const { status, source, destination } of parseGitNameStatus(raw)) {
    if ((status.startsWith('R') || status.startsWith('C'))
        && destination && !pathPolicy(source).allowed) {
      excluded.add(destination);
    }
  }
  return excluded;
}

export function classifyPaths(allPaths, forcedExcluded = new Set()) {
  const allowed = [];
  const excluded = [];
  for (const repoPath of allPaths) {
    if (forcedExcluded.has(repoPath)) {
      excluded.push({ path: repoPath, reason: 'renamed from denied path' });
      continue;
    }
    const policy = pathPolicy(repoPath);
    if (policy.allowed) allowed.push(repoPath);
    else excluded.push({ path: repoPath, reason: policy.reason });
  }
  return { allowed, excluded };
}

export function symlinkTargetIsDenied(repoPath, target) {
  if (typeof target !== 'string' || !target || target.includes('\0')) return true;
  const normalizedTarget = normalizeRepoPath(target);
  if (path.posix.isAbsolute(normalizedTarget) || /^[A-Za-z]:[\\/]/.test(normalizedTarget)) return true;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), normalizedTarget));
  return !pathPolicy(resolved).allowed;
}

export async function workingInventory(root, options = {}) {
  const [staged, unstaged, untracked, stagedRenames, unstagedRenames] = await Promise.all([
    runGit(root, ['diff', '--name-only', '--no-renames', '-z', '--cached'], { ...options, encoding: null }),
    runGit(root, ['diff', '--name-only', '--no-renames', '-z'], { ...options, encoding: null }),
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], { ...options, encoding: null }),
    runGit(root, ['diff', '--name-status', '--find-renames', '--find-copies-harder', '-z', '--cached'], { ...options, encoding: null }),
    runGit(root, ['diff', '--name-status', '--find-renames', '--find-copies-harder', '-z'], { ...options, encoding: null })
  ]);
  const stagedPaths = splitNull(staged.stdout);
  const unstagedPaths = splitNull(unstaged.stdout);
  const untrackedPaths = splitNull(untracked.stdout);
  return {
    allPaths: [...new Set([...stagedPaths, ...unstagedPaths, ...untrackedPaths])].sort(),
    staged: new Set(stagedPaths),
    unstaged: new Set(unstagedPaths),
    untracked: new Set(untrackedPaths),
    forcedExcluded: new Set([
      ...excludedRenameDestinations(stagedRenames.stdout),
      ...excludedRenameDestinations(unstagedRenames.stdout)
    ])
  };
}
