#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveExternalExecutable } from '../src/executable.mjs';

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

export const PUBLICATION_LIMITS = Object.freeze({
  maxCommits: 50_000,
  maxFiles: 20_000,
  maxHistoryPathRecords: 250_000,
  maxRefs: 20_000,
  maxObjects: 100_000,
  maxBlobBytes: 16 * 1024 * 1024,
  maxTotalBlobBytes: 256 * 1024 * 1024,
  maxTextFileBytes: 2 * 1024 * 1024,
  maxTotalTextBytes: 64 * 1024 * 1024,
  maxMetadataObjectBytes: 2 * 1024 * 1024,
  maxTotalMetadataBytes: 64 * 1024 * 1024,
  maxGitOutputBytes: 32 * 1024 * 1024
});

const BINARY_EXTENSIONS = new Set([
  '.7z', '.a', '.avi', '.bin', '.bmp', '.bz2', '.class', '.db', '.dll', '.dylib',
  '.eot', '.exe', '.flac', '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.lib',
  '.mov', '.mp3', '.mp4', '.o', '.obj', '.otf', '.pdf', '.png', '.so', '.sqlite',
  '.sqlite3', '.tar', '.tif', '.tiff', '.ttf', '.wav', '.webm', '.webp', '.woff',
  '.woff2', '.xz', '.zip'
]);

const RUNTIME_PATH_SEGMENTS = new Set([
  '.buddy-review',
  '.codex-buddy',
  'automatic-reviews',
  'buddy-data',
  'buddy-runtime',
  'circuits',
  'outbox',
  'prompt-exports',
  'receipts',
  'renderers',
  'runtime-data',
  'turns'
]);

const CREDENTIAL_FILENAMES = new Set([
  '.env',
  '.envrc',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'auth.json',
  'auth.toml',
  'cookies.txt',
  'credentials.json',
  'credentials.yaml',
  'credentials.yml',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'oauth.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'service-account.json',
  'token.json'
]);

const CREDENTIAL_EXTENSIONS = new Set([
  '.der', '.jks', '.key', '.kdbx', '.p12', '.pfx', '.pkcs12', '.pem'
]);

const SENSITIVE_STATE_EXTENSIONS = new Set([
  '', '.conf', '.config', '.ini', '.json', '.jsonl', '.toml', '.txt', '.yaml', '.yml'
]);

const GITHUB_NOREPLY = /^(?:[0-9]+\+)?[A-Z0-9_.+\-[\]]+@users\.noreply\.github\.com$/i;
const EMAIL_ADDRESS = /[A-Z0-9._%+\-[\]]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi;
const NON_CONTINUABLE_METADATA_FIELDS = new Set([
  'tree', 'parent', 'author', 'committer', 'encoding', 'object', 'type', 'tag', 'tagger'
]);
const COMMIT_STRUCTURAL_FIELDS = new Set(['tree', 'parent', 'author', 'committer', 'encoding']);
const TAG_STRUCTURAL_FIELDS = new Set(['object', 'type', 'tag', 'tagger', 'encoding']);

export class PublicationBoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PublicationBoundaryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PublicationBoundaryError(code, message);
}

function strictUtf8(bytes, code = 'GIT_PATH_ENCODING_INVALID') {
  try {
    return fatalUtf8.decode(bytes);
  } catch {
    if (code === 'GIT_PATH_ENCODING_INVALID') {
      fail(code, 'Git contains a pathname that is not lossless UTF-8.');
    }
    if (code === 'GIT_METADATA_ENCODING_INVALID') {
      fail(code, 'Reachable Git metadata is not valid UTF-8.');
    }
    fail(code, 'A candidate text blob is not valid UTF-8.');
  }
}

function safePathId(repoPath) {
  return createHash('sha256').update(repoPath, 'utf8').digest('hex').slice(0, 12);
}

function nullRecords(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('GIT_OUTPUT_MALFORMED', 'Git returned an unexpected output type.');
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) fail('GIT_OUTPUT_MALFORMED', 'Git returned malformed NUL-delimited output.');
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) fail('GIT_OUTPUT_MALFORMED', 'Git returned an empty NUL-delimited record.');
    records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  return records;
}

function gitEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('GIT_')) env[name] = value;
  }
  return {
    ...env,
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C'
  };
}

function normalizedLimits(overrides = {}) {
  const limits = { ...PUBLICATION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  return Object.freeze(limits);
}

async function runGit(root, args, options = {}) {
  const maxBuffer = options.maxBuffer;
  try {
    const env = gitEnvironment();
    const executable = await resolveExternalExecutable('git', { cwd: root, env });
    return await new Promise((resolve, reject) => {
      const child = execFile(executable, [
        '-c', 'color.ui=false',
        '-c', 'core.fsmonitor=false',
        '-c', 'core.untrackedCache=false',
        ...args
      ], {
        cwd: root,
        encoding: null,
        env,
        maxBuffer,
        windowsHide: true
      }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
      child.once('error', reject);
      if (options.input === undefined) child.stdin.end();
      else child.stdin.end(options.input);
    });
  } catch (error) {
    if (error instanceof PublicationBoundaryError) throw error;
    if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      fail('WORK_LIMIT_EXCEEDED', 'Git output exceeded the publication scan work limit.');
    }
    fail('GIT_COMMAND_FAILED', 'A required read-only Git command failed.');
  }
}

function parsePositiveCount(bytes, label) {
  const value = strictUtf8(bytes, 'GIT_OUTPUT_MALFORMED').trim();
  if (!/^\d+$/.test(value)) fail('GIT_OUTPUT_MALFORMED', `Git returned a malformed ${label} count.`);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) fail('WORK_LIMIT_EXCEEDED', `${label} count exceeded the publication scan work limit.`);
  return count;
}

function validateRepoPath(repoPath) {
  if (!repoPath || repoPath.startsWith('/') || repoPath.includes('\0')) {
    fail('GIT_PATH_MALFORMED', 'Git contains a malformed tracked pathname.');
  }
  const parts = repoPath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail('GIT_PATH_MALFORMED', 'Git contains a malformed tracked pathname.');
  }
}

function isSensitivePath(repoPath) {
  const lower = repoPath.toLowerCase();
  const parts = lower.split('/');
  const basename = parts.at(-1);
  const extension = path.posix.extname(basename);

  if (parts.some((part) => RUNTIME_PATH_SEGMENTS.has(part))) return true;
  if (CREDENTIAL_FILENAMES.has(basename) || CREDENTIAL_EXTENSIONS.has(extension)) return true;
  if (basename.startsWith('.env.')
      && !['.env.example', '.env.sample', '.env.template'].includes(basename)) return true;
  const stem = extension ? basename.slice(0, -extension.length) : basename;
  return SENSITIVE_STATE_EXTENSIONS.has(extension)
    && (/^(?:credential|credentials|secret|secrets|token|tokens)(?:[._-]|$)/.test(stem)
      || /^(?:buddy|review|turn|session)[._-](?:receipt|state)(?:[._-]|$)/.test(stem));
}

function isRecognizedBinaryPath(repoPath) {
  return repoPath !== null && BINARY_EXTENSIONS.has(path.posix.extname(repoPath.toLowerCase()));
}

function parseIndexEntries(bytes) {
  const entries = [];
  for (const record of nullRecords(bytes)) {
    const tab = record.indexOf(0x09);
    if (tab <= 0 || tab === record.length - 1) {
      fail('GIT_OUTPUT_MALFORMED', 'Git returned a malformed index record.');
    }
    const metadata = strictUtf8(record.subarray(0, tab), 'GIT_OUTPUT_MALFORMED');
    const match = metadata.match(/^(100644|100755|120000|160000) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/);
    if (!match || match[3] !== '0') fail('GIT_OUTPUT_MALFORMED', 'Git index entries are malformed or unmerged.');
    if (match[1] === '120000') fail('UNSCANNED_SYMLINK', 'Tracked symbolic links are not accepted by the publication boundary.');
    if (match[1] === '160000') fail('UNSCANNED_GITLINK', 'Tracked Git links are not accepted by the publication boundary.');
    const repoPath = strictUtf8(record.subarray(tab + 1));
    validateRepoPath(repoPath);
    entries.push(Object.freeze({ mode: match[1], oid: match[2], path: repoPath }));
  }
  return entries;
}

function parseHistoryChanges(bytes, limits) {
  const records = nullRecords(bytes);
  if (records.length % 2 !== 0) fail('GIT_OUTPUT_MALFORMED', 'Git returned an incomplete history path record.');
  const paths = [];
  for (let index = 0; index < records.length; index += 2) {
    const metadata = strictUtf8(records[index], 'GIT_OUTPUT_MALFORMED');
    const match = metadata.match(/^:(000000|100644|100755|120000|160000) (000000|100644|100755|120000|160000) (?:[0-9a-f]{40}|[0-9a-f]{64}) (?:[0-9a-f]{40}|[0-9a-f]{64}) ([AMDTUXB])$/);
    if (!match) fail('GIT_OUTPUT_MALFORMED', 'Git returned a malformed history path record.');
    if (match[1] === '120000' || match[2] === '120000') {
      fail('UNSCANNED_SYMLINK', 'Reachable history contains a symbolic link.');
    }
    if (match[1] === '160000' || match[2] === '160000') {
      fail('UNSCANNED_GITLINK', 'Reachable history contains a Git link.');
    }
    const repoPath = strictUtf8(records[index + 1]);
    validateRepoPath(repoPath);
    if (isSensitivePath(repoPath)) {
      fail('SENSITIVE_TRACKED_PATH', `Reachable history contains a runtime, prompt, or credential path (path-id ${safePathId(repoPath)}).`);
    }
    paths.push(repoPath);
    if (paths.length > limits.maxHistoryPathRecords) {
      fail('WORK_LIMIT_EXCEEDED', 'Reachable history path count exceeded the publication scan work limit.');
    }
  }
  return paths.length;
}

function parseReachableObjects(bytes) {
  const objects = [];
  for (const record of nullRecords(bytes)) {
    if (record.length >= 5 && record.subarray(0, 5).equals(Buffer.from('path=', 'ascii'))) {
      const prior = objects.at(-1);
      if (!prior || prior.path !== null || record.length === 5) {
        fail('GIT_OUTPUT_MALFORMED', 'Git returned a malformed reachable object path.');
      }
      const repoPath = strictUtf8(record.subarray(5));
      validateRepoPath(repoPath);
      prior.path = repoPath;
      continue;
    }
    const separator = record.indexOf(0x20);
    const oidBytes = separator === -1 ? record : record.subarray(0, separator);
    const oid = strictUtf8(oidBytes, 'GIT_OUTPUT_MALFORMED');
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
      fail('GIT_OUTPUT_MALFORMED', 'Git returned a malformed reachable object record.');
    }
    let repoPath = null;
    if (separator !== -1) {
      if (separator === record.length - 1) fail('GIT_OUTPUT_MALFORMED', 'Git returned a malformed reachable object path.');
      repoPath = strictUtf8(record.subarray(separator + 1));
      validateRepoPath(repoPath);
    }
    objects.push({ oid, path: repoPath });
  }
  return objects.map((item) => Object.freeze(item));
}

function parseBatchCheck(bytes, expectedOids) {
  const text = strictUtf8(bytes, 'GIT_OUTPUT_MALFORMED');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (expectedOids.length === 0 && text.length === 0) return [];
  if (lines.length !== expectedOids.length) fail('GIT_OUTPUT_MALFORMED', 'Git returned incomplete object metadata.');
  return lines.map((line, index) => {
    const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64}) (blob|commit|tag|tree) (\d+)$/);
    if (!match || match[1] !== expectedOids[index]) fail('GIT_OUTPUT_MALFORMED', 'Git returned malformed object metadata.');
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size)) fail('WORK_LIMIT_EXCEEDED', 'A Git object is too large to scan safely.');
    return Object.freeze({ oid: match[1], type: match[2], size });
  });
}

function parseBatchObjects(bytes, expected) {
  const contents = [];
  let cursor = 0;
  for (const item of expected) {
    const newline = bytes.indexOf(0x0a, cursor);
    if (newline === -1 || newline - cursor > 200) fail('GIT_OUTPUT_MALFORMED', 'Git returned malformed object output.');
    const header = strictUtf8(bytes.subarray(cursor, newline), 'GIT_OUTPUT_MALFORMED');
    if (header !== `${item.oid} ${item.type} ${item.size}`) fail('GIT_OUTPUT_MALFORMED', 'Git returned unexpected object metadata.');
    const start = newline + 1;
    const end = start + item.size;
    if (end >= bytes.length || bytes[end] !== 0x0a) fail('GIT_OUTPUT_MALFORMED', 'Git returned incomplete object bytes.');
    contents.push(bytes.subarray(start, end));
    cursor = end + 1;
  }
  if (cursor !== bytes.length) fail('GIT_OUTPUT_MALFORMED', 'Git returned trailing object output.');
  return contents;
}

function pathTextViolation(text) {
  if (/(?:^|[^A-Za-z0-9_])\/(?:private\/)?(?:var\/folders)\/[A-Za-z0-9_./-]+/m.test(text)) return 'SCAN_TEMP_PATH';
  if (/(?:^|[^A-Za-z0-9_])\/tmp\/codex-security-scans-[A-Za-z0-9_.-]+/m.test(text)) return 'SCAN_TEMP_PATH';
  if (/(?:^|[^A-Za-z0-9_])\/Users\/[^/\s"'<>]+(?:\/|\b)/m.test(text)) return 'ABSOLUTE_USER_PATH';
  if (/(?:^|[^A-Za-z0-9_])\/home\/[^/\s"'<>]+(?:\/|\b)/m.test(text)) return 'ABSOLUTE_USER_PATH';
  if (/(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+(?:[\\/]|\b)/m.test(text)) return 'ABSOLUTE_USER_PATH';
  return null;
}

function isSafePublicationEmail(email, safeEmails) {
  const lower = email.toLowerCase();
  const domain = lower.slice(lower.lastIndexOf('@') + 1);
  return lower === 'noreply@github.com' || GITHUB_NOREPLY.test(email)
    || domain === 'invalid' || domain.endsWith('.invalid')
    || safeEmails.has(lower);
}

function emailTextViolation(text, safeEmails) {
  for (const match of text.matchAll(EMAIL_ADDRESS)) {
    if (!isSafePublicationEmail(match[0], safeEmails)) return 'UNSAFE_PUBLICATION_EMAIL';
  }
  return null;
}

function textViolation(text, safeEmails) {
  return emailTextViolation(text, safeEmails) ?? pathTextViolation(text);
}

function decodedMetadataVariants(text) {
  const variants = [text];
  let current = text;
  for (let pass = 0; pass < 4 && /%[0-9a-f]{2}/i.test(current); pass += 1) {
    const decoded = current.replace(/%([0-9a-f]{2})/gi, (_match, byte) => {
      const value = Number.parseInt(byte, 16);
      return value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : `%${byte}`;
    });
    if (decoded === current) break;
    variants.push(decoded);
    current = decoded;
  }
  return variants;
}

function metadataHasField(text, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_])['"]?${escaped}['"]?\\s*[:=]`, 'im').test(text);
}

function hasRuntimeReceiptShape(text) {
  const has = (field) => metadataHasField(text, field);
  return (has('review_key') && has('terminal_status')
      && (has('reviewer_runs') || has('content_expired_at') || has('delivery_state')))
    || (has('review_id') && has('repository_root')
      && (has('snapshot_sha256') || has('patch_hash') || has('captured_at')))
    || (has('review_id') && has('provider') && has('model') && has('prompt_version'))
    || (has('workspace_key') && has('event_id') && has('event_type'));
}

function metadataViolation(text, safeEmails) {
  for (const variant of decodedMetadataVariants(text)) {
    const pathViolation = pathTextViolation(variant);
    if (pathViolation) return pathViolation;
    const emailViolation = emailTextViolation(variant, safeEmails);
    if (emailViolation) return emailViolation;
    if (hasRuntimeReceiptShape(variant)) return 'RUNTIME_RECEIPT_CONTENT';
  }
  return null;
}

function isRuntimeReceiptJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false;
  const has = (name) => Object.hasOwn(value, name);
  return (has('review_key') && has('terminal_status')
      && (has('reviewer_runs') || has('content_expired_at') || has('delivery_state')))
    || (has('review_id') && has('repository_root')
      && (has('snapshot_sha256') || has('patch_hash') || has('captured_at')))
    || (has('review_id') && has('provider') && has('model') && has('prompt_version'))
    || (has('workspace_key') && has('event_id') && has('event_type'));
}

function validateSafeEmails(emails) {
  const normalized = new Set();
  for (const email of emails) {
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      throw new TypeError('safeEmails entries must be syntactically valid email addresses');
    }
    normalized.add(email.toLowerCase());
  }
  return normalized;
}

async function validateTopLevel(root, limits) {
  const resolvedRoot = await realpath(path.resolve(root));
  const { stdout } = await runGit(resolvedRoot, ['rev-parse', '--show-toplevel'], {
    maxBuffer: limits.maxGitOutputBytes
  });
  const reported = strictUtf8(stdout, 'GIT_OUTPUT_MALFORMED').replace(/[\r\n]+$/, '');
  let resolvedReported;
  try {
    resolvedReported = await realpath(reported);
  } catch {
    fail('GIT_TOP_LEVEL_INVALID', 'Git reported an inaccessible repository top level.');
  }
  if (resolvedRoot !== resolvedReported) {
    fail('GIT_TOP_LEVEL_REQUIRED', 'Run the publication boundary from the repository top level.');
  }
  return resolvedRoot;
}

async function validateClean(root, limits) {
  const { stdout } = await runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], {
    maxBuffer: limits.maxGitOutputBytes
  });
  if (stdout.length === 0) return;
  strictUtf8(stdout);
  fail('DIRTY_WORKTREE', 'The repository has tracked or untracked working-tree changes.');
}

async function validateReachableHistoryPaths(root, limits) {
  const { stdout } = await runGit(root, [
    'log', '--all', '--root', '--no-renames', '--no-abbrev',
    '--diff-merges=separate', '--format=', '--raw', '-z'
  ], {
    maxBuffer: limits.maxGitOutputBytes
  });
  return parseHistoryChanges(stdout, limits);
}

async function reachableCommitCount(root, limits) {
  const countResult = await runGit(root, ['rev-list', '--count', '--all'], {
    maxBuffer: limits.maxGitOutputBytes
  });
  const commitCount = parsePositiveCount(countResult.stdout, 'commit');
  if (commitCount === 0) fail('EMPTY_HISTORY', 'The publication repository must contain a commit.');
  if (commitCount > limits.maxCommits) fail('WORK_LIMIT_EXCEEDED', 'Commit history exceeded the publication scan work limit.');
  return commitCount;
}

async function validateRefNames(root, safeEmails, limits) {
  const { stdout } = await runGit(root, ['for-each-ref', '--format=%(refname)'], {
    maxBuffer: limits.maxGitOutputBytes
  });
  const text = strictUtf8(stdout, 'GIT_METADATA_ENCODING_INVALID');
  if (text.length === 0 || !text.endsWith('\n')) {
    fail('GIT_OUTPUT_MALFORMED', 'Git returned malformed reference metadata.');
  }
  const refs = text.slice(0, -1).split('\n');
  if (refs.length > limits.maxRefs) {
    fail('WORK_LIMIT_EXCEEDED', 'Reference count exceeded the publication scan work limit.');
  }
  for (const refName of refs) {
    if (!refName.startsWith('refs/')) fail('GIT_OUTPUT_MALFORMED', 'Git returned a malformed reference name.');
    validateRepoPath(refName);
    validateMetadataText(refName, safeEmails, 'A Git reference name');
    for (const variant of decodedMetadataVariants(refName)) {
      if (isSensitivePath(variant.replaceAll('\\', '/'))) {
        fail('SENSITIVE_REF_NAME', 'A Git reference name contains a runtime, prompt, receipt, or credential path.');
      }
    }
  }
  return refs.length;
}

async function validateCompleteHistory(root, limits) {
  const { stdout } = await runGit(root, ['rev-parse', '--is-shallow-repository'], {
    maxBuffer: limits.maxGitOutputBytes
  });
  const shallow = strictUtf8(stdout, 'GIT_OUTPUT_MALFORMED').trim();
  if (shallow !== 'true' && shallow !== 'false') {
    fail('GIT_OUTPUT_MALFORMED', 'Git returned malformed repository depth metadata.');
  }
  if (shallow === 'true') {
    fail('SHALLOW_HISTORY', 'A shallow repository cannot prove its complete publication history.');
  }
}

async function batchMetadata(root, objects, limits) {
  if (objects.length === 0) return [];
  const input = Buffer.from(`${objects.map((item) => item.oid).join('\n')}\n`, 'ascii');
  const { stdout } = await runGit(root, ['cat-file', '--batch-check'], {
    input,
    maxBuffer: limits.maxGitOutputBytes
  });
  return parseBatchCheck(stdout, objects.map((item) => item.oid));
}

function validateMetadataText(text, safeEmails, label) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    fail('GIT_METADATA_MALFORMED', `${label} contains unsupported control characters.`);
  }
  const violation = metadataViolation(text, safeEmails);
  if (violation) fail(violation, `${label} contains non-public data.`);
}

function identityFromHeader(lines, field) {
  const prefix = `${field} `;
  const matches = lines.filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) fail('GIT_METADATA_MALFORMED', `Reachable Git metadata has invalid ${field} identity fields.`);
  const match = matches[0].slice(prefix.length).match(/^(.+?) <([^<>]+)> (-?\d+) ([+-]\d{4})$/);
  if (!match || /[\u0000-\u001f\u007f-\u009f]/u.test(match[1])) {
    fail('GIT_METADATA_MALFORMED', `Reachable Git metadata has an invalid ${field} identity.`);
  }
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(match[2])) {
    fail('GIT_METADATA_MALFORMED', `Reachable Git metadata has an invalid ${field} email.`);
  }
  return Object.freeze({ name: match[1], email: match[2] });
}

function validateIdentity(identity, safeEmails, label) {
  validateMetadataText(identity.name, safeEmails, `${label} name`);
  if (!isSafePublicationEmail(identity.email, safeEmails)) {
    fail('UNSAFE_HISTORY_EMAIL', `${label} uses a non-public email that is not explicitly allowlisted.`);
  }
}

function parsedMetadataObject(bytes, type) {
  const separator = bytes.indexOf(Buffer.from('\n\n', 'ascii'));
  if (separator === -1) fail('GIT_METADATA_MALFORMED', `Reachable ${type} metadata has no header boundary.`);
  const headerText = strictUtf8(bytes.subarray(0, separator), 'GIT_METADATA_ENCODING_INVALID');
  const message = strictUtf8(bytes.subarray(separator + 2), 'GIT_METADATA_ENCODING_INVALID');
  const lines = headerText.split('\n');
  if (lines.some((line) => !line)) fail('GIT_METADATA_MALFORMED', `Reachable ${type} metadata contains an empty header.`);
  let currentField = null;
  for (const line of lines) {
    if (line.startsWith(' ')) {
      if (currentField === null || NON_CONTINUABLE_METADATA_FIELDS.has(currentField)) {
        fail('GIT_METADATA_MALFORMED', `Reachable ${type} metadata has an invalid continuation header.`);
      }
      continue;
    }
    const match = line.match(/^([^\s]+) (.*)$/);
    if (!match) fail('GIT_METADATA_MALFORMED', `Reachable ${type} metadata has a malformed header.`);
    currentField = match[1];
  }
  const encodings = lines.filter((line) => line.startsWith('encoding '));
  if (encodings.length > 1
      || (encodings.length === 1 && !/^encoding utf-?8$/i.test(encodings[0]))) {
    fail('GIT_METADATA_ENCODING_INVALID', `Reachable ${type} metadata declares a non-UTF-8 encoding.`);
  }
  return Object.freeze({ lines, message });
}

function exactTopLevelHeader(lines, field, valuePattern, type) {
  const prefix = `${field} `;
  const values = lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
  if (values.length !== 1 || !valuePattern.test(values[0])) {
    fail('GIT_METADATA_MALFORMED', `Reachable ${type} metadata has an invalid ${field} header.`);
  }
  return values[0];
}

function supplementalHeaderText(lines, structuralFields) {
  const selected = [];
  let includeContinuations = false;
  for (const line of lines) {
    if (line.startsWith(' ')) {
      if (includeContinuations) selected.push(line);
      continue;
    }
    const field = line.slice(0, line.indexOf(' ') === -1 ? line.length : line.indexOf(' '));
    includeContinuations = !structuralFields.has(field);
    if (includeContinuations) selected.push(line);
  }
  return selected.join('\n');
}

function validateCommitMetadata(bytes, safeEmails) {
  const metadata = parsedMetadataObject(bytes, 'commit');
  exactTopLevelHeader(metadata.lines, 'tree', /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'commit');
  for (const parent of metadata.lines.filter((line) => line.startsWith('parent '))) {
    if (!/^parent (?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parent)) {
      fail('GIT_METADATA_MALFORMED', 'Reachable commit metadata has an invalid parent header.');
    }
  }
  validateIdentity(identityFromHeader(metadata.lines, 'author'), safeEmails, 'Commit author');
  validateIdentity(identityFromHeader(metadata.lines, 'committer'), safeEmails, 'Commit committer');
  validateMetadataText(
    supplementalHeaderText(metadata.lines, COMMIT_STRUCTURAL_FIELDS),
    safeEmails,
    'Commit supplemental headers'
  );
  validateMetadataText(metadata.message, safeEmails, 'A commit message');
}

function validateTagMetadata(bytes, safeEmails) {
  const metadata = parsedMetadataObject(bytes, 'tag');
  exactTopLevelHeader(metadata.lines, 'object', /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'tag');
  exactTopLevelHeader(metadata.lines, 'type', /^(?:blob|commit|tag|tree)$/, 'tag');
  const tagNames = metadata.lines.filter((line) => line.startsWith('tag '));
  if (tagNames.length !== 1 || tagNames[0].length === 4) {
    fail('GIT_METADATA_MALFORMED', 'Reachable annotated-tag metadata has an invalid tag name.');
  }
  validateMetadataText(tagNames[0].slice(4), safeEmails, 'An annotated tag name');
  validateIdentity(identityFromHeader(metadata.lines, 'tagger'), safeEmails, 'Annotated tagger');
  validateMetadataText(
    supplementalHeaderText(metadata.lines, TAG_STRUCTURAL_FIELDS),
    safeEmails,
    'Annotated tag supplemental headers'
  );
  validateMetadataText(metadata.message, safeEmails, 'An annotated tag message');
}

async function scanMetadataCandidates(root, candidates, safeEmails, expectedCommitCount, limits) {
  let totalBytes = 0;
  for (const item of candidates) {
    if (item.size > limits.maxMetadataObjectBytes) {
      fail('WORK_LIMIT_EXCEEDED', 'A reachable metadata object exceeded the per-object publication scan limit.');
    }
    totalBytes += item.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalMetadataBytes) {
      fail('WORK_LIMIT_EXCEEDED', 'Reachable metadata exceeded the total publication scan limit.');
    }
  }

  const batches = [];
  let batch = [];
  let batchBytes = 0;
  for (const item of candidates) {
    const itemOutputBytes = item.size + 201;
    if (itemOutputBytes > limits.maxGitOutputBytes) {
      fail('WORK_LIMIT_EXCEEDED', 'A metadata object cannot fit inside the bounded Git output buffer.');
    }
    if (batch.length > 0 && batchBytes + itemOutputBytes > limits.maxGitOutputBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(item);
    batchBytes += itemOutputBytes;
  }
  if (batch.length > 0) batches.push(batch);

  let commitsScanned = 0;
  let tagsScanned = 0;
  for (const items of batches) {
    const input = Buffer.from(`${items.map((item) => item.oid).join('\n')}\n`, 'ascii');
    const outputLimit = Math.min(
      limits.maxGitOutputBytes,
      items.reduce((sum, item) => sum + item.size + 200, 1)
    );
    const { stdout } = await runGit(root, ['cat-file', '--batch'], { input, maxBuffer: outputLimit });
    const contents = parseBatchObjects(stdout, items);
    for (let index = 0; index < items.length; index += 1) {
      if (items[index].type === 'commit') {
        validateCommitMetadata(contents[index], safeEmails);
        commitsScanned += 1;
      } else if (items[index].type === 'tag') {
        validateTagMetadata(contents[index], safeEmails);
        tagsScanned += 1;
      } else {
        fail('GIT_OUTPUT_MALFORMED', 'The metadata scan received an unsupported Git object type.');
      }
    }
  }
  if (commitsScanned !== expectedCommitCount) {
    fail('GIT_OUTPUT_MALFORMED', 'Reachable commit metadata coverage is incomplete.');
  }
  return Object.freeze({ commitsScanned, tagsScanned, bytesScanned: totalBytes });
}

async function scanBlobCandidates(root, candidates, safeEmails, limits) {
  const scannable = candidates;
  if (scannable.length > limits.maxFiles) fail('WORK_LIMIT_EXCEEDED', 'Blob candidate count exceeded the publication scan work limit.');
  let totalBlobBytes = 0;
  for (const item of scannable) {
    if (item.size > limits.maxBlobBytes) fail('WORK_LIMIT_EXCEEDED', 'A blob exceeded the per-file publication scan limit.');
    totalBlobBytes += item.size;
    if (!Number.isSafeInteger(totalBlobBytes) || totalBlobBytes > limits.maxTotalBlobBytes) {
      fail('WORK_LIMIT_EXCEEDED', 'Reachable blobs exceeded the total publication scan limit.');
    }
  }

  const batches = [];
  let batch = [];
  let batchBytes = 0;
  for (const item of scannable) {
    const itemOutputBytes = item.size + 201;
    if (itemOutputBytes > limits.maxGitOutputBytes) {
      fail('WORK_LIMIT_EXCEEDED', 'A blob cannot fit inside the bounded Git output buffer.');
    }
    if (batch.length > 0 && batchBytes + itemOutputBytes > limits.maxGitOutputBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(item);
    batchBytes += itemOutputBytes;
  }
  if (batch.length > 0) batches.push(batch);

  let totalBytes = 0;
  if (scannable.length === 0) return { textFilesScanned: 0, textBytesScanned: 0 };
  let textFilesScanned = 0;
  let textBytesScanned = 0;
  for (const items of batches) {
    const input = Buffer.from(`${items.map((item) => item.oid).join('\n')}\n`, 'ascii');
    const outputLimit = Math.min(
      limits.maxGitOutputBytes,
      items.reduce((sum, item) => sum + item.size + 200, 1)
    );
    const { stdout } = await runGit(root, ['cat-file', '--batch'], { input, maxBuffer: outputLimit });
    const blobs = parseBatchObjects(stdout, items.map((item) => ({ ...item, type: 'blob' })));
    for (let index = 0; index < blobs.length; index += 1) {
      const bytes = blobs[index];
      const rawViolation = pathTextViolation(bytes.toString('latin1'));
      if (rawViolation) {
        const id = items[index].path === null ? 'unattributed' : safePathId(items[index].path);
        fail(rawViolation, `A tracked blob contains non-public data (path-id ${id}).`);
      }
      if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) continue;
      let text;
      try {
        text = fatalUtf8.decode(bytes);
      } catch {
        if (isRecognizedBinaryPath(items[index].path)) continue;
        fail('TEXT_ENCODING_AMBIGUOUS', 'A candidate text blob is not valid UTF-8.');
      }
      const decodedViolation = textViolation(text, safeEmails);
      if (decodedViolation) {
        const id = items[index].path === null ? 'unattributed' : safePathId(items[index].path);
        fail(decodedViolation, `A tracked blob contains non-public data (path-id ${id}).`);
      }
      if (isRuntimeReceiptJson(text)) {
        const id = items[index].path === null ? 'unattributed' : safePathId(items[index].path);
        fail('RUNTIME_RECEIPT_CONTENT', `A tracked blob contains runtime receipt data (path-id ${id}).`);
      }
      if (isRecognizedBinaryPath(items[index].path)) continue;
      if (bytes.length > limits.maxTextFileBytes) {
        fail('WORK_LIMIT_EXCEEDED', 'A text candidate exceeded the per-file publication scan limit.');
      }
      totalBytes += bytes.length;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalTextBytes) {
        fail('WORK_LIMIT_EXCEEDED', 'Text candidates exceeded the total publication scan limit.');
      }
      textFilesScanned += 1;
      textBytesScanned += bytes.length;
    }
  }
  return { textFilesScanned, textBytesScanned };
}

async function currentIndex(root, limits) {
  const { stdout } = await runGit(root, ['ls-files', '--stage', '-z'], {
    maxBuffer: limits.maxGitOutputBytes
  });
  const entries = parseIndexEntries(stdout);
  if (entries.length > limits.maxFiles) fail('WORK_LIMIT_EXCEEDED', 'Tracked file count exceeded the publication scan work limit.');
  for (const entry of entries) {
    if (isSensitivePath(entry.path)) {
      fail('SENSITIVE_TRACKED_PATH', `A runtime, prompt, or credential path is tracked (path-id ${safePathId(entry.path)}).`);
    }
  }
  return entries;
}

function uniqueIndexBlobs(entries) {
  const byOid = new Map();
  for (const entry of entries) {
    const existing = byOid.get(entry.oid);
    if (!existing || (isRecognizedBinaryPath(existing.path) && !isRecognizedBinaryPath(entry.path))) {
      byOid.set(entry.oid, { oid: entry.oid, path: entry.path, size: null });
    }
  }
  return [...byOid.values()];
}

async function treeCandidates(root, entries, limits) {
  const blobs = uniqueIndexBlobs(entries);
  const metadata = await batchMetadata(root, blobs, limits);
  return blobs.map((blob, index) => {
    if (metadata[index].type !== 'blob') fail('GIT_OUTPUT_MALFORMED', 'A tracked index object is not a blob.');
    return Object.freeze({ ...blob, size: metadata[index].size });
  });
}

async function historyCandidates(root, limits) {
  const { stdout } = await runGit(root, ['rev-list', '--objects', '-z', '--all'], {
    maxBuffer: limits.maxGitOutputBytes
  });
  const listed = parseReachableObjects(stdout);
  if (listed.length > limits.maxObjects) fail('WORK_LIMIT_EXCEEDED', 'Reachable object count exceeded the publication scan work limit.');
  const unique = [];
  const indexByOid = new Map();
  for (const item of listed) {
    const prior = indexByOid.get(item.oid);
    if (prior === undefined) {
      indexByOid.set(item.oid, unique.length);
      unique.push({ ...item });
    } else if ((unique[prior].path === null && item.path !== null)
        || (isRecognizedBinaryPath(unique[prior].path) && !isRecognizedBinaryPath(item.path))) {
      unique[prior].path = item.path;
    }
  }
  const metadata = await batchMetadata(root, unique, limits);
  const blobs = [];
  const historyMetadata = [];
  for (let index = 0; index < unique.length; index += 1) {
    if (metadata[index].type === 'blob') {
      blobs.push(Object.freeze({ ...unique[index], size: metadata[index].size }));
    } else if (metadata[index].type === 'commit' || metadata[index].type === 'tag') {
      historyMetadata.push(Object.freeze({
        oid: unique[index].oid,
        type: metadata[index].type,
        size: metadata[index].size
      }));
    }
  }
  if (blobs.length > limits.maxFiles) fail('WORK_LIMIT_EXCEEDED', 'Reachable blob count exceeded the publication scan work limit.');
  return { objects: unique.length, blobs, metadata: historyMetadata };
}

export async function checkPublicationBoundary(options = {}) {
  const limits = normalizedLimits(options.limits);
  const treeOnly = options.treeOnly === true;
  const safeEmails = validateSafeEmails(options.safeEmails ?? []);
  const root = await validateTopLevel(options.root ?? process.cwd(), limits);
  if (!treeOnly) await validateClean(root, limits);
  const entries = await currentIndex(root, limits);

  let commitCount = null;
  let refCount = null;
  let objectCount = null;
  let metadataScan = null;
  let candidates;
  if (treeOnly) {
    candidates = await treeCandidates(root, entries, limits);
  } else {
    await validateCompleteHistory(root, limits);
    commitCount = await reachableCommitCount(root, limits);
    refCount = await validateRefNames(root, safeEmails, limits);
    await validateReachableHistoryPaths(root, limits);
    const history = await historyCandidates(root, limits);
    objectCount = history.objects;
    candidates = history.blobs;
    metadataScan = await scanMetadataCandidates(
      root,
      history.metadata,
      safeEmails,
      commitCount,
      limits
    );
  }
  const scan = await scanBlobCandidates(root, candidates, safeEmails, limits);
  return Object.freeze({
    ok: true,
    mode: treeOnly ? 'tree-only' : 'history',
    tracked_files: entries.length,
    reachable_commits: commitCount,
    reachable_refs: refCount,
    reachable_objects: objectCount,
    annotated_tags_scanned: metadataScan?.tagsScanned ?? null,
    metadata_bytes_scanned: metadataScan?.bytesScanned ?? null,
    candidate_blobs: candidates.length,
    text_files_scanned: scan.textFilesScanned,
    text_bytes_scanned: scan.textBytesScanned
  });
}

function usage() {
  return `Usage: node scripts/check-publication-boundary.mjs [options]

Options:
  --tree-only              Scan the exact stage-0 index; ignore history and worktree-only bytes
  --allow-email <address>  Allow one reviewed public contributor address; repeat as needed
  --json                   Print the successful result as JSON
  --help                   Show this help
`;
}

function parseArguments(argv) {
  const options = { safeEmails: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--tree-only') options.treeOnly = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help') options.help = true;
    else if (argument === '--allow-email') {
      const value = argv[++index];
      if (!value) fail('ARGUMENT_INVALID', '--allow-email requires an address.');
      options.safeEmails.push(value);
    } else fail('ARGUMENT_INVALID', 'Unknown publication boundary argument.');
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await checkPublicationBoundary(options);
  process.stdout.write(options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `Publication boundary passed (${result.mode}, ${result.text_files_scanned} text blobs scanned).\n`);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    const code = error instanceof PublicationBoundaryError ? error.code : 'UNEXPECTED_FAILURE';
    const message = error instanceof PublicationBoundaryError
      ? error.message
      : 'The publication boundary failed unexpectedly.';
    process.stderr.write(`Publication boundary failed [${code}]: ${message}\n`);
    process.exitCode = 1;
  });
}
