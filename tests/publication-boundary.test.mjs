import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  PublicationBoundaryError,
  checkPublicationBoundary
} from '../scripts/check-publication-boundary.mjs';

const execFileAsync = promisify(execFile);
const temporaryPaths = [];
const noreply = '12345+buddy-review@users.noreply.github.com';
const privateEmail = ['private.person', 'gmail.com'].join('@');
const outlookEmail = ['person', 'outlook.com'].join('@');
const customEmail = ['private.person', 'custom.example'].join('@');
const contributorEmail = ['public.contributor', 'example.org'].join('@');
const yahooEmail = ['private.person', 'yahoo.com'].join('@');
const protonEmail = ['contact-person', 'proton.me'].join('@');
const privateMacPath = ['', 'Users', 'alice', 'private-project'].join('/');
const privateLinuxPath = ['', 'home', 'alice', 'private-project'].join('/');
const privateWindowsPath = ['C:', 'Users', 'Alice', 'private-project'].join('\\');
const scanTemporaryPath = ['', 'tmp', 'codex-security-scans-fixture', 'artifact'].join('/');

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryRepository(prefix = 'buddy-publication-test-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(root);
  await execFileAsync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  return root;
}

async function commit(root, email = noreply, message = 'fixture commit', identities = {}) {
  await execFileAsync('git', ['add', '--all', '--force'], { cwd: root, windowsHide: true });
  await execFileAsync('git', [
    '-c', 'user.name=Publication Fixture',
    '-c', `user.email=${email}`,
    'commit', '--quiet', '--message', message
  ], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: identities.authorName ?? 'Publication Fixture',
      GIT_AUTHOR_EMAIL: identities.authorEmail ?? email,
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: identities.committerName ?? 'Publication Fixture',
      GIT_COMMITTER_EMAIL: identities.committerEmail ?? email,
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
    },
    windowsHide: true
  });
}

async function annotatedTag(root, name, message, identity = {}) {
  await execFileAsync('git', [
    '-c', `user.name=${identity.name ?? 'Publication Fixture'}`,
    '-c', `user.email=${identity.email ?? noreply}`,
    'tag', '--annotate', name, '--message', message
  ], {
    cwd: root,
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
    },
    windowsHide: true
  });
}

async function attachRawCommit(root, bytes, refName) {
  const objectPath = path.join(root, '.git', 'publication-metadata-object');
  await writeFile(objectPath, bytes);
  const { stdout } = await execFileAsync('git', [
    'hash-object', '-w', '-t', 'commit', objectPath
  ], { cwd: root, windowsHide: true });
  const oid = stdout.trim();
  await execFileAsync('git', ['update-ref', refName, oid], { cwd: root, windowsHide: true });
  return oid;
}

async function fixture(files, options = {}) {
  const root = await temporaryRepository();
  for (const [relative, bytes] of Object.entries(files)) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  await commit(root, options.email, options.message);
  return root;
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof PublicationBoundaryError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('clean sanitized history with user and system GitHub noreply identities passes', async () => {
  const root = await fixture({
    'README.md': '# Public fixture\n',
    'src/index.mjs': 'export const ready = true;\n'
  });
  await writeFile(path.join(root, 'README.md'), '# Public fixture updated\n');
  await commit(root, noreply, 'GitHub merge fixture', {
    committerName: 'GitHub',
    committerEmail: 'noreply@github.com'
  });
  const result = await checkPublicationBoundary({ root });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'history');
  assert.equal(result.reachable_commits, 2);
  assert.equal(result.reachable_refs, 1);
  assert.equal(result.annotated_tags_scanned, 0);
  assert.equal(result.tracked_files, 2);
  assert.equal(result.text_files_scanned, 3);
});

test('reachable private identity fails even when HEAD uses noreply, while explicit safe identities are supported', async () => {
  const root = await fixture({ 'README.md': 'first\n' }, {
    email: privateEmail,
    message: 'private identity'
  });
  await writeFile(path.join(root, 'README.md'), 'second\n');
  await commit(root, noreply, 'public identity');

  await rejectsWithCode(checkPublicationBoundary({ root }), 'UNSAFE_HISTORY_EMAIL');
  const treeResult = await checkPublicationBoundary({ root, treeOnly: true });
  assert.equal(treeResult.mode, 'tree-only');
  const allowlisted = await checkPublicationBoundary({
    root,
    safeEmails: [privateEmail]
  });
  assert.equal(allowlisted.reachable_commits, 2);
});

test('commit messages reject personal paths, receipt records, and non-allowlisted email addresses', async () => {
  const pathRoot = await fixture({ 'README.md': 'safe\n' }, {
    message: `worked from ${privateMacPath}`
  });
  await rejectsWithCode(checkPublicationBoundary({ root: pathRoot }), 'ABSOLUTE_USER_PATH');

  const receiptRoot = await fixture({ 'README.md': 'safe\n' }, {
    message: [
      `review_key=${'a'.repeat(64)}`,
      'terminal_status=findings',
      'reviewer_runs=[]'
    ].join('\n')
  });
  await rejectsWithCode(checkPublicationBoundary({ root: receiptRoot }), 'RUNTIME_RECEIPT_CONTENT');

  const emailRoot = await fixture({ 'README.md': 'safe\n' }, {
    message: `Co-authored-by: Private Person <${outlookEmail}>`
  });
  await rejectsWithCode(checkPublicationBoundary({ root: emailRoot }), 'UNSAFE_PUBLICATION_EMAIL');
});

test('commit author and committer names and emails are independently inspected', async () => {
  const authorNameRoot = await fixture({ 'README.md': 'safe\n' });
  await writeFile(path.join(authorNameRoot, 'README.md'), 'author name\n');
  await commit(authorNameRoot, noreply, 'author name metadata', {
    authorName: privateMacPath
  });
  await rejectsWithCode(checkPublicationBoundary({ root: authorNameRoot }), 'ABSOLUTE_USER_PATH');

  const committerNameRoot = await fixture({ 'README.md': 'safe\n' });
  await writeFile(path.join(committerNameRoot, 'README.md'), 'committer name\n');
  await commit(committerNameRoot, noreply, 'committer name metadata', {
    committerName: privateLinuxPath
  });
  await rejectsWithCode(checkPublicationBoundary({ root: committerNameRoot }), 'ABSOLUTE_USER_PATH');

  const committerEmailRoot = await fixture({ 'README.md': 'safe\n' });
  await writeFile(path.join(committerEmailRoot, 'README.md'), 'committer email\n');
  await commit(committerEmailRoot, noreply, 'committer email metadata', {
    committerEmail: customEmail
  });
  await rejectsWithCode(checkPublicationBoundary({ root: committerEmailRoot }), 'UNSAFE_HISTORY_EMAIL');
});

test('the explicit safe-email allowlist covers reviewed contributor metadata and text', async () => {
  const root = await fixture({
    'README.md': `Contact: ${contributorEmail}\n`,
    'fixture.txt': 'safe\n'
  }, {
    email: contributorEmail,
    message: `Co-authored-by: Public Contributor <${contributorEmail}>`
  });
  await annotatedTag(root, 'v1.0.0', `Release contact: ${contributorEmail}`, {
    email: contributorEmail
  });
  const result = await checkPublicationBoundary({ root, safeEmails: [contributorEmail] });
  assert.equal(result.annotated_tags_scanned, 1);
  assert.equal(result.reachable_refs, 2);
});

test('reserved invalid-domain fixtures remain safe without weakening real email checks', async () => {
  const root = await fixture({
    'README.md': 'Synthetic contact: buddy@example.invalid\n'
  }, {
    email: 'buddy@example.invalid',
    message: 'Synthetic trailer: Buddy <buddy@example.invalid>'
  });
  const result = await checkPublicationBoundary({ root });
  assert.equal(result.ok, true);
});

test('absolute user paths and personal email addresses in reachable text fail without exposing matched content', async () => {
  const privatePath = privateMacPath;
  const root = await fixture({ 'notes.txt': `workspace=${privatePath}\n` });
  await assert.rejects(checkPublicationBoundary({ root }), (error) => {
    assert.equal(error.code, 'ABSOLUTE_USER_PATH');
    assert.equal(error.message.includes(privatePath), false);
    assert.match(error.message, /path-id [0-9a-f]{12}/);
    return true;
  });

  const gmailAddress = ['person.fixture', 'gmail.com'].join('@');
  const gmailRoot = await fixture({ 'notes.txt': `owner=${gmailAddress}\n` });
  await assert.rejects(checkPublicationBoundary({ root: gmailRoot }), (error) => {
    assert.equal(error.code, 'UNSAFE_PUBLICATION_EMAIL');
    assert.equal(error.message.includes(gmailAddress), false);
    return true;
  });
});

test('Linux, escaped Windows, and security-scan temporary paths fail closed', async () => {
  for (const [value, expectedCode] of [
    [privateLinuxPath, 'ABSOLUTE_USER_PATH'],
    [JSON.stringify({ workspace: privateWindowsPath }), 'ABSOLUTE_USER_PATH'],
    [scanTemporaryPath, 'SCAN_TEMP_PATH']
  ]) {
    const root = await fixture({ 'notes.txt': `${value}\n` });
    await rejectsWithCode(checkPublicationBoundary({ root }), expectedCode);
  }
});

test('annotated tag messages and tagger metadata are inspected', async () => {
  const messageRoot = await fixture({ 'README.md': 'safe\n' });
  await annotatedTag(messageRoot, 'v1.0.0', `built from ${privateWindowsPath}`);
  await rejectsWithCode(checkPublicationBoundary({ root: messageRoot }), 'ABSOLUTE_USER_PATH');

  const taggerNameRoot = await fixture({ 'README.md': 'safe\n' });
  await annotatedTag(taggerNameRoot, 'v1.0.0', 'safe tag message', {
    name: privateMacPath
  });
  await rejectsWithCode(checkPublicationBoundary({ root: taggerNameRoot }), 'ABSOLUTE_USER_PATH');

  const taggerEmailRoot = await fixture({ 'README.md': 'safe\n' });
  await annotatedTag(taggerEmailRoot, 'v1.0.0', 'safe tag message', {
    email: yahooEmail
  });
  await rejectsWithCode(checkPublicationBoundary({ root: taggerEmailRoot }), 'UNSAFE_HISTORY_EMAIL');
});

test('supplemental commit headers cannot hide nested tag metadata', async () => {
  const root = await fixture({ 'README.md': 'safe\n' });
  const { stdout: headOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    windowsHide: true
  });
  const { stdout: treeOutput } = await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: root,
    windowsHide: true
  });
  const head = headOutput.trim();
  const tree = treeOutput.trim();
  const rawCommit = [
    `tree ${tree}`,
    `parent ${head}`,
    `author Publication Fixture <${noreply}> 946684800 +0000`,
    `committer Publication Fixture <${noreply}> 946684800 +0000`,
    `mergetag object ${head}`,
    ' type commit',
    ' tag v-private-fixture',
    ` tagger Publication Fixture <${noreply}> 946684800 +0000`,
    ' ',
    ` nested source ${privateMacPath}`,
    '',
    'merge fixture',
    ''
  ].join('\n');
  await attachRawCommit(root, rawCommit, 'refs/heads/mergetag-fixture');
  await rejectsWithCode(checkPublicationBoundary({ root }), 'ABSOLUTE_USER_PATH');
});

test('invalid UTF-8 in reachable commit metadata fails closed', async () => {
  const root = await fixture({ 'README.md': 'safe\n' });
  const { stdout: headOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    windowsHide: true
  });
  const { stdout: treeOutput } = await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: root,
    windowsHide: true
  });
  const head = headOutput.trim();
  const tree = treeOutput.trim();
  const headers = Buffer.from([
    `tree ${tree}`,
    `parent ${head}`,
    `author Publication Fixture <${noreply}> 946684800 +0000`,
    `committer Publication Fixture <${noreply}> 946684800 +0000`,
    '',
    'invalid '
  ].join('\n'), 'utf8');
  await attachRawCommit(root, Buffer.concat([headers, Buffer.from([0xff]), Buffer.from('\n')]), 'refs/heads/invalid-metadata');
  await rejectsWithCode(checkPublicationBoundary({ root }), 'GIT_METADATA_ENCODING_INVALID');
});

test('reference names reject Buddy private-state paths and percent-encoded personal paths', async () => {
  const receiptRefRoot = await fixture({ 'README.md': 'safe\n' });
  await execFileAsync('git', [
    'branch', `receipts/${'a'.repeat(64)}`
  ], { cwd: receiptRefRoot, windowsHide: true });
  await rejectsWithCode(checkPublicationBoundary({ root: receiptRefRoot }), 'SENSITIVE_REF_NAME');

  const encodedPathRoot = await fixture({ 'README.md': 'safe\n' });
  await execFileAsync('git', [
    'branch', 'work-%252FUsers%252Falice%252Fprivate-project'
  ], { cwd: encodedPathRoot, windowsHide: true });
  await rejectsWithCode(checkPublicationBoundary({ root: encodedPathRoot }), 'ABSOLUTE_USER_PATH');

  const emailRefRoot = await fixture({ 'README.md': 'safe\n' });
  await execFileAsync('git', [
    'branch', protonEmail
  ], { cwd: emailRefRoot, windowsHide: true });
  await rejectsWithCode(checkPublicationBoundary({ root: emailRefRoot }), 'UNSAFE_PUBLICATION_EMAIL');
});

test('tree-only mode deliberately ignores unsafe history metadata and refs', async () => {
  const root = await fixture({ 'README.md': 'safe\n' }, {
    message: `historical path ${privateMacPath}`
  });
  await execFileAsync('git', [
    'branch', `automatic-reviews/${'b'.repeat(64)}`
  ], { cwd: root, windowsHide: true });
  const result = await checkPublicationBoundary({ root, treeOnly: true });
  assert.equal(result.mode, 'tree-only');
  assert.equal(result.reachable_refs, null);
  assert.equal(result.annotated_tags_scanned, null);
  await rejectsWithCode(checkPublicationBoundary({ root }), 'SENSITIVE_REF_NAME');
});

test('runtime, prompt export, and credential filenames are rejected', async () => {
  for (const relative of ['.env', 'prompt-exports/session.md', 'receipts/review.json', 'token.json']) {
    const root = await fixture({ [relative]: 'synthetic fixture bytes\n' });
    await rejectsWithCode(checkPublicationBoundary({ root }), 'SENSITIVE_TRACKED_PATH');
  }
});

test('security scanner source filenames are not confused with secret data files', async () => {
  const root = await fixture({
    'src/secret-scan.mjs': 'export const scannerFixture = true;\n',
    'tests/secret-scan.test.mjs': 'export const scannerTestFixture = true;\n'
  });
  const result = await checkPublicationBoundary({ root });
  assert.equal(result.ok, true);
});

test('sensitive filenames removed from HEAD remain rejected through reachable history', async () => {
  const root = await fixture({ 'receipts/removed.json': '{"fixture":true}\n' });
  await rm(path.join(root, 'receipts'), { recursive: true });
  await commit(root, noreply, 'remove private runtime state');
  await rejectsWithCode(checkPublicationBoundary({ root }), 'SENSITIVE_TRACKED_PATH');
  const treeResult = await checkPublicationBoundary({ root, treeOnly: true });
  assert.equal(treeResult.ok, true);
});

test('sensitive text removed from HEAD remains rejected through reachable history', async () => {
  const root = await fixture({ 'notes.txt': `workspace=${privateMacPath}\n` });
  await writeFile(path.join(root, 'notes.txt'), 'sanitized\n');
  await commit(root, noreply, 'sanitize current tree');
  await rejectsWithCode(checkPublicationBoundary({ root }), 'ABSOLUTE_USER_PATH');
  const treeResult = await checkPublicationBoundary({ root, treeOnly: true });
  assert.equal(treeResult.ok, true);
});

test('runtime receipt JSON is rejected even under an innocuous filename', async () => {
  const root = await fixture({
    'fixture.json': `${JSON.stringify({
      review_key: 'a'.repeat(64),
      terminal_status: 'complete',
      reviewer_runs: []
    })}\n`
  });
  await rejectsWithCode(checkPublicationBoundary({ root }), 'RUNTIME_RECEIPT_CONTENT');
});

test('manual evidence and provider run receipts are rejected by structure', async () => {
  const evidenceRoot = await fixture({
    'fixture.json': `${JSON.stringify({
      schema_version: '1',
      review_id: 'fixture-review',
      repository_root: '/synthetic/repository',
      patch_hash: 'a'.repeat(64),
      captured_at: '2000-01-01T00:00:00.000Z'
    })}\n`
  });
  await rejectsWithCode(checkPublicationBoundary({ root: evidenceRoot }), 'RUNTIME_RECEIPT_CONTENT');

  const runRoot = await fixture({
    'fixture.json': `${JSON.stringify({
      schema_version: '1',
      review_id: 'fixture-review',
      provider: 'synthetic',
      model: 'synthetic',
      prompt_version: '4'
    })}\n`
  });
  await rejectsWithCode(checkPublicationBoundary({ root: runRoot }), 'RUNTIME_RECEIPT_CONTENT');
});

test('binary extensions cannot hide runtime receipt JSON', async () => {
  const root = await fixture({
    'assets/not-really.png': `${JSON.stringify({
      workspace_key: 'b'.repeat(16),
      event_id: 'event-fixture',
      event_type: 'review_completed'
    })}\n`
  });
  await rejectsWithCode(checkPublicationBoundary({ root }), 'RUNTIME_RECEIPT_CONTENT');
});

test('tracked symbolic links fail closed in the index and in removed history', {
  skip: process.platform === 'win32'
}, async () => {
  const root = await temporaryRepository('buddy-publication-symlink-');
  await writeFile(path.join(root, 'target.txt'), 'safe\n');
  await symlink('target.txt', path.join(root, 'link.txt'));
  await commit(root);
  await rejectsWithCode(checkPublicationBoundary({ root, treeOnly: true }), 'UNSCANNED_SYMLINK');

  await rm(path.join(root, 'link.txt'));
  await commit(root, noreply, 'remove symlink');
  await rejectsWithCode(checkPublicationBoundary({ root }), 'UNSCANNED_SYMLINK');
});

test('invalid UTF-8 tracked pathname fails closed', {
  skip: process.platform !== 'linux'
}, async () => {
  const root = await temporaryRepository('buddy-publication-invalid-path-');
  const rawPath = Buffer.concat([
    Buffer.from(`${root}${path.sep}invalid-`, 'utf8'),
    Buffer.from([0xff]),
    Buffer.from('.txt', 'utf8')
  ]);
  await writeFile(rawPath, 'fixture\n');
  await commit(root);
  await rejectsWithCode(checkPublicationBoundary({ root, treeOnly: true }), 'GIT_PATH_ENCODING_INVALID');
});

test('invalid UTF-8 pathname removed from HEAD still fails through reachable history', {
  skip: process.platform !== 'linux'
}, async () => {
  const root = await temporaryRepository('buddy-publication-invalid-history-path-');
  const rawPath = Buffer.concat([
    Buffer.from(`${root}${path.sep}removed-`, 'utf8'),
    Buffer.from([0xff]),
    Buffer.from('.txt', 'utf8')
  ]);
  await writeFile(rawPath, 'fixture\n');
  await commit(root);
  await unlink(rawPath);
  await commit(root, noreply, 'remove invalid path');
  await rejectsWithCode(checkPublicationBoundary({ root }), 'GIT_PATH_ENCODING_INVALID');
});

test('recognized binary files are skipped without scanning embedded text-shaped bytes', async () => {
  const binary = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    Buffer.from('synthetic binary fixture', 'utf8')
  ]);
  const root = await fixture({ 'assets/fixture.png': binary, 'README.md': 'safe\n' });
  const result = await checkPublicationBoundary({ root });
  assert.equal(result.candidate_blobs, 2);
  assert.equal(result.text_files_scanned, 1);
});

test('binary extensions cannot hide text-shaped non-public bytes', async () => {
  const root = await fixture({ 'assets/not-really.png': `workspace=${privateMacPath}\n` });
  await rejectsWithCode(checkPublicationBoundary({ root }), 'ABSOLUTE_USER_PATH');
});

test('file count and byte limits fail closed before unbounded scanning', async () => {
  const fileRoot = await fixture({ 'one.txt': 'one\n', 'two.txt': 'two\n' });
  await rejectsWithCode(
    checkPublicationBoundary({ root: fileRoot, limits: { maxFiles: 1 } }),
    'WORK_LIMIT_EXCEEDED'
  );

  const byteRoot = await fixture({ 'large.txt': '1234567890\n' });
  await rejectsWithCode(
    checkPublicationBoundary({ root: byteRoot, limits: { maxTextFileBytes: 4 } }),
    'WORK_LIMIT_EXCEEDED'
  );

  const refRoot = await fixture({ 'README.md': 'safe\n' });
  await execFileAsync('git', ['branch', 'second-ref'], { cwd: refRoot, windowsHide: true });
  await rejectsWithCode(
    checkPublicationBoundary({ root: refRoot, limits: { maxRefs: 1 } }),
    'WORK_LIMIT_EXCEEDED'
  );

  const metadataRoot = await fixture({ 'README.md': 'safe\n' });
  await rejectsWithCode(
    checkPublicationBoundary({ root: metadataRoot, limits: { maxMetadataObjectBytes: 32 } }),
    'WORK_LIMIT_EXCEEDED'
  );
});

test('full-history mode rejects tracked modifications and untracked files', async () => {
  const trackedRoot = await fixture({ 'README.md': 'clean\n' });
  await writeFile(path.join(trackedRoot, 'README.md'), 'dirty\n');
  await rejectsWithCode(checkPublicationBoundary({ root: trackedRoot }), 'DIRTY_WORKTREE');

  const untrackedRoot = await fixture({ 'README.md': 'clean\n' });
  await writeFile(path.join(untrackedRoot, 'untracked.txt'), 'untracked\n');
  await rejectsWithCode(checkPublicationBoundary({ root: untrackedRoot }), 'DIRTY_WORKTREE');
});

test('full-history mode rejects shallow repositories', async () => {
  const source = await fixture({ 'README.md': 'safe\n' });
  await writeFile(path.join(source, 'README.md'), 'second\n');
  await commit(source, noreply, 'second commit');
  const root = await mkdtemp(path.join(os.tmpdir(), 'buddy-publication-shallow-'));
  temporaryPaths.push(root);
  await execFileAsync('git', [
    'clone', '--quiet', '--depth=1', `file://${source}`, root
  ], { windowsHide: true });
  await rejectsWithCode(checkPublicationBoundary({ root }), 'SHALLOW_HISTORY');
});

test('tree-only mode intentionally scans the exact index despite unrelated worktree bytes', async () => {
  const root = await fixture({ 'README.md': 'committed\n' });
  await writeFile(path.join(root, 'README.md'), 'staged\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: root, windowsHide: true });
  await writeFile(path.join(root, 'README.md'), `worktree-only=${privateMacPath}\n`);
  await writeFile(path.join(root, 'untracked.txt'), `untracked=${privateMacPath}\n`);

  const result = await checkPublicationBoundary({ root, treeOnly: true });
  assert.equal(result.mode, 'tree-only');
  assert.equal(result.text_files_scanned, 1);
  await rejectsWithCode(checkPublicationBoundary({ root }), 'DIRTY_WORKTREE');
});

test('tree-only mode rejects private bytes in the index even if the worktree was sanitized later', async () => {
  const root = await fixture({ 'README.md': 'committed\n' });
  await writeFile(path.join(root, 'README.md'), `staged=${privateMacPath}\n`);
  await execFileAsync('git', ['add', 'README.md'], { cwd: root, windowsHide: true });
  await writeFile(path.join(root, 'README.md'), 'worktree is clean-looking\n');
  await rejectsWithCode(checkPublicationBoundary({ root, treeOnly: true }), 'ABSOLUTE_USER_PATH');
});

test('publication scan must be invoked from the repository top level', async () => {
  const root = await fixture({ 'nested/file.txt': 'safe\n' });
  await rejectsWithCode(
    checkPublicationBoundary({ root: path.join(root, 'nested') }),
    'GIT_TOP_LEVEL_REQUIRED'
  );
});
