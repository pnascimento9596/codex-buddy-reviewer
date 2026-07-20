import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';

import { isProbablyText } from '../../src/policy.mjs';
import { scanSecretMaterial } from '../../src/secret-scan.mjs';
import { resolveExternalExecutable } from '../../src/executable.mjs';
import { verifyPublicPlugin } from './public-release.mjs';

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SEMVER_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028-\u202E\u2066-\u2069]/u;
const PERSONAL_PATH_PATTERNS = Object.freeze([
  /(?:^|[^0-9A-Za-z])\/Users\/[^/\s"'`<>]+(?:\/|$)/u,
  /(?:^|[^0-9A-Za-z])\/home\/[^/\s"'`<>]+(?:\/|$)/u,
  /(?:^|[^0-9A-Za-z])[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`<>]+(?:[\\/]|$)/u,
  /(?:^|[^0-9A-Za-z])\/(?:private\/)?var\/folders\//u
]);
const SECRET_SCANNER_SELF_REFERENCE = [
  '      pass',
  'word = decodeURI',
  'Component(match[2]);'
].join('');

export const DISTRIBUTION_BRANCH_REF = 'refs/heads/distribution';
export const DISTRIBUTION_IDENTITY = Object.freeze({
  name: 'Codex Buddy Release Bot',
  email: 'codex-buddy-release-bot@users.noreply.github.com'
});

export const DISTRIBUTION_RECEIPT_FIELDS = Object.freeze([
  'schema_version',
  'branch_ref',
  'tag',
  'tag_ref',
  'tag_object',
  'commit',
  'tree',
  'version',
  'source_commit',
  'source_commit_epoch',
  'release_manifest_sha256',
  'artifact_content_sha256',
  'file_count'
]);

export function publicDistributionReceipt(result) {
  if (!result || typeof result !== 'object') fail('verified distribution result is required');
  return Object.freeze(Object.fromEntries(
    DISTRIBUTION_RECEIPT_FIELDS.map((field) => [field, result[field]])
  ));
}

function fail(message) {
  throw new Error(`Buddy distribution commit: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertSafePathArgument(value, label) {
  if (typeof value !== 'string' || !value) fail(`${label} is required`);
  if (CONTROL_PATTERN.test(value)) fail(`${label} contains terminal control characters`);
  return value;
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\')
      || path.posix.isAbsolute(value) || CONTROL_PATTERN.test(value)) {
    fail(`${label} must be a safe POSIX relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail(`${label} contains an unsafe path segment`);
  }
  return value;
}

async function detailsOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function resolveNewDirectory(target, label) {
  const requested = path.resolve(assertSafePathArgument(target, label));
  if (await detailsOrNull(requested)) fail(`${label} must not already exist`);
  const requestedParent = path.dirname(requested);
  const parentDetails = await detailsOrNull(requestedParent);
  if (!parentDetails?.isDirectory() || parentDetails.isSymbolicLink()) {
    fail(`${label} parent must be an existing regular directory`);
  }
  const parent = await realpath(requestedParent);
  return path.join(parent, path.basename(requested));
}

function isNested(ancestor, candidate) {
  const relative = path.relative(ancestor, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function collectRegularFiles(root, relative = '', records = []) {
  const directory = relative
    ? path.join(root, ...relative.split('/'))
    : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    safeRelative(childRelative, 'artifact path');
    const target = path.join(directory, entry.name);
    const details = await lstat(target);
    if (details.isSymbolicLink()) fail(`artifact contains a symlink: ${childRelative}`);
    if (details.isDirectory()) {
      await collectRegularFiles(root, childRelative, records);
      continue;
    }
    if (!details.isFile()) fail(`artifact contains a non-regular entry: ${childRelative}`);
    const bytes = await readFile(target);
    records.push(Object.freeze({
      path: childRelative,
      absolute: target,
      bytes,
      sha256: sha256(bytes)
    }));
  }
  return records;
}

async function collectDistributionWorktreeFiles(root, relative = '', records = []) {
  const directory = relative
    ? path.join(root, ...relative.split('/'))
    : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    if (!relative && entry.name === '.git') continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    safeRelative(childRelative, 'distribution worktree path');
    const target = path.join(directory, entry.name);
    const details = await lstat(target);
    if (details.isSymbolicLink()) fail(`distribution worktree contains a symlink: ${childRelative}`);
    if (details.isDirectory()) {
      await collectDistributionWorktreeFiles(root, childRelative, records);
      continue;
    }
    if (!details.isFile()) {
      fail(`distribution worktree contains a non-regular entry: ${childRelative}`);
    }
    const bytes = await readFile(target);
    records.push(Object.freeze({ path: childRelative, bytes }));
  }
  return records;
}

function containsPersonalPath(text) {
  return PERSONAL_PATH_PATTERNS.some((pattern) => pattern.test(text));
}

function credentialScanBytes(record) {
  if (record.path !== 'src/secret-scan.mjs') return record.bytes;
  const text = record.bytes.toString('utf8');
  const lines = text.split('\n');
  const matches = lines.filter((line) => line === SECRET_SCANNER_SELF_REFERENCE).length;
  if (matches !== 1) fail('secret scanner self-reference exemption does not match exactly once');
  return Buffer.from(lines.filter((line) => line !== SECRET_SCANNER_SELF_REFERENCE).join('\n'), 'utf8');
}

export async function auditDistributionArtifact(artifactRoot) {
  const root = await realpath(path.resolve(assertSafePathArgument(artifactRoot, 'artifact')));
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    fail('artifact must be a regular directory');
  }
  const records = await collectRegularFiles(root);
  if (records.length < 1) fail('artifact must contain at least one file');
  records.sort((left, right) => compareUtf8(left.path, right.path));
  for (const record of records) {
    if (containsPersonalPath(record.path)) {
      fail(`artifact path contains a personal filesystem path: ${record.path}`);
    }
    if (!isProbablyText(record.bytes)) continue;
    const scan = scanSecretMaterial(credentialScanBytes(record));
    if (!scan.complete) fail(`credential scan is incomplete for ${record.path}`);
    if (scan.detected) fail(`credential-shaped material detected in ${record.path}`);
    const text = record.bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(record.bytes)) {
      fail(`text artifact is not valid UTF-8: ${record.path}`);
    }
    if (containsPersonalPath(text)) {
      fail(`personal filesystem path detected in ${record.path}`);
    }
  }
  const digestInput = records.map((record) => (
    `${record.path}\0${record.bytes.length}\0${record.sha256}\n`
  )).join('');
  return Object.freeze({
    root,
    records: Object.freeze(records),
    content_sha256: sha256(Buffer.from(digestInput, 'utf8'))
  });
}

function sanitizedGitEnvironment(repository, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_') && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(repository, '.buddy-no-global-gitconfig'),
    ...extra
  };
}

async function runGit(executable, args, {
  cwd,
  repository,
  input,
  extraEnv,
  maxOutputBytes = 64 * 1024 * 1024
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: sanitizedGitEnvironment(repository, extraEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const collect = (destination) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(new Error('Git output exceeded its local validation budget'));
        return;
      }
      destination.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (code !== 0) {
        finish(new Error(`Git command failed with status ${String(code)} and signal ${String(signal)}`));
        return;
      }
      finish(null, {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      });
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Git command exceeded its local validation deadline'));
    }, 30_000);
    timer.unref?.();
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

async function gitText(executable, args, options) {
  const result = await runGit(executable, args, options);
  const text = result.stdout.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(result.stdout)) fail('Git returned invalid UTF-8 metadata');
  return text;
}

function releaseTag(version) {
  if (!SEMVER_PATTERN.test(version)) fail('artifact version must be canonical SemVer');
  return `v${version}`;
}

function commitMessage(metadata) {
  return [
    `Codex Buddy Reviewer artifact ${metadata.version}`,
    '',
    `Source-Commit: ${metadata.sourceCommit}`,
    `Release-Manifest-SHA256: ${metadata.releaseManifestSha256}`,
    `Artifact-Content-SHA256: ${metadata.artifactContentSha256}`
  ].join('\n');
}

function tagMessage(metadata) {
  return [
    `Codex Buddy Reviewer ${metadata.version}`,
    '',
    'This tag resolves to the verified artifact-only distribution commit.',
    `Source-Commit: ${metadata.sourceCommit}`,
    `Release-Manifest-SHA256: ${metadata.releaseManifestSha256}`,
    `Artifact-Content-SHA256: ${metadata.artifactContentSha256}`,
    `Distribution-Tree: ${metadata.tree}`
  ].join('\n');
}

async function sourceCommitEpoch(executable, policyRoot, sourceCommit, repository) {
  const text = await gitText(executable, [
    'show', '--no-patch', '--format=%ct', sourceCommit
  ], {
    cwd: policyRoot,
    repository
  });
  const value = text.trim();
  if (!/^(?:0|[1-9][0-9]{0,11})$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    fail('trusted source commit has an invalid timestamp');
  }
  return value;
}

async function copyArtifact(records, destination) {
  for (const record of records) {
    const target = path.join(destination, ...record.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, record.bytes, { flag: 'wx', mode: 0o644 });
    if (process.platform !== 'win32') await chmod(target, 0o644);
  }
}

function parseLsTree(bytes, label) {
  const records = [];
  const end = bytes.at(-1) === 0 ? bytes.length - 1 : bytes.length;
  for (const raw of bytes.subarray(0, end).toString('binary').split('\0')) {
    if (!raw) continue;
    const record = Buffer.from(raw, 'binary');
    const tab = record.indexOf(0x09);
    if (tab < 0) fail(`${label} returned malformed metadata`);
    const metadata = record.subarray(0, tab).toString('ascii').split(' ');
    if (metadata.length !== 3) fail(`${label} returned malformed object metadata`);
    const pathBytes = record.subarray(tab + 1);
    const relative = pathBytes.toString('utf8');
    if (!Buffer.from(relative, 'utf8').equals(pathBytes)) fail(`${label} returned a non-UTF-8 path`);
    safeRelative(relative, `${label} path`);
    records.push({ mode: metadata[0], type: metadata[1], oid: metadata[2], path: relative });
  }
  return records;
}

function parseIndex(bytes) {
  const records = [];
  const end = bytes.at(-1) === 0 ? bytes.length - 1 : bytes.length;
  for (const raw of bytes.subarray(0, end).toString('binary').split('\0')) {
    if (!raw) continue;
    const record = Buffer.from(raw, 'binary');
    const tab = record.indexOf(0x09);
    if (tab < 0) fail('Git index returned malformed metadata');
    const metadata = record.subarray(0, tab).toString('ascii').split(' ');
    if (metadata.length !== 3) fail('Git index returned malformed object metadata');
    const pathBytes = record.subarray(tab + 1);
    const relative = pathBytes.toString('utf8');
    if (!Buffer.from(relative, 'utf8').equals(pathBytes)) fail('Git index returned a non-UTF-8 path');
    safeRelative(relative, 'Git index path');
    records.push({ mode: metadata[0], oid: metadata[1], stage: metadata[2], path: relative });
  }
  return records;
}

async function assertNoAlternateHistory(repository) {
  for (const relative of [
    'shallow',
    'commondir',
    'info/grafts',
    'objects/info/alternates',
    'objects/info/http-alternates'
  ]) {
    if (await detailsOrNull(path.join(repository, '.git', ...relative.split('/')))) {
      fail(`distribution repository contains forbidden Git history metadata: ${relative}`);
    }
  }
}

async function collectGitAdministrativeFiles(gitRoot, relative = '', records = []) {
  const directory = relative
    ? path.join(gitRoot, ...relative.split('/'))
    : gitRoot;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    safeRelative(childRelative, 'Git administrative path');
    const target = path.join(directory, entry.name);
    const details = await lstat(target);
    if (details.isSymbolicLink()) fail(`Git administrative metadata contains a symlink: ${childRelative}`);
    if (details.isDirectory()) {
      await collectGitAdministrativeFiles(gitRoot, childRelative, records);
      continue;
    }
    if (!details.isFile()) {
      fail(`Git administrative metadata contains a non-regular entry: ${childRelative}`);
    }
    records.push(childRelative);
  }
  return records;
}

async function assertExactGitAdministrativeFiles(repository, tag, expectedObjects) {
  const expected = new Set([
    'HEAD',
    'config',
    'index',
    'refs/heads/distribution',
    `refs/tags/${tag}`,
    ...[...expectedObjects.keys()].map((oid) => `objects/${oid.slice(0, 2)}/${oid.slice(2)}`)
  ]);
  const actual = await collectGitAdministrativeFiles(path.join(repository, '.git'));
  if (actual.length !== expected.size || actual.some((relative) => !expected.has(relative))) {
    fail('distribution repository contains unexpected Git administrative metadata');
  }
}

function expectedCommitText(tree, epoch, message) {
  return [
    `tree ${tree}`,
    `author ${DISTRIBUTION_IDENTITY.name} <${DISTRIBUTION_IDENTITY.email}> ${epoch} +0000`,
    `committer ${DISTRIBUTION_IDENTITY.name} <${DISTRIBUTION_IDENTITY.email}> ${epoch} +0000`,
    '',
    message,
    ''
  ].join('\n');
}

function expectedTagText(commit, tag, epoch, message) {
  return [
    `object ${commit}`,
    'type commit',
    `tag ${tag}`,
    `tagger ${DISTRIBUTION_IDENTITY.name} <${DISTRIBUTION_IDENTITY.email}> ${epoch} +0000`,
    '',
    message,
    ''
  ].join('\n');
}

async function assertLocalConfig(executable, repository) {
  const allowed = new Set([
    'core.repositoryformatversion',
    'core.filemode',
    'core.bare',
    'core.logallrefupdates',
    'core.ignorecase',
    'core.precomposeunicode',
    'core.symlinks'
  ]);
  const text = await gitText(executable, ['config', '--local', '--name-only', '--list'], {
    cwd: repository,
    repository
  });
  const keys = text.trim() ? text.trim().split('\n') : [];
  if (keys.some((key) => !allowed.has(key.toLowerCase()))) {
    fail('distribution repository contains unsupported local Git configuration');
  }
  const expected = new Map([
    ['core.repositoryformatversion', new Set(['0'])],
    ['core.filemode', new Set(['true', 'false'])],
    ['core.bare', new Set(['false'])],
    ['core.logallrefupdates', new Set(['false'])],
    ['core.ignorecase', new Set(['true', 'false'])],
    ['core.precomposeunicode', new Set(['true', 'false'])],
    ['core.symlinks', new Set(['true', 'false'])]
  ]);
  for (const [key, accepted] of expected) {
    if (!keys.some((candidate) => candidate.toLowerCase() === key)) {
      if (['core.ignorecase', 'core.precomposeunicode', 'core.symlinks'].includes(key)) continue;
      fail(`distribution repository is missing required Git configuration ${key}`);
    }
    const valuesText = await gitText(executable, ['config', '--local', '--get-all', key], {
      cwd: repository,
      repository
    });
    const values = valuesText.trim().split('\n');
    if (values.length !== 1 || !accepted.has(values[0].toLowerCase())) {
      fail(`distribution repository has invalid Git configuration ${key}`);
    }
  }
  const configBytes = await readFile(path.join(repository, '.git', 'config'));
  if (!isProbablyText(configBytes)) fail('distribution Git configuration must be text');
  const configScan = scanSecretMaterial(configBytes);
  if (!configScan.complete || configScan.detected
      || containsPersonalPath(configBytes.toString('utf8'))) {
    fail('distribution Git configuration contains private material');
  }
  const remotes = await gitText(executable, ['remote'], { cwd: repository, repository });
  if (remotes !== '') fail('distribution repository must not configure a remote');
}

async function expectedObjectInventory(executable, repository, commit, tagObject, rootTree) {
  const result = await runGit(executable, [
    'ls-tree', '-r', '-t', '-z', '--full-tree', commit
  ], {
    cwd: repository,
    repository
  });
  const entries = parseLsTree(result.stdout, 'Git tree inventory');
  const expected = new Map([
    [commit, 'commit'],
    [tagObject, 'tag'],
    [rootTree, 'tree']
  ]);
  for (const entry of entries) expected.set(entry.oid, entry.type);
  return expected;
}

async function assertExactObjectInventory(executable, repository, expected) {
  const text = await gitText(executable, [
    'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'
  ], {
    cwd: repository,
    repository
  });
  const actual = new Map();
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const [oid, type, ...extra] = line.split(' ');
    if (extra.length || !SHA1_PATTERN.test(oid) || !['blob', 'tree', 'commit', 'tag'].includes(type)) {
      fail('distribution object database contains malformed metadata');
    }
    actual.set(oid, type);
  }
  if (actual.size !== expected.size
      || [...expected].some(([oid, type]) => actual.get(oid) !== type)) {
    fail('distribution object database contains inherited or unreachable objects');
  }
}

export async function verifyDistributionRepository({
  artifact,
  repository,
  policyRoot
}) {
  assertSafePathArgument(artifact, 'artifact');
  assertSafePathArgument(repository, 'repository');
  assertSafePathArgument(policyRoot, 'policyRoot');
  const verified = await verifyPublicPlugin({ input: artifact, policyRoot });
  const audited = await auditDistributionArtifact(verified.artifact_root);
  const root = await realpath(path.resolve(repository));
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    fail('repository must be a regular directory');
  }
  const gitDirectory = await lstat(path.join(root, '.git'));
  if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) {
    fail('repository must contain a private regular .git directory');
  }
  const executable = await resolveExternalExecutable('git', { cwd: root, env: process.env });
  await assertLocalConfig(executable, root);
  await assertNoAlternateHistory(root);
  const topLevel = (await gitText(executable, ['rev-parse', '--show-toplevel'], {
    cwd: root,
    repository: root
  })).trim();
  if (await realpath(topLevel) !== root) fail('repository root does not match its Git top level');
  const tag = releaseTag(verified.version);
  const tagRef = `refs/tags/${tag}`;
  const commit = (await gitText(executable, ['rev-parse', DISTRIBUTION_BRANCH_REF], {
    cwd: root,
    repository: root
  })).trim();
  const tagObject = (await gitText(executable, ['rev-parse', tagRef], {
    cwd: root,
    repository: root
  })).trim();
  const peeledCommit = (await gitText(executable, ['rev-parse', `${tagRef}^{commit}`], {
    cwd: root,
    repository: root
  })).trim();
  if (!SHA1_PATTERN.test(commit) || !SHA1_PATTERN.test(tagObject) || peeledCommit !== commit) {
    fail('distribution tag does not resolve to its artifact commit');
  }
  const tagType = (await gitText(executable, ['cat-file', '-t', tagObject], {
    cwd: root,
    repository: root
  })).trim();
  if (tagType !== 'tag') fail('distribution version reference must be an annotated tag');
  const headRef = (await gitText(executable, ['symbolic-ref', 'HEAD'], {
    cwd: root,
    repository: root
  })).trim();
  if (headRef !== DISTRIBUTION_BRANCH_REF) fail('distribution HEAD has an unexpected branch reference');
  const parents = (await gitText(executable, ['rev-list', '--parents', '--max-count=1', commit], {
    cwd: root,
    repository: root
  })).trim().split(' ');
  const count = (await gitText(executable, ['rev-list', '--count', '--all'], {
    cwd: root,
    repository: root
  })).trim();
  if (parents.length !== 1 || parents[0] !== commit || count !== '1') {
    fail('distribution commit must be the only parentless commit');
  }
  const refsText = await gitText(executable, [
    'for-each-ref', '--format=%(refname)%00%(objecttype)%00%(objectname)'
  ], {
    cwd: root,
    repository: root
  });
  const refs = refsText.trim().split('\n').filter(Boolean).map((line) => line.split('\0'));
  if (refs.length !== 2
      || !refs.some(([ref, type, oid]) => ref === DISTRIBUTION_BRANCH_REF && type === 'commit' && oid === commit)
      || !refs.some(([ref, type, oid]) => ref === tagRef && type === 'tag' && oid === tagObject)) {
    fail('distribution repository contains unexpected references');
  }
  const tree = (await gitText(executable, ['show', '-s', '--format=%T', commit], {
    cwd: root,
    repository: root
  })).trim();
  if (!SHA1_PATTERN.test(tree)) fail('distribution commit has an invalid tree');
  const epoch = await sourceCommitEpoch(executable, await realpath(path.resolve(policyRoot)), verified.source_commit, root);
  const metadata = {
    version: verified.version,
    sourceCommit: verified.source_commit,
    releaseManifestSha256: verified.release_manifest_sha256,
    artifactContentSha256: audited.content_sha256,
    tree
  };
  const expectedCommit = expectedCommitText(tree, epoch, commitMessage(metadata));
  const actualCommit = await gitText(executable, ['cat-file', 'commit', commit], {
    cwd: root,
    repository: root
  });
  if (actualCommit !== expectedCommit) fail('distribution commit metadata is not deterministic and sanitized');
  const expectedTag = expectedTagText(commit, tag, epoch, tagMessage(metadata));
  const actualTag = await gitText(executable, ['cat-file', 'tag', tagObject], {
    cwd: root,
    repository: root
  });
  if (actualTag !== expectedTag) fail('distribution tag metadata is not deterministic and sanitized');
  const treeResult = await runGit(executable, [
    'ls-tree', '-r', '-z', '--full-tree', commit
  ], {
    cwd: root,
    repository: root
  });
  const treeRecords = parseLsTree(treeResult.stdout, 'Git artifact tree');
  const artifactByPath = new Map(audited.records.map((record) => [record.path, record]));
  if (treeRecords.length !== artifactByPath.size) fail('distribution tree path set does not match the artifact');
  for (const entry of treeRecords) {
    const artifactRecord = artifactByPath.get(entry.path);
    if (!artifactRecord || entry.mode !== '100644' || entry.type !== 'blob' || !SHA1_PATTERN.test(entry.oid)) {
      fail(`distribution tree contains an unexpected entry: ${entry.path}`);
    }
    const blob = await runGit(executable, ['cat-file', 'blob', entry.oid], {
      cwd: root,
      repository: root
    });
    if (!blob.stdout.equals(artifactRecord.bytes)) {
      fail(`distribution blob bytes do not match the artifact: ${entry.path}`);
    }
    const workingBytes = await readFile(path.join(root, ...entry.path.split('/')));
    if (!workingBytes.equals(artifactRecord.bytes)) {
      fail(`distribution worktree bytes do not match the artifact: ${entry.path}`);
    }
    artifactByPath.delete(entry.path);
  }
  if (artifactByPath.size) fail('distribution tree omits artifact files');
  const indexResult = await runGit(executable, ['ls-files', '--stage', '-z'], {
    cwd: root,
    repository: root
  });
  const indexRecords = parseIndex(indexResult.stdout);
  const treeByPath = new Map(treeRecords.map((entry) => [entry.path, entry]));
  if (indexRecords.length !== treeByPath.size
      || indexRecords.some((entry) => {
        const treeEntry = treeByPath.get(entry.path);
        return entry.stage !== '0' || !treeEntry
          || entry.mode !== treeEntry.mode || entry.oid !== treeEntry.oid;
      })) {
    fail('distribution index does not exactly match the artifact commit tree');
  }
  const worktreeRecords = await collectDistributionWorktreeFiles(root);
  worktreeRecords.sort((left, right) => compareUtf8(left.path, right.path));
  if (worktreeRecords.length !== audited.records.length
      || worktreeRecords.some((entry, index) => (
        entry.path !== audited.records[index].path
        || !entry.bytes.equals(audited.records[index].bytes)
      ))) {
    fail('distribution worktree path set or bytes do not exactly match the artifact');
  }
  const status = await runGit(executable, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all'
  ], {
    cwd: root,
    repository: root
  });
  if (status.stdout.length) fail('distribution worktree must be clean and exact');
  const expectedObjects = await expectedObjectInventory(executable, root, commit, tagObject, tree);
  await assertExactObjectInventory(executable, root, expectedObjects);
  await assertExactGitAdministrativeFiles(root, tag, expectedObjects);
  await runGit(executable, ['fsck', '--full', '--strict', '--no-reflogs', '--unreachable'], {
    cwd: root,
    repository: root
  });
  return Object.freeze({
    schema_version: '1',
    repository_root: root,
    branch_ref: DISTRIBUTION_BRANCH_REF,
    tag,
    tag_ref: tagRef,
    tag_object: tagObject,
    commit,
    tree,
    version: verified.version,
    source_commit: verified.source_commit,
    source_commit_epoch: Number(epoch),
    release_manifest_sha256: verified.release_manifest_sha256,
    artifact_content_sha256: audited.content_sha256,
    file_count: audited.records.length
  });
}

export async function buildDistributionRepository({
  artifact,
  output,
  policyRoot
}) {
  assertSafePathArgument(artifact, 'artifact');
  assertSafePathArgument(output, 'output');
  assertSafePathArgument(policyRoot, 'policyRoot');
  const verified = await verifyPublicPlugin({ input: artifact, policyRoot });
  const audited = await auditDistributionArtifact(verified.artifact_root);
  const trustedPolicyRoot = await realpath(path.resolve(policyRoot));
  const destination = await resolveNewDirectory(output, 'output');
  if (isNested(verified.artifact_root, destination)) fail('output must be outside the artifact');
  if (isNested(trustedPolicyRoot, destination)) fail('output must be outside the trusted source repository');
  const executable = await resolveExternalExecutable('git', {
    cwd: trustedPolicyRoot,
    env: process.env
  });
  let created = false;
  try {
    await mkdir(destination, { mode: 0o700 });
    created = true;
    await runGit(executable, [
      'init', '--quiet', '--initial-branch=distribution', '--object-format=sha1', '--template=', destination
    ], {
      cwd: path.dirname(destination),
      repository: destination
    });
    await runGit(executable, ['config', 'core.logAllRefUpdates', 'false'], {
      cwd: destination,
      repository: destination
    });
    await copyArtifact(audited.records, destination);
    const pathInput = Buffer.from(`${audited.records.map((record) => record.path).join('\n')}\n`, 'utf8');
    const hashed = await runGit(executable, [
      'hash-object', '-w', '--no-filters', '--stdin-paths'
    ], {
      cwd: destination,
      repository: destination,
      input: pathInput
    });
    const objectIds = hashed.stdout.toString('ascii').trim().split('\n');
    if (objectIds.length !== audited.records.length || objectIds.some((oid) => !SHA1_PATTERN.test(oid))) {
      fail('Git did not hash every artifact file exactly once');
    }
    const indexRecords = audited.records.map((record, index) => (
      `100644 ${objectIds[index]}\t${record.path}\0`
    )).join('');
    await runGit(executable, ['update-index', '-z', '--index-info'], {
      cwd: destination,
      repository: destination,
      input: Buffer.from(indexRecords, 'utf8')
    });
    const tree = (await gitText(executable, ['write-tree'], {
      cwd: destination,
      repository: destination
    })).trim();
    if (!SHA1_PATTERN.test(tree)) fail('Git did not create a valid artifact tree');
    const epoch = await sourceCommitEpoch(executable, trustedPolicyRoot, verified.source_commit, destination);
    const metadata = {
      version: verified.version,
      sourceCommit: verified.source_commit,
      releaseManifestSha256: verified.release_manifest_sha256,
      artifactContentSha256: audited.content_sha256,
      tree
    };
    const identityEnv = {
      GIT_AUTHOR_NAME: DISTRIBUTION_IDENTITY.name,
      GIT_AUTHOR_EMAIL: DISTRIBUTION_IDENTITY.email,
      GIT_AUTHOR_DATE: `${epoch} +0000`,
      GIT_COMMITTER_NAME: DISTRIBUTION_IDENTITY.name,
      GIT_COMMITTER_EMAIL: DISTRIBUTION_IDENTITY.email,
      GIT_COMMITTER_DATE: `${epoch} +0000`
    };
    const commit = (await gitText(executable, [
      'commit-tree', tree, '-m', commitMessage(metadata)
    ], {
      cwd: destination,
      repository: destination,
      extraEnv: identityEnv
    })).trim();
    if (!SHA1_PATTERN.test(commit)) fail('Git did not create a valid distribution commit');
    await runGit(executable, ['update-ref', DISTRIBUTION_BRANCH_REF, commit], {
      cwd: destination,
      repository: destination
    });
    const tag = releaseTag(verified.version);
    await runGit(executable, [
      'tag', '--annotate', '--no-sign', '--cleanup=strip',
      '--message', tagMessage(metadata), tag, commit
    ], {
      cwd: destination,
      repository: destination,
      extraEnv: identityEnv
    });
    return verifyDistributionRepository({
      artifact: verified.artifact_root,
      repository: destination,
      policyRoot: trustedPolicyRoot
    });
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    if (error.message.startsWith('Buddy distribution commit:')) throw error;
    fail(error.message);
  }
}
