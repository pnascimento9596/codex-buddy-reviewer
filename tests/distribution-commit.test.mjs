import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildPublicPlugin } from '../scripts/lib/public-release.mjs';
import {
  auditDistributionArtifact,
  buildDistributionRepository,
  DISTRIBUTION_BRANCH_REF,
  DISTRIBUTION_IDENTITY,
  DISTRIBUTION_RECEIPT_FIELDS,
  publicDistributionReceipt,
  verifyDistributionRepository
} from '../scripts/lib/distribution-commit.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const distributionCli = path.join(projectRoot, 'scripts', 'build-distribution-commit.mjs');
const temporaryPaths = [];
let sourceRoot;
let sourceCommit;
let artifactRoot;
let firstDistribution;

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function git(args, options = {}) {
  return execFileAsync('git', args, {
    encoding: options.encoding ?? 'utf8',
    windowsHide: true,
    ...options
  });
}

async function commitSource(root, message) {
  await git(['add', '--all', '--force'], { cwd: root });
  await git([
    '-c', 'user.name=Buddy Distribution Test',
    '-c', 'user.email=buddy-distribution-test@example.invalid',
    'commit', '--quiet', '--message', message
  ], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2001-02-03T04:05:06Z',
      GIT_COMMITTER_DATE: '2001-02-03T04:05:06Z'
    }
  });
  return (await git(['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
}

async function createCommittedSource() {
  const root = await temporaryDirectory('codex-buddy-distribution-source-');
  const source = path.join(root, 'source');
  await cp(projectRoot, source, {
    recursive: true,
    filter: (candidate) => {
      const relative = path.relative(projectRoot, candidate);
      if (!relative) return true;
      return !new Set(['.git', 'node_modules', 'prompt-exports']).has(relative.split(path.sep)[0]);
    }
  });
  await git(['init', '--quiet', '--initial-branch=main'], { cwd: source });
  const commit = await commitSource(source, 'distribution test source');
  return { root, source, commit };
}

async function buildDistribution(prefix = 'codex-buddy-distribution-output-') {
  const root = await temporaryDirectory(prefix);
  const output = path.join(root, 'distribution');
  const result = await buildDistributionRepository({
    artifact: artifactRoot,
    output,
    policyRoot: sourceRoot
  });
  return { root, output, result };
}

test.before(async () => {
  const fixture = await createCommittedSource();
  sourceRoot = fixture.source;
  sourceCommit = fixture.commit;
  const artifactParent = await temporaryDirectory('codex-buddy-distribution-artifact-');
  artifactRoot = path.join(artifactParent, 'artifact');
  await buildPublicPlugin({
    output: artifactRoot,
    sourceRoot,
    sourceCommit
  });
  firstDistribution = await buildDistribution();
});

test('distribution repository is one parentless byte-exact artifact commit with a resolving annotated tag', async () => {
  const { output, result } = firstDistribution;
  assert.equal(result.source_commit, sourceCommit);
  assert.equal(result.branch_ref, DISTRIBUTION_BRANCH_REF);
  assert.equal(result.tag, 'v0.5.0-rc.1');
  assert.equal(result.tag_ref, 'refs/tags/v0.5.0-rc.1');
  assert.match(result.commit, /^[0-9a-f]{40}$/u);
  assert.match(result.tag_object, /^[0-9a-f]{40}$/u);
  assert.match(result.tree, /^[0-9a-f]{40}$/u);
  assert.match(result.artifact_content_sha256, /^[0-9a-f]{64}$/u);
  const parents = (await git(['rev-list', '--parents', '--max-count=1', result.commit], {
    cwd: output
  })).stdout.trim().split(' ');
  assert.deepEqual(parents, [result.commit]);
  assert.equal((await git(['rev-list', '--count', '--all'], { cwd: output })).stdout.trim(), '1');
  assert.equal(
    (await git(['rev-parse', `${result.tag_ref}^{commit}`], { cwd: output })).stdout.trim(),
    result.commit
  );
  assert.equal(
    (await git(['cat-file', '-t', result.tag_ref], { cwd: output })).stdout.trim(),
    'tag'
  );
  assert.deepEqual(await readFile(path.join(output, 'README.md')), await readFile(path.join(artifactRoot, 'README.md')));
  assert.equal((await git(['remote'], { cwd: output })).stdout, '');
  await assert.rejects(git(['config', '--local', '--get', 'user.email'], { cwd: output }));
  assert.deepEqual(
    await verifyDistributionRepository({ artifact: artifactRoot, repository: output, policyRoot: sourceRoot }),
    result
  );
});

test('repeated construction is deterministic and ignores ambient Git identity', async () => {
  const root = await temporaryDirectory('codex-buddy-distribution-cli-');
  const output = path.join(root, 'distribution');
  const { stdout } = await execFileAsync(process.execPath, [
    distributionCli,
    '--artifact', artifactRoot,
    '--output', output,
    '--policy-root', sourceRoot,
    '--json'
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ambient Intruder',
      GIT_AUTHOR_EMAIL: 'ambient-intruder@example.invalid',
      GIT_COMMITTER_NAME: 'Ambient Intruder',
      GIT_COMMITTER_EMAIL: 'ambient-intruder@example.invalid',
      GIT_AUTHOR_DATE: '2037-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2037-01-01T00:00:00Z'
    },
    windowsHide: true
  });
  const repeated = JSON.parse(stdout);
  assert.deepEqual(Object.keys(repeated), DISTRIBUTION_RECEIPT_FIELDS);
  assert.equal(Object.hasOwn(repeated, 'repository_root'), false);
  assert.equal(JSON.stringify(repeated).includes(root), false);
  assert.equal(repeated.commit, firstDistribution.result.commit);
  assert.equal(repeated.tag_object, firstDistribution.result.tag_object);
  assert.equal(repeated.tree, firstDistribution.result.tree);
  assert.equal(repeated.artifact_content_sha256, firstDistribution.result.artifact_content_sha256);
  const commit = (await git(['cat-file', 'commit', repeated.commit], { cwd: output })).stdout;
  const tag = (await git(['cat-file', 'tag', repeated.tag_object], { cwd: output })).stdout;
  const identity = `${DISTRIBUTION_IDENTITY.name} <${DISTRIBUTION_IDENTITY.email}>`;
  assert.match(commit, new RegExp(`^author ${identity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'mu'));
  assert.match(commit, new RegExp(`^committer ${identity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'mu'));
  assert.match(tag, new RegExp(`^tagger ${identity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'mu'));
  assert.doesNotMatch(commit, /Ambient Intruder/u);
  assert.doesNotMatch(tag, /Ambient Intruder/u);
});

test('public distribution receipts are an exact path-free projection', () => {
  const receipt = publicDistributionReceipt(firstDistribution.result);
  assert.deepEqual(Object.keys(receipt), DISTRIBUTION_RECEIPT_FIELDS);
  assert.equal(Object.hasOwn(receipt, 'repository_root'), false);
  assert.equal(JSON.stringify(receipt).includes(firstDistribution.output), false);
  assert.equal(receipt.commit, firstDistribution.result.commit);
  assert.equal(receipt.tag_object, firstDistribution.result.tag_object);
});

test('artifact audit rejects credential-shaped content, personal paths, and symlinks', async (t) => {
  await t.test('credential-shaped content', async () => {
    const root = await temporaryDirectory('codex-buddy-distribution-secret-');
    const value = ['Runtime', 'Credential', '47Qx', 'Review', 'Only', '8pZ'].join('-');
    await writeFile(path.join(root, 'README.md'), `api_key = "${value}"\n`);
    await assert.rejects(
      auditDistributionArtifact(root),
      /credential-shaped material detected/
    );
  });

  await t.test('personal filesystem path', async () => {
    const root = await temporaryDirectory('codex-buddy-distribution-personal-path-');
    const personalPath = ['/', 'Users', '/', 'private-release-owner', '/', 'project'].join('');
    await writeFile(path.join(root, 'README.md'), `Local checkout: ${personalPath}\n`);
    await assert.rejects(
      auditDistributionArtifact(root),
      /personal filesystem path detected/
    );
  });

  await t.test('symlink entry', {
    skip: process.platform === 'win32'
  }, async () => {
    const root = await temporaryDirectory('codex-buddy-distribution-symlink-');
    await writeFile(path.join(root, 'README.md'), 'safe\n');
    await symlink('README.md', path.join(root, 'linked-readme'));
    await assert.rejects(
      auditDistributionArtifact(root),
      /artifact contains a symlink/
    );
  });
});

test('verification rejects worktree drift, hidden files, alternate stores, tag drift, extra objects, and local identity', async (t) => {
  await t.test('worktree drift', async () => {
    const root = await temporaryDirectory('codex-buddy-distribution-dirty-');
    const repository = path.join(root, 'distribution');
    await cp(firstDistribution.output, repository, { recursive: true });
    await appendFile(path.join(repository, 'README.md'), 'tampered\n');
    await assert.rejects(
      verifyDistributionRepository({ artifact: artifactRoot, repository, policyRoot: sourceRoot }),
      /worktree bytes do not match/
    );
  });

  await t.test('retargeted version tag', async () => {
    const root = await temporaryDirectory('codex-buddy-distribution-tag-');
    const repository = path.join(root, 'distribution');
    await cp(firstDistribution.output, repository, { recursive: true });
    await git([
      'update-ref', firstDistribution.result.tag_ref, firstDistribution.result.commit,
      firstDistribution.result.tag_object
    ], { cwd: repository });
    await assert.rejects(
      verifyDistributionRepository({ artifact: artifactRoot, repository, policyRoot: sourceRoot }),
      /annotated tag|unexpected references/
    );
  });

  await t.test('ignored untracked worktree file', async () => {
    const root = await temporaryDirectory('codex-buddy-distribution-ignored-');
    const repository = path.join(root, 'distribution');
    await cp(firstDistribution.output, repository, { recursive: true });
    await mkdir(path.join(repository, '.git', 'info'));
    await writeFile(path.join(repository, '.git', 'info', 'exclude'), 'hidden.txt\n');
    await writeFile(path.join(repository, 'hidden.txt'), 'ignored but not allowed\n');
    await assert.rejects(
      verifyDistributionRepository({ artifact: artifactRoot, repository, policyRoot: sourceRoot }),
      /worktree path set or bytes do not exactly match/
    );
  });

  await t.test('alternate object store', async () => {
    const root = await temporaryDirectory('codex-buddy-distribution-alternate-');
    const repository = path.join(root, 'distribution');
    await cp(firstDistribution.output, repository, { recursive: true });
    const externalObjects = path.join(root, 'external-objects');
    await cp(path.join(repository, '.git', 'objects'), externalObjects, { recursive: true });
    for (const entry of await readdir(path.join(repository, '.git', 'objects'))) {
      if (/^[0-9a-f]{2}$/u.test(entry)) {
        await rm(path.join(repository, '.git', 'objects', entry), { recursive: true, force: true });
      }
    }
    await writeFile(
      path.join(repository, '.git', 'objects', 'info', 'alternates'),
      `${externalObjects}\n`
    );
    await assert.rejects(
      verifyDistributionRepository({ artifact: artifactRoot, repository, policyRoot: sourceRoot }),
      /forbidden Git history metadata/
    );
  });

  await t.test('unreachable object', async () => {
    const root = await temporaryDirectory('codex-buddy-distribution-object-');
    const repository = path.join(root, 'distribution');
    await cp(firstDistribution.output, repository, { recursive: true });
    const unrelated = path.join(root, 'unrelated-object');
    await writeFile(unrelated, 'unreachable object\n');
    await git(['hash-object', '-w', '--no-filters', unrelated], { cwd: repository });
    await assert.rejects(
      verifyDistributionRepository({ artifact: artifactRoot, repository, policyRoot: sourceRoot }),
      /inherited or unreachable objects/
    );
  });

  await t.test('local identity configuration', async () => {
    const root = await temporaryDirectory('codex-buddy-distribution-config-');
    const repository = path.join(root, 'distribution');
    await cp(firstDistribution.output, repository, { recursive: true });
    await git(['config', 'user.email', 'unexpected@example.invalid'], { cwd: repository });
    await assert.rejects(
      verifyDistributionRepository({ artifact: artifactRoot, repository, policyRoot: sourceRoot }),
      /unsupported local Git configuration/
    );
  });
});

test('builder refuses any pre-existing output and leaves it untouched', async () => {
  const root = await temporaryDirectory('codex-buddy-distribution-existing-');
  const output = path.join(root, 'distribution');
  await mkdir(output);
  const marker = path.join(output, 'owner.txt');
  await writeFile(marker, 'preserve\n');
  await assert.rejects(
    buildDistributionRepository({ artifact: artifactRoot, output, policyRoot: sourceRoot }),
    /output must not already exist/
  );
  assert.equal(await readFile(marker, 'utf8'), 'preserve\n');
  await access(output);

  await assert.rejects(
    buildDistributionRepository({
      artifact: artifactRoot,
      output: path.join(root, 'unsafe\noutput'),
      policyRoot: sourceRoot
    }),
    /output contains terminal control characters/
  );
});
