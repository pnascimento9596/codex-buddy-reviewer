import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveExternalExecutable } from '../../src/executable.mjs';
import { validatePetProvenance } from '../../src/pet-catalog.mjs';
import { resolveVerifiedWindowsJobHelper } from '../../src/windows-job-supervisor.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const PET_ID_PATTERN = /^buddy-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const FINAL_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const DENIED_SEGMENTS = new Set([
  '.git',
  '.github',
  'node_modules',
  'prompt-exports',
  'tests'
]);

async function execResolvedFile(command, args, options = {}) {
  const resolved = await resolveExternalExecutable(command, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env
  });
  return execFileAsync(resolved, args, options);
}

function fail(message) {
  throw new Error(`Buddy public release: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value)) {
    fail(`${label} must be a non-empty POSIX relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail(`${label} contains an unsafe path segment`);
  }
  return value;
}

function inside(root, relative, label) {
  const safe = safeRelative(relative, label);
  const target = path.resolve(root, ...safe.split('/'));
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail(`${label} escapes its root`);
  return target;
}

async function detailsOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function plainFile(file, label) {
  const details = await detailsOrNull(file);
  if (!details) fail(`${label} is missing`);
  if (details.isSymbolicLink() || !details.isFile()) fail(`${label} must be a regular non-symlink file`);
  return readFile(file);
}

async function plainJson(file, label) {
  const bytes = await plainFile(file, label);
  return parseJsonBytes(bytes, label);
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writePublicFile(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  await writeFile(file, bytes, { mode: 0o644, flag: 'wx' });
  if (process.platform !== 'win32') await chmod(file, 0o644);
}

async function committedBlob(sourceRoot, sourceCommit, relative, label) {
  const safe = safeRelative(relative, label);
  try {
    const { stdout } = await execResolvedFile('git', [
      'cat-file', 'blob', `${sourceCommit}:${safe}`
    ], {
      cwd: sourceRoot,
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    });
    return stdout;
  } catch {
    fail(`${label} must be a regular file in source commit ${sourceCommit}`);
  }
}

async function committedTreeFiles(sourceRoot, sourceCommit, relative, label) {
  const safe = safeRelative(relative, label);
  try {
    const { stdout: objectType } = await execResolvedFile('git', [
      'cat-file', '-t', `${sourceCommit}:${safe}`
    ], {
      cwd: sourceRoot,
      encoding: 'utf8',
      windowsHide: true
    });
    if (objectType.trim() !== 'tree') fail(`${label} must be a directory in the source commit`);
  } catch (error) {
    if (error.message.startsWith('Buddy public release:')) throw error;
    fail(`${label} must be a directory in the source commit`);
  }
  const { stdout } = await execResolvedFile('git', [
    'ls-tree', '-r', '-z', '--full-tree', sourceCommit, '--', safe
  ], {
    cwd: sourceRoot,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  const files = [];
  for (const record of stdout.subarray(0, stdout.length - (stdout.at(-1) === 0 ? 1 : 0)).toString('binary').split('\0')) {
    if (!record) continue;
    const bytes = Buffer.from(record, 'binary');
    const tab = bytes.indexOf(0x09);
    if (tab < 0) fail(`${label} contains malformed Git tree metadata`);
    const [mode, type] = bytes.subarray(0, tab).toString('ascii').split(' ');
    const pathBytes = bytes.subarray(tab + 1);
    const relativePath = pathBytes.toString('utf8');
    if (!Buffer.from(relativePath, 'utf8').equals(pathBytes)) {
      fail(`${label} contains a non-UTF-8 path`);
    }
    safeRelative(relativePath, `${label} path`);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      fail(`${relativePath} must be a regular file in the source commit`);
    }
    files.push(relativePath);
  }
  files.sort();
  return files;
}

function addDestination(destinations, source, destination) {
  if (destinations.has(destination)) fail(`duplicate destination ${destination}`);
  destinations.set(destination, source);
}

function validateConfig(config) {
  exactKeys(config, ['schema_version', 'public_pet_ids', 'trees', 'files'], 'public release config');
  if (config.schema_version !== '1') fail('unsupported public release config schema');
  if (!Array.isArray(config.public_pet_ids) || config.public_pet_ids.length < 1) {
    fail('public release config needs at least one public pet');
  }
  const petIds = new Set();
  for (const id of config.public_pet_ids) {
    if (typeof id !== 'string' || !PET_ID_PATTERN.test(id) || petIds.has(id)) {
      fail('public release config contains an invalid or duplicate pet id');
    }
    petIds.add(id);
  }
  if (!Array.isArray(config.trees) || !Array.isArray(config.files)) {
    fail('public release trees and files must be arrays');
  }
  config.trees.forEach((tree, index) => safeRelative(tree, `trees[${index}]`));
  for (const [index, entry] of config.files.entries()) {
    exactKeys(entry, ['source', 'destination'], `files[${index}]`);
    safeRelative(entry.source, `files[${index}].source`);
    safeRelative(entry.destination, `files[${index}].destination`);
  }
  return Object.freeze({
    schema_version: '1',
    public_pet_ids: Object.freeze([...config.public_pet_ids]),
    trees: Object.freeze([...config.trees]),
    files: Object.freeze(config.files.map((entry) => Object.freeze({ ...entry })))
  });
}

async function publicCatalog(sourceRoot, sourceCommit, config) {
  const sourceCatalog = parseJsonBytes(
    await committedBlob(sourceRoot, sourceCommit, 'assets/pets/catalog.json', 'source pet catalog'),
    'source pet catalog'
  );
  if (sourceCatalog.schema_version !== '1' || !Array.isArray(sourceCatalog.pets)) {
    fail('source pet catalog has an unsupported shape');
  }
  const byId = new Map(sourceCatalog.pets.map((entry) => [entry.id, entry]));
  const pets = [];
  for (const id of config.public_pet_ids) {
    const entry = byId.get(id);
    if (!entry || entry.scope !== 'public' || entry.available !== true) {
      fail(`${id} is not an available public catalog entry`);
    }
    const provenance = parseJsonBytes(
      await committedBlob(
        sourceRoot,
        sourceCommit,
        path.posix.join('assets/pets', id, 'provenance.json'),
        `${id} provenance`
      ),
      `${id} provenance`
    );
    if (provenance.pet_id !== id || provenance.scope !== 'public'
        || provenance.status !== 'validated' || provenance.redistribution !== 'cleared'
        || provenance.binary_asset_present !== true) {
      fail(`${id} is not cleared for public redistribution`);
    }
    validatePetProvenance(provenance, entry, { requirePublicRights: true });
    pets.push(entry);
  }
  return { schema_version: '1', pets };
}

async function transformedPluginManifest(sourceRoot, sourceCommit) {
  const plugin = parseJsonBytes(
    await committedBlob(sourceRoot, sourceCommit, '.codex-plugin/plugin.json', 'plugin manifest'),
    'plugin manifest'
  );
  const packageJson = parseJsonBytes(
    await committedBlob(sourceRoot, sourceCommit, 'package.json', 'package manifest'),
    'package manifest'
  );
  if (plugin.name !== packageJson.name || typeof packageJson.version !== 'string' || !packageJson.version) {
    fail('plugin and package identity do not match');
  }
  return { ...plugin, version: packageJson.version };
}

async function transformedPackageManifest(sourceRoot, sourceCommit) {
  const packageJson = parseJsonBytes(
    await committedBlob(sourceRoot, sourceCommit, 'package.json', 'package manifest'),
    'package manifest'
  );
  return {
    name: packageJson.name,
    version: packageJson.version,
    private: true,
    description: packageJson.description,
    type: 'module',
    engines: packageJson.engines,
    license: packageJson.license
  };
}

async function collectArtifactFiles(root, relative = '', result = []) {
  const directory = relative ? inside(root, relative, 'artifact directory') : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) fail(`artifact contains a symlink: ${child}`);
    if (entry.isDirectory()) await collectArtifactFiles(root, child, result);
    else if (entry.isFile()) result.push(child);
    else fail(`artifact contains an unsupported filesystem type: ${child}`);
  }
  return result;
}

function assertNoDeniedPath(relative) {
  const parts = relative.split('/');
  if (parts.some((part) => DENIED_SEGMENTS.has(part))) fail(`artifact contains denied path ${relative}`);
}

export async function verifyFinalWindowsHelper(root, version) {
  if (!FINAL_VERSION_PATTERN.test(version)) return Object.freeze({ required: false, verified: false });
  try {
    const selected = await resolveVerifiedWindowsJobHelper({
      platform: 'win32',
      arch: 'x64',
      manifestFile: path.join(root, 'native', 'windows', 'helpers.json'),
      helperRoot: path.join(root, 'native', 'windows')
    });
    return Object.freeze({ required: true, verified: true, sha256: selected.sha256 });
  } catch (error) {
    fail(`final releases require a packaged verified win32-x64 helper: ${error.message}`);
  }
}

async function createReleaseManifest(root, { packageName, version, sourceCommit, publicPetIds }) {
  const paths = (await collectArtifactFiles(root)).filter((item) => item !== 'release-manifest.json');
  paths.sort();
  const files = [];
  for (const relative of paths) {
    assertNoDeniedPath(relative);
    const bytes = await plainFile(inside(root, relative, 'artifact file'), `artifact ${relative}`);
    files.push({
      path: relative,
      bytes: bytes.length,
      mode: '0644',
      sha256: sha256(bytes)
    });
  }
  return {
    schema_version: '1',
    package_name: packageName,
    version,
    source_commit: sourceCommit,
    public_pet_ids: [...publicPetIds],
    files
  };
}

export async function resolveSourceCommit(sourceRoot = DEFAULT_SOURCE_ROOT) {
  const { stdout } = await execResolvedFile('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  const commit = stdout.trim();
  if (!COMMIT_PATTERN.test(commit)) fail('Git did not return a full lowercase source commit');
  return commit;
}

function sourceRelative(sourceRoot, target, label) {
  const relative = path.relative(sourceRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} must be inside the source repository`);
  }
  return relative.split(path.sep).join('/');
}

function publicSourcePathspecs(config, configRelative) {
  return [...new Set([
    configRelative,
    '.codex-plugin/plugin.json',
    'package.json',
    'assets/pets/catalog.json',
    ...config.trees,
    ...config.files.map((entry) => entry.source),
    ...config.public_pet_ids.map((id) => `assets/pets/${id}`)
  ])].sort();
}

async function committedReleasePolicy(sourceRoot, sourceCommit, config, configRelative) {
  const destinations = new Map();
  const sourceFiles = new Set([
    configRelative,
    '.codex-plugin/plugin.json',
    'package.json',
    'assets/pets/catalog.json'
  ]);
  for (const tree of config.trees) {
    for (const relative of await committedTreeFiles(sourceRoot, sourceCommit, tree, `${tree} source tree`)) {
      addDestination(destinations, relative, relative);
      sourceFiles.add(relative);
    }
  }
  for (const entry of config.files) {
    await committedBlob(sourceRoot, sourceCommit, entry.source, `${entry.source} source`);
    addDestination(destinations, entry.source, entry.destination);
    sourceFiles.add(entry.source);
  }
  for (const id of config.public_pet_ids) {
    const packageRoot = path.posix.join('assets/pets', id);
    for (const relative of await committedTreeFiles(
      sourceRoot,
      sourceCommit,
      packageRoot,
      `${id} source package`
    )) {
      addDestination(destinations, relative, relative);
      sourceFiles.add(relative);
    }
  }
  for (const generated of [
    '.codex-plugin/plugin.json',
    'assets/pets/catalog.json',
    'package.json'
  ]) {
    if (destinations.has(generated)) fail(`duplicate generated destination ${generated}`);
    destinations.set(generated, null);
  }
  return Object.freeze({
    destinations,
    sourceFiles: Object.freeze([...sourceFiles].sort()),
    expectedPaths: Object.freeze([...destinations.keys(), 'release-manifest.json'].sort())
  });
}

async function assertPublicSourceMatchesHead(sourceRoot, sourceCommit, pathspecs) {
  const { stdout: topLevelOutput } = await execResolvedFile('git', ['rev-parse', '--show-toplevel'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  const topLevel = await realpath(topLevelOutput.trim());
  if (topLevel !== sourceRoot) fail('sourceRoot must be the Git repository top level');

  const head = await resolveSourceCommit(sourceRoot);
  if (sourceCommit !== head) fail('sourceCommit must equal the source repository HEAD');

  const { stdout: status } = await execResolvedFile('git', [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', ...pathspecs
  ], {
    cwd: sourceRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
  if (status.length) {
    fail('public source inputs must exactly match HEAD; modified, staged, untracked, or ignored inputs are not releasable');
  }
}

export async function buildPublicPlugin({
  output,
  sourceRoot = DEFAULT_SOURCE_ROOT,
  configFile,
  sourceCommit
}) {
  if (typeof output !== 'string' || !output) fail('output is required');
  const source = await realpath(path.resolve(sourceRoot));
  const requestedDestination = path.resolve(output);
  let destinationParent;
  try {
    destinationParent = await realpath(path.dirname(requestedDestination));
  } catch {
    fail('output parent must be an existing directory');
  }
  const destination = path.join(destinationParent, path.basename(requestedDestination));
  const destinationRelativeToSource = path.relative(source, destination);
  const destinationIsInsideSource = !destinationRelativeToSource
    || (destinationRelativeToSource !== '..'
      && !destinationRelativeToSource.startsWith(`..${path.sep}`)
      && !path.isAbsolute(destinationRelativeToSource));
  if (destinationIsInsideSource || path.dirname(destination) === destination) {
    fail('output must be outside the source repository and filesystem root');
  }
  if (await detailsOrNull(destination)) fail('output must not already exist');
  const requestedConfigFile = path.resolve(configFile ?? path.join(source, 'release', 'public-files.json'));
  await plainFile(requestedConfigFile, 'public release config');
  const canonicalConfigFile = await realpath(requestedConfigFile);
  const configRelative = sourceRelative(source, canonicalConfigFile, 'public release config');
  const commit = sourceCommit ?? await resolveSourceCommit(source);
  if (!COMMIT_PATTERN.test(commit)) fail('sourceCommit must be a full lowercase commit hash');
  const head = await resolveSourceCommit(source);
  if (commit !== head) fail('sourceCommit must equal the source repository HEAD');
  const config = validateConfig(parseJsonBytes(
    await committedBlob(source, commit, configRelative, 'public release config'),
    'public release config'
  ));
  const sourcePathspecs = publicSourcePathspecs(config, configRelative);
  const policy = await committedReleasePolicy(source, commit, config, configRelative);
  await assertPublicSourceMatchesHead(source, commit, sourcePathspecs);
  let created = false;
  try {
    await mkdir(destination, { recursive: false, mode: 0o755 });
    created = true;
    for (const [destinationRelative, sourceRelativePath] of policy.destinations.entries()) {
      if (sourceRelativePath === null) continue;
      await writePublicFile(
        inside(destination, destinationRelative, `${destinationRelative} destination`),
        await committedBlob(source, commit, sourceRelativePath, `${sourceRelativePath} source`)
      );
    }
    const catalog = await publicCatalog(source, commit, config);
    await writePublicFile(
      path.join(destination, 'assets', 'pets', 'catalog.json'),
      `${JSON.stringify(catalog, null, 2)}\n`
    );
    const plugin = await transformedPluginManifest(source, commit);
    await writePublicFile(
      path.join(destination, '.codex-plugin', 'plugin.json'),
      `${JSON.stringify(plugin, null, 2)}\n`
    );
    const packageJson = await transformedPackageManifest(source, commit);
    await writePublicFile(
      path.join(destination, 'package.json'),
      `${JSON.stringify(packageJson, null, 2)}\n`
    );
    await assertPublicSourceMatchesHead(source, commit, sourcePathspecs);
    const manifest = await createReleaseManifest(destination, {
      packageName: packageJson.name,
      version: packageJson.version,
      sourceCommit: commit,
      publicPetIds: config.public_pet_ids
    });
    await writePublicFile(
      path.join(destination, 'release-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    return verifyPublicPlugin({
      input: destination,
      policyRoot: source,
      configFile: canonicalConfigFile
    });
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyPublicPlugin({ input, policyRoot = DEFAULT_SOURCE_ROOT, configFile }) {
  if (typeof input !== 'string' || !input) fail('input is required');
  const root = await realpath(path.resolve(input));
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) fail('input must be a regular directory');
  const actualPaths = await collectArtifactFiles(root);
  const manifestBytes = await plainFile(path.join(root, 'release-manifest.json'), 'release manifest');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('release manifest is not valid JSON');
  }
  exactKeys(
    manifest,
    ['schema_version', 'package_name', 'version', 'source_commit', 'public_pet_ids', 'files'],
    'release manifest'
  );
  if (manifest.schema_version !== '1' || !COMMIT_PATTERN.test(manifest.source_commit)
      || !Array.isArray(manifest.public_pet_ids) || manifest.public_pet_ids.length < 1
      || !Array.isArray(manifest.files)) {
    fail('release manifest has invalid metadata');
  }
  const trustedSource = await realpath(path.resolve(policyRoot));
  const trustedCommit = await resolveSourceCommit(trustedSource);
  if (manifest.source_commit !== trustedCommit) {
    fail('release manifest source commit does not match the trusted policy source HEAD');
  }
  const requestedConfigFile = path.resolve(
    configFile ?? path.join(trustedSource, 'release', 'public-files.json')
  );
  await plainFile(requestedConfigFile, 'trusted public release config');
  const canonicalConfigFile = await realpath(requestedConfigFile);
  const configRelative = sourceRelative(
    trustedSource,
    canonicalConfigFile,
    'trusted public release config'
  );
  const trustedConfig = validateConfig(parseJsonBytes(
    await committedBlob(
      trustedSource,
      trustedCommit,
      configRelative,
      'trusted public release config'
    ),
    'trusted public release config'
  ));
  const trustedPolicy = await committedReleasePolicy(
    trustedSource,
    trustedCommit,
    trustedConfig,
    configRelative
  );
  await assertPublicSourceMatchesHead(
    trustedSource,
    trustedCommit,
    publicSourcePathspecs(trustedConfig, configRelative)
  );
  const trustedPackage = await transformedPackageManifest(trustedSource, trustedCommit);
  const trustedPlugin = await transformedPluginManifest(trustedSource, trustedCommit);
  const trustedCatalog = await publicCatalog(trustedSource, trustedCommit, trustedConfig);
  const trustedBytes = new Map();
  for (const [destinationRelative, sourceRelativePath] of trustedPolicy.destinations.entries()) {
    let bytes;
    if (sourceRelativePath !== null) {
      bytes = await committedBlob(
        trustedSource,
        trustedCommit,
        sourceRelativePath,
        `${sourceRelativePath} trusted source`
      );
    } else if (destinationRelative === '.codex-plugin/plugin.json') {
      bytes = Buffer.from(`${JSON.stringify(trustedPlugin, null, 2)}\n`);
    } else if (destinationRelative === 'assets/pets/catalog.json') {
      bytes = Buffer.from(`${JSON.stringify(trustedCatalog, null, 2)}\n`);
    } else if (destinationRelative === 'package.json') {
      bytes = Buffer.from(`${JSON.stringify(trustedPackage, null, 2)}\n`);
    } else {
      fail(`trusted policy has no byte derivation for ${destinationRelative}`);
    }
    trustedBytes.set(destinationRelative, bytes);
  }
  const trustedExpectedPaths = new Set(trustedPolicy.expectedPaths);
  if (actualPaths.length !== trustedExpectedPaths.size
      || actualPaths.some((relative) => !trustedExpectedPaths.has(relative))) {
    fail('artifact path set does not exactly match the trusted public release policy');
  }
  const packageJson = await plainJson(path.join(root, 'package.json'), 'public package manifest');
  const plugin = await plainJson(path.join(root, '.codex-plugin', 'plugin.json'), 'public plugin manifest');
  const marketplace = await plainJson(
    path.join(root, '.claude-plugin', 'marketplace.json'),
    'public marketplace manifest'
  );
  const marketplacePlugin = Array.isArray(marketplace.plugins) && marketplace.plugins.length === 1
    ? marketplace.plugins[0]
    : null;
  if (manifest.package_name !== trustedPackage.name || manifest.version !== trustedPackage.version
      || manifest.package_name !== packageJson.name || manifest.version !== packageJson.version
      || plugin.name !== packageJson.name || plugin.version !== packageJson.version) {
    fail('public package, plugin, release manifest, and trusted policy identities do not match');
  }
  if (marketplace.name !== packageJson.name || marketplacePlugin?.name !== packageJson.name
      || marketplacePlugin.source !== './') {
    fail('public marketplace manifest does not match the public package identity');
  }
  await verifyFinalWindowsHelper(root, packageJson.version);
  const catalog = await plainJson(path.join(root, 'assets', 'pets', 'catalog.json'), 'public pet catalog');
  if (catalog.schema_version !== '1' || !Array.isArray(catalog.pets) || catalog.pets.length < 1) {
    fail('public pet catalog contains a non-public or invalid entry');
  }
  const catalogIds = catalog.pets.map((entry) => entry.id);
  if (manifest.public_pet_ids.length !== trustedConfig.public_pet_ids.length
      || manifest.public_pet_ids.some((id, index) => id !== trustedConfig.public_pet_ids[index])
      || catalogIds.length !== manifest.public_pet_ids.length
      || catalogIds.some((id, index) => id !== manifest.public_pet_ids[index])
      || new Set(catalogIds).size !== catalogIds.length) {
    fail('public pet catalog does not match the trusted release policy pet set');
  }
  for (const entry of catalog.pets) {
    if (typeof entry.id !== 'string' || !PET_ID_PATTERN.test(entry.id) || entry.scope !== 'public'
        || entry.available !== true
        || entry.manifestPath !== `./${entry.id}/pet.json`
        || entry.spritesheetPath !== `./${entry.id}/spritesheet.webp`
        || entry.provenancePath !== `./${entry.id}/provenance.json`
        || !SHA256_PATTERN.test(entry.manifestSha256)
        || !SHA256_PATTERN.test(entry.spritesheetSha256)) {
      fail(`public pet catalog contains invalid metadata for ${String(entry.id)}`);
    }
    const packageRoot = path.join(root, 'assets', 'pets', entry.id);
    const manifestPetBytes = await plainFile(path.join(packageRoot, 'pet.json'), `${entry.id} manifest`);
    const spritesheetBytes = await plainFile(path.join(packageRoot, 'spritesheet.webp'), `${entry.id} spritesheet`);
    const provenance = await plainJson(path.join(packageRoot, 'provenance.json'), `${entry.id} provenance`);
    validatePetProvenance(provenance, entry, { requirePublicRights: true });
    if (sha256(manifestPetBytes) !== entry.manifestSha256
        || sha256(spritesheetBytes) !== entry.spritesheetSha256
        || provenance.pet_id !== entry.id || provenance.scope !== 'public'
        || provenance.status !== 'validated' || provenance.redistribution !== 'cleared'
        || provenance.binary_asset_present !== true) {
      fail(`${entry.id} public package provenance or hashes are invalid`);
    }
  }
  const manifestPaths = new Set(['release-manifest.json']);
  let previous = '';
  for (const [index, entry] of manifest.files.entries()) {
    exactKeys(entry, ['path', 'bytes', 'mode', 'sha256'], `release manifest files[${index}]`);
    const relative = safeRelative(entry.path, `release manifest files[${index}].path`);
    if (relative <= previous || manifestPaths.has(relative)) fail('release manifest files must be unique and sorted');
    previous = relative;
    manifestPaths.add(relative);
    if (!trustedExpectedPaths.has(relative)) {
      fail(`release manifest contains a path outside the trusted public release policy: ${relative}`);
    }
    assertNoDeniedPath(relative);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.mode !== '0644'
        || !SHA256_PATTERN.test(entry.sha256)) {
      fail(`release manifest contains invalid metadata for ${relative}`);
    }
    const bytes = await plainFile(inside(root, relative, 'manifest file'), `artifact ${relative}`);
    const expectedBytes = trustedBytes.get(relative);
    if (!expectedBytes || expectedBytes.length !== entry.bytes || sha256(expectedBytes) !== entry.sha256) {
      fail(`release manifest bytes do not match the trusted source commit for ${relative}`);
    }
    if (!bytes.equals(expectedBytes)) {
      fail(`artifact bytes do not match the trusted source commit for ${relative}`);
    }
    if (process.platform !== 'win32') {
      const details = await lstat(inside(root, relative, 'manifest mode file'));
      if ((details.mode & 0o777) !== 0o644) fail(`artifact mode does not match the release manifest for ${relative}`);
    }
  }
  if (manifestPaths.size !== trustedExpectedPaths.size
      || [...trustedExpectedPaths].some((relative) => !manifestPaths.has(relative))) {
    fail('artifact path set does not exactly match the release manifest');
  }
  return Object.freeze({
    schema_version: '1',
    package_name: manifest.package_name,
    version: manifest.version,
    source_commit: manifest.source_commit,
    artifact_root: root,
    file_count: manifest.files.length,
    release_manifest_sha256: sha256(manifestBytes),
    public_pet_ids: Object.freeze(catalogIds)
  });
}
