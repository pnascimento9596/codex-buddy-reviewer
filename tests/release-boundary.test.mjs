import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { loadPetCatalog } from '../src/pet-catalog.mjs';
import {
  buildPublicPlugin,
  verifyFinalWindowsHelper,
  verifyPublicPlugin
} from '../scripts/lib/public-release.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);
const temporaryPaths = [];
let cleanSourceRoot;
let sourceCommit;
const publicPetIds = [
  'buddy-byte',
  'buddy-mochi',
  'buddy-orbit',
  'buddy-bella',
  'buddy-lupo'
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function commitSource(root, message) {
  await execFileAsync('git', ['add', '--all', '--force'], { cwd: root, windowsHide: true });
  await execFileAsync('git', [
    '-c', 'user.name=Buddy Release Test',
    '-c', 'user.email=buddy-release-test@example.invalid',
    'commit', '--quiet', '--message', message
  ], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
    },
    windowsHide: true
  });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  return stdout.trim();
}

async function copySourceFixture(prefix) {
  const root = await temporaryDirectory(prefix);
  const source = path.join(root, 'source');
  await cp(projectRoot, source, {
    recursive: true,
    filter: (candidate) => {
      const relative = path.relative(projectRoot, candidate);
      if (!relative) return true;
      return !new Set(['.git', 'node_modules', 'prompt-exports']).has(relative.split(path.sep)[0]);
    }
  });
  await execFileAsync('git', ['init', '--quiet'], { cwd: source, windowsHide: true });
  const commit = await commitSource(source, 'public release test source');
  return { root, source, commit };
}

test.before(async () => {
  const fixture = await copySourceFixture('codex-buddy-public-source-');
  cleanSourceRoot = fixture.source;
  sourceCommit = fixture.commit;
});

async function buildFixture(options = {}) {
  const root = await temporaryDirectory('codex-buddy-public-release-');
  const output = path.join(root, 'artifact');
  const result = await buildPublicPlugin({
    output,
    sourceRoot: options.sourceRoot ?? cleanSourceRoot,
    sourceCommit: options.explicitCommit ? (options.sourceCommit ?? sourceCommit) : undefined
  });
  return { root, output, result };
}

test('public release is a manifest-exact five-pet runtime artifact with canonical version metadata', async () => {
  const { output, result } = await buildFixture();
  assert.equal(result.source_commit, sourceCommit);
  assert.deepEqual(result.public_pet_ids, publicPetIds);
  const packageJson = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(path.join(output, '.codex-plugin', 'plugin.json'), 'utf8'));
  const releaseManifest = JSON.parse(await readFile(path.join(output, 'release-manifest.json'), 'utf8'));
  const manifestFiles = new Map(releaseManifest.files.map((entry) => [entry.path, entry]));
  assert.equal(plugin.version, packageJson.version);
  assert.equal(plugin.version.includes('+codex.'), false);
  const catalog = await loadPetCatalog({ catalogFile: path.join(output, 'assets', 'pets', 'catalog.json') });
  assert.deepEqual(catalog.pets.map((entry) => entry.id), result.public_pet_ids);
  assert.equal(catalog.pets.every((entry) => entry.scope === 'public'), true);
  assert.equal(catalog.pets.every((entry) => entry.provenance.redistribution === 'cleared'), true);
  for (const id of publicPetIds) {
    for (const name of ['pet.json', 'provenance.json', 'spritesheet.webp']) {
      const relative = `assets/pets/${id}/${name}`;
      await access(path.join(output, relative));
      assert.equal(manifestFiles.has(relative), true, relative);
    }
  }
  const workflowPath = 'docs/assets/buddy-review-workflow.png';
  const workflowBytes = await readFile(path.join(output, workflowPath));
  assert.equal(manifestFiles.get(workflowPath)?.bytes, workflowBytes.length);
  assert.equal(manifestFiles.get(workflowPath)?.sha256, sha256(workflowBytes));
  const privacyPath = 'docs/PRIVACY.md';
  const privacyBytes = await readFile(path.join(output, privacyPath));
  assert.equal(manifestFiles.get(privacyPath)?.bytes, privacyBytes.length);
  assert.equal(manifestFiles.get(privacyPath)?.sha256, sha256(privacyBytes));
  const marketplacePath = '.claude-plugin/marketplace.json';
  const marketplaceBytes = await readFile(path.join(output, marketplacePath));
  const marketplace = JSON.parse(marketplaceBytes.toString('utf8'));
  assert.equal(marketplace.name, packageJson.name);
  assert.equal(marketplace.plugins[0].name, packageJson.name);
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(manifestFiles.get(marketplacePath)?.bytes, marketplaceBytes.length);
  assert.equal(manifestFiles.get(marketplacePath)?.sha256, sha256(marketplaceBytes));
  await assert.rejects(access(path.join(output, '.git')));
  await assert.rejects(access(path.join(output, '.github')));
  await assert.rejects(access(path.join(output, 'tests')));
  await assert.rejects(access(path.join(output, 'prompt-exports')));
  assert.deepEqual((await verifyPublicPlugin({
    input: output,
    policyRoot: cleanSourceRoot
  })).public_pet_ids, result.public_pet_ids);
});

test('public release builder accepts an explicit source commit only when it is the clean repository HEAD', async () => {
  const { result } = await buildFixture({ explicitCommit: true });
  assert.equal(result.source_commit, sourceCommit);

  const root = await temporaryDirectory('codex-buddy-public-wrong-commit-');
  const output = path.join(root, 'artifact');
  await assert.rejects(
    buildPublicPlugin({
      output,
      sourceRoot: cleanSourceRoot,
      sourceCommit: 'f'.repeat(40)
    }),
    /sourceCommit must equal the source repository HEAD/
  );
  await assert.rejects(access(output));
});

test('public release builder rejects tracked and untracked changes to copied public inputs', async () => {
  const tracked = await copySourceFixture('codex-buddy-public-dirty-tracked-');
  await appendFile(path.join(tracked.source, 'README.md'), 'dirty public input\n');
  const trackedOutput = path.join(tracked.root, 'artifact');
  await assert.rejects(
    buildPublicPlugin({ output: trackedOutput, sourceRoot: tracked.source }),
    /public source inputs must exactly match HEAD/
  );
  await assert.rejects(access(trackedOutput));

  const untracked = await copySourceFixture('codex-buddy-public-dirty-untracked-');
  await writeFile(path.join(untracked.source, 'src', 'untracked-release-input.mjs'), 'export const dirty = true;\n');
  const untrackedOutput = path.join(untracked.root, 'artifact');
  await assert.rejects(
    buildPublicPlugin({ output: untrackedOutput, sourceRoot: untracked.source }),
    /public source inputs must exactly match HEAD/
  );
  await assert.rejects(access(untrackedOutput));
});

test('public release builder rejects staged, deleted, and ignored changes to copied public inputs', async () => {
  const staged = await copySourceFixture('codex-buddy-public-dirty-staged-');
  const stagedPath = path.join(staged.source, 'README.md');
  await appendFile(stagedPath, 'staged public input\n');
  await execFileAsync('git', ['add', '--', 'README.md'], {
    cwd: staged.source,
    windowsHide: true
  });
  const stagedOutput = path.join(staged.root, 'artifact');
  await assert.rejects(
    buildPublicPlugin({ output: stagedOutput, sourceRoot: staged.source }),
    /public source inputs must exactly match HEAD/
  );
  await assert.rejects(access(stagedOutput));

  const deleted = await copySourceFixture('codex-buddy-public-dirty-deleted-');
  await rm(path.join(deleted.source, 'README.md'));
  const deletedOutput = path.join(deleted.root, 'artifact');
  await assert.rejects(
    buildPublicPlugin({ output: deletedOutput, sourceRoot: deleted.source }),
    /public source inputs must exactly match HEAD/
  );
  await assert.rejects(access(deletedOutput));

  const ignored = await copySourceFixture('codex-buddy-public-dirty-ignored-');
  await writeFile(path.join(ignored.source, 'src', 'ignored-release-input.log'), 'ignored public input\n');
  const ignoredOutput = path.join(ignored.root, 'artifact');
  await assert.rejects(
    buildPublicPlugin({ output: ignoredOutput, sourceRoot: ignored.source }),
    /public source inputs must exactly match HEAD/
  );
  await assert.rejects(access(ignoredOutput));
});

test('private-only untracked bytes outside public inputs do not block an honest public build', async () => {
  const fixture = await copySourceFixture('codex-buddy-public-private-dirty-');
  const privateFixture = path.join(fixture.source, 'assets', 'pets', 'buddy-private-fixture');
  await mkdir(privateFixture);
  await writeFile(
    path.join(privateFixture, 'local-private-note.txt'),
    'private-only local note\n'
  );
  const output = path.join(fixture.root, 'artifact');
  const result = await buildPublicPlugin({ output, sourceRoot: fixture.source });
  assert.equal(result.source_commit, fixture.commit);
  await assert.rejects(access(path.join(output, 'assets', 'pets', 'buddy-private-fixture')));
});

test('public release builder refuses every pre-existing destination without modifying it', async () => {
  const root = await temporaryDirectory('codex-buddy-public-existing-');
  const output = path.join(root, 'artifact');
  await mkdir(output);
  const marker = path.join(output, 'owner.txt');
  await writeFile(marker, 'preserve\n');
  await assert.rejects(
    buildPublicPlugin({ output, sourceCommit }),
    /output must not already exist/
  );
  assert.equal(await readFile(marker, 'utf8'), 'preserve\n');
});

test('public release builder rejects an output nested anywhere under the source repository', async () => {
  const fixture = await copySourceFixture('codex-buddy-public-nested-output-');
  const output = path.join(fixture.source, 'src', 'nested-public-artifact');
  await assert.rejects(
    buildPublicPlugin({ output, sourceRoot: fixture.source, sourceCommit: fixture.commit }),
    /output must be outside the source repository/
  );
  await assert.rejects(access(output));
});

test('public release materializes committed blobs instead of clean-filtered working-tree bytes', async () => {
  const fixture = await copySourceFixture('codex-buddy-public-clean-filter-');
  const relative = 'src/clean-filter-fixture.txt';
  const sourceFile = path.join(fixture.source, ...relative.split('/'));
  const clean = "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s.replace(/SMUDGED/g,'CLEAN')))\"";
  await execFileAsync('git', ['config', 'filter.buddy-release-test.clean', clean], {
    cwd: fixture.source,
    windowsHide: true
  });
  await execFileAsync('git', ['config', 'filter.buddy-release-test.required', 'true'], {
    cwd: fixture.source,
    windowsHide: true
  });
  await writeFile(
    path.join(fixture.source, '.gitattributes'),
    `${relative} filter=buddy-release-test\n`
  );
  await writeFile(sourceFile, 'SMUDGED\n');
  const commit = await commitSource(fixture.source, 'add clean-filtered public input');
  const workingBytes = await readFile(sourceFile);
  const { stdout: committedBytes } = await execFileAsync(
    'git', ['cat-file', 'blob', `${commit}:${relative}`],
    { cwd: fixture.source, encoding: null, windowsHide: true }
  );
  assert.notDeepEqual(workingBytes, committedBytes);
  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain=v1', '--', relative], {
    cwd: fixture.source,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(status, '');
  const output = path.join(fixture.root, 'artifact');
  await buildPublicPlugin({ output, sourceRoot: fixture.source, sourceCommit: commit });
  assert.deepEqual(await readFile(path.join(output, ...relative.split('/'))), committedBytes);
});

test('final public versions require a packaged verified win32-x64 helper', async () => {
  const { output } = await buildFixture();
  assert.deepEqual(
    await verifyFinalWindowsHelper(output, '0.5.0-rc.1'),
    { required: false, verified: false }
  );
  await assert.rejects(
    verifyFinalWindowsHelper(output, '0.5.0'),
    /final releases require a packaged verified win32-x64 helper/
  );
});

test('public release verifier rejects changed bytes and unexpected paths', async () => {
  const changed = await buildFixture();
  await appendFile(path.join(changed.output, 'README.md'), 'tampered\n');
  await assert.rejects(
    verifyPublicPlugin({ input: changed.output, policyRoot: cleanSourceRoot }),
    /bytes do not match/
  );

  const extra = await buildFixture();
  await writeFile(path.join(extra.output, 'unexpected.txt'), 'not allowlisted\n');
  await assert.rejects(
    verifyPublicPlugin({ input: extra.output, policyRoot: cleanSourceRoot }),
    /path set does not exactly match/
  );

  const marketplaceMismatch = await buildFixture();
  const marketplaceFile = path.join(
    marketplaceMismatch.output,
    '.claude-plugin',
    'marketplace.json'
  );
  const marketplace = JSON.parse(await readFile(marketplaceFile, 'utf8'));
  marketplace.plugins[0].name = 'different-plugin';
  await writeFile(marketplaceFile, `${JSON.stringify(marketplace, null, 2)}\n`);
  await assert.rejects(
    verifyPublicPlugin({ input: marketplaceMismatch.output, policyRoot: cleanSourceRoot }),
    /marketplace manifest does not match/
  );
});

test('public release verifier rejects a self-consistent manifest path outside trusted policy', async () => {
  const fixture = await buildFixture();
  const relative = 'arbitrary-public-looking.txt';
  const bytes = Buffer.from('self-consistent but not allowlisted\n');
  await writeFile(path.join(fixture.output, relative), bytes);
  const manifestFile = path.join(fixture.output, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.files.push({
    path: relative,
    bytes: bytes.length,
    mode: '0644',
    sha256: sha256(bytes)
  });
  manifest.files.sort((left, right) => left.path.localeCompare(right.path));
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    verifyPublicPlugin({ input: fixture.output, policyRoot: cleanSourceRoot }),
    /trusted public release policy/
  );
});

test('public release verifier rejects self-consistent changed bytes at an allowlisted path', async () => {
  const fixture = await buildFixture();
  const relative = 'README.md';
  const bytes = Buffer.from('tampered but manifest-consistent README\n');
  await writeFile(path.join(fixture.output, relative), bytes);
  const manifestFile = path.join(fixture.output, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const entry = manifest.files.find((candidate) => candidate.path === relative);
  entry.bytes = bytes.length;
  entry.sha256 = sha256(bytes);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    verifyPublicPlugin({ input: fixture.output, policyRoot: cleanSourceRoot }),
    /trusted source commit/
  );
});

test('public release verifier rejects symlinks before following staged package paths', {
  skip: process.platform === 'win32'
}, async () => {
  const { output } = await buildFixture();
  await symlink('README.md', path.join(output, 'linked-readme'));
  await assert.rejects(
    verifyPublicPlugin({ input: output, policyRoot: cleanSourceRoot }),
    /artifact contains a symlink/
  );
});

test('private and non-cleared catalog fixture can never be promoted by the public allowlist', async () => {
  const fixture = await copySourceFixture('codex-buddy-public-private-scope-');
  const privateId = 'buddy-private-fixture';
  const packageDirectory = path.join(fixture.source, 'assets', 'pets', privateId);
  const manifest = {
    id: privateId,
    displayName: 'Private Fixture',
    description: 'A deliberately non-cleared release boundary fixture.',
    spriteVersionNumber: 2,
    spritesheetPath: 'spritesheet.webp'
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const spritesheetBytes = Buffer.from('non-cleared fixture bytes');
  await mkdir(packageDirectory);
  await writeFile(path.join(packageDirectory, 'pet.json'), manifestBytes);
  await writeFile(path.join(packageDirectory, 'spritesheet.webp'), spritesheetBytes);
  await writeFile(path.join(packageDirectory, 'provenance.json'), `${JSON.stringify({
    schema_version: '1',
    pet_id: privateId,
    scope: 'private',
    status: 'validated',
    redistribution: 'private-only',
    binary_asset_present: true,
    notes: 'Test-only private fixture.'
  }, null, 2)}\n`);
  const catalogFile = path.join(fixture.source, 'assets', 'pets', 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  catalog.pets.push({
    id: privateId,
    displayName: manifest.displayName,
    description: manifest.description,
    scope: 'private',
    spriteVersionNumber: 2,
    available: true,
    notReadyReason: null,
    manifestPath: `./${privateId}/pet.json`,
    manifestSha256: sha256(manifestBytes),
    spritesheetPath: `./${privateId}/spritesheet.webp`,
    provenancePath: `./${privateId}/provenance.json`,
    spritesheetSha256: sha256(spritesheetBytes)
  });
  await writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
  const configFile = path.join(fixture.source, 'release', 'public-files.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.public_pet_ids = [...publicPetIds, privateId];
  const output = path.join(fixture.root, 'artifact');
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const commit = await commitSource(fixture.source, 'attempt private pet promotion');
  await assert.rejects(
    buildPublicPlugin({ output, sourceRoot: fixture.source, sourceCommit: commit }),
    /buddy-private-fixture is not an available public catalog entry/
  );
  await assert.rejects(access(output));
});
