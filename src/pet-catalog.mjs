import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readPrivateJson,
  resolveDataDir,
  ensurePrivateStatePath,
  withFileLock,
  writePrivateJsonAtomic
} from './state.mjs';
import {
  beginPetTransaction,
  readPetTransactions,
  recordPetTransactionStep
} from './pet-transactions.mjs';

const CATALOG_FILE = fileURLToPath(new URL('../assets/pets/catalog.json', import.meta.url));
const PET_ID_PATTERN = /^buddy-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const PET_SCOPES = new Set(['public', 'private']);
const MAX_CATALOG_PETS = 32;
const PACKAGE_FILES = Object.freeze(['pet.json', 'spritesheet.webp']);
const MANIFEST_KEYS = Object.freeze([
  'description',
  'displayName',
  'id',
  'spriteVersionNumber',
  'spritesheetPath'
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BACKUP_ID_PATTERN = /^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_RIGHTS_BASIS = Object.freeze({
  'original-project-asset': Object.freeze({
    authorizationSource: 'project-original-asset-record',
    rightsHolderRole: 'project-owner'
  }),
  'source-asset-owner-attestation': Object.freeze({
    authorizationSource: 'project-owner-attestation',
    rightsHolderRole: 'project-owner-and-source-asset-owner'
  })
});
const PROVENANCE_KEYS = new Set([
  'schema_version',
  'pet_id',
  'scope',
  'status',
  'redistribution',
  'binary_asset_present',
  'source_type',
  'validation',
  'rights',
  'asset_lineage',
  'notes'
]);
const RIGHTS_KEYS = new Set(['basis', 'rights_holder_role', 'authorization', 'license']);
const AUTHORIZATION_KEYS = new Set(['status', 'date', 'date_status', 'source', 'source_reference']);
const LICENSE_KEYS = new Set(['spdx_expression', 'repository_license_file', 'grant']);
const ASSET_LINEAGE_KEYS = new Set(['source_asset', 'transformation', 'derived_asset']);
const SOURCE_ASSET_KEYS = new Set(['description', 'sha256', 'sha256_status']);
const TRANSFORMATION_KEYS = new Set([
  'method',
  'tool',
  'tool_status',
  'date',
  'date_status',
  'first_repository_recorded_on'
]);
const DERIVED_ASSET_KEYS = new Set(['path', 'sha256']);

export const PUBLIC_PET_LICENSE_GRANT = 'The rights holder licenses this asset and its derivative works to the public under the Apache License, Version 2.0.';

function fail(message) {
  throw new Error(`Buddy pet catalog: ${message}`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}`);
  }
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validateRecordedValue(value, status, label, validateValue) {
  if (value === null) {
    if (status !== 'not-recorded') fail(`${label}_status must be not-recorded when ${label} is null`);
    return;
  }
  if (!validateValue(value)) fail(`${label} is invalid`);
  if (status !== 'recorded') fail(`${label}_status must be recorded when ${label} is present`);
}

function resolveInside(root, relative, label) {
  assertNonEmptyString(relative, label);
  if (path.isAbsolute(relative)) fail(`${label} must be relative`);
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail(`${label} escapes the catalog root`);
  return resolved;
}

async function detailsOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readPlainFile(file, label) {
  const details = await detailsOrNull(file);
  if (!details) fail(`${label} is missing`);
  if (details.isSymbolicLink() || !details.isFile()) fail(`${label} must be a regular non-symlink file`);
  return readFile(file);
}

async function readPlainJson(file, label) {
  const bytes = await readPlainFile(file, label);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

async function assertNoSymlinkedPath(root, file, label) {
  const resolved = await realpath(file).catch((error) => {
    if (error.code === 'ENOENT') fail(`${label} is missing`);
    throw error;
  });
  if (resolved !== file) fail(`${label} must not use symlinked path components`);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail(`${label} resolves outside the catalog root`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(file, label) {
  return sha256(await readPlainFile(file, label));
}

function validateManifest(manifest, entry) {
  assertPlainObject(manifest, `${entry.id} manifest`);
  const keys = Object.keys(manifest).sort();
  if (keys.length !== MANIFEST_KEYS.length || keys.some((key, index) => key !== MANIFEST_KEYS[index])) {
    fail(`${entry.id} manifest contains unsupported or missing fields`);
  }
  if (manifest.id !== entry.id) fail(`${entry.id} manifest id does not match the catalog`);
  if (manifest.displayName !== entry.displayName) fail(`${entry.id} manifest displayName does not match the catalog`);
  if (manifest.description !== entry.description) fail(`${entry.id} manifest description does not match the catalog`);
  if (manifest.spriteVersionNumber !== 2) fail(`${entry.id} manifest must use spriteVersionNumber 2`);
  if (manifest.spritesheetPath !== 'spritesheet.webp') {
    fail(`${entry.id} manifest spritesheetPath must be spritesheet.webp`);
  }
}

export function validatePetProvenance(provenance, entry, options = {}) {
  assertPlainObject(provenance, `${entry.id} provenance`);
  assertAllowedKeys(provenance, PROVENANCE_KEYS, `${entry.id} provenance`);
  if (!PET_SCOPES.has(entry.scope)) fail(`${entry.id} provenance entry scope must be public or private`);
  if (provenance.schema_version !== '1') fail(`${entry.id} provenance schema_version must be 1`);
  if (provenance.pet_id !== entry.id) fail(`${entry.id} provenance pet_id does not match the catalog`);
  if (provenance.scope !== entry.scope) fail(`${entry.id} provenance scope does not match the catalog`);
  assertNonEmptyString(provenance.status, `${entry.id} provenance status`);
  assertNonEmptyString(provenance.redistribution, `${entry.id} provenance redistribution`);
  if (provenance.binary_asset_present !== entry.available) {
    fail(`${entry.id} provenance binary_asset_present does not match availability`);
  }
  if (entry.available && provenance.status !== 'validated') {
    fail(`${entry.id} available asset provenance status must be validated`);
  }
  const expectedRedistribution = entry.scope === 'private' ? 'private-only' : 'cleared';
  if (entry.available && provenance.redistribution !== expectedRedistribution) {
    fail(`${entry.id} available ${entry.scope} asset provenance redistribution must be ${expectedRedistribution}`);
  }

  if (!entry.available || entry.scope !== 'public') return;

  const label = `${entry.id} provenance`;
  const hasRights = provenance.rights !== undefined;
  const hasLineage = provenance.asset_lineage !== undefined;
  if (hasRights !== hasLineage) fail(`${label} rights and asset_lineage must be recorded together`);
  if (!hasRights) {
    if (options.requirePublicRights === true) fail(`${label} rights must be an object`);
    return;
  }

  assertPlainObject(provenance.rights, `${label} rights`);
  assertAllowedKeys(provenance.rights, RIGHTS_KEYS, `${label} rights`);
  assertNonEmptyString(provenance.rights.basis, `${label} rights basis`);
  assertNonEmptyString(provenance.rights.rights_holder_role, `${label} rights_holder_role`);
  if (!Object.hasOwn(PUBLIC_RIGHTS_BASIS, provenance.rights.basis)) {
    fail(`${label} rights basis is unsupported`);
  }
  const expectedRights = PUBLIC_RIGHTS_BASIS[provenance.rights.basis];
  if (provenance.rights.rights_holder_role !== expectedRights.rightsHolderRole) {
    fail(`${label} rights_holder_role does not match its rights basis`);
  }

  assertPlainObject(provenance.rights.authorization, `${label} rights authorization`);
  assertAllowedKeys(provenance.rights.authorization, AUTHORIZATION_KEYS, `${label} rights authorization`);
  const authorization = provenance.rights.authorization;
  if (authorization.status !== 'recorded') fail(`${label} rights authorization status must be recorded`);
  assertNonEmptyString(authorization.source, `${label} rights authorization source`);
  if (authorization.source !== expectedRights.authorizationSource) {
    fail(`${label} rights authorization source does not match its rights basis`);
  }
  if (authorization.source_reference !== 'docs/PROVENANCE.md#pet-asset-rights-records') {
    fail(`${label} rights authorization source_reference is invalid`);
  }
  validateRecordedValue(
    authorization.date,
    authorization.date_status,
    `${label} rights authorization date`,
    isIsoDate
  );
  if (provenance.rights.basis === 'source-asset-owner-attestation' && authorization.date === null) {
    fail(`${label} source-asset owner authorization date must be recorded`);
  }

  assertPlainObject(provenance.rights.license, `${label} rights license`);
  assertAllowedKeys(provenance.rights.license, LICENSE_KEYS, `${label} rights license`);
  if (provenance.rights.license.spdx_expression !== 'Apache-2.0') {
    fail(`${label} rights license must use Apache-2.0`);
  }
  if (provenance.rights.license.repository_license_file !== 'LICENSE') {
    fail(`${label} rights license file must be LICENSE`);
  }
  if (provenance.rights.license.grant !== PUBLIC_PET_LICENSE_GRANT) {
    fail(`${label} rights license grant does not match the public grant`);
  }

  assertPlainObject(provenance.asset_lineage, `${label} asset_lineage`);
  assertAllowedKeys(provenance.asset_lineage, ASSET_LINEAGE_KEYS, `${label} asset_lineage`);
  assertPlainObject(provenance.asset_lineage.source_asset, `${label} source_asset`);
  assertAllowedKeys(provenance.asset_lineage.source_asset, SOURCE_ASSET_KEYS, `${label} source_asset`);
  const sourceAsset = provenance.asset_lineage.source_asset;
  assertNonEmptyString(sourceAsset.description, `${label} source_asset description`);
  validateRecordedValue(
    sourceAsset.sha256,
    sourceAsset.sha256_status,
    `${label} source_asset sha256`,
    (value) => typeof value === 'string' && SHA256_PATTERN.test(value)
  );

  assertPlainObject(provenance.asset_lineage.transformation, `${label} transformation`);
  assertAllowedKeys(provenance.asset_lineage.transformation, TRANSFORMATION_KEYS, `${label} transformation`);
  const transformation = provenance.asset_lineage.transformation;
  assertNonEmptyString(transformation.method, `${label} transformation method`);
  validateRecordedValue(
    transformation.tool,
    transformation.tool_status,
    `${label} transformation tool`,
    (value) => typeof value === 'string' && Boolean(value.trim())
  );
  validateRecordedValue(
    transformation.date,
    transformation.date_status,
    `${label} transformation date`,
    isIsoDate
  );
  if (!isIsoDate(transformation.first_repository_recorded_on)) {
    fail(`${label} transformation first_repository_recorded_on is invalid`);
  }

  assertPlainObject(provenance.asset_lineage.derived_asset, `${label} derived_asset`);
  assertAllowedKeys(provenance.asset_lineage.derived_asset, DERIVED_ASSET_KEYS, `${label} derived_asset`);
  const derivedAsset = provenance.asset_lineage.derived_asset;
  if (derivedAsset.path !== 'spritesheet.webp') fail(`${label} derived_asset path must be spritesheet.webp`);
  if (!SHA256_PATTERN.test(derivedAsset.sha256) || derivedAsset.sha256 !== entry.spritesheetSha256) {
    fail(`${label} derived_asset SHA-256 does not match the catalog`);
  }
}

async function validateEntry(entry, root, seen, options = {}) {
  assertPlainObject(entry, 'catalog pet');
  if (typeof entry.id !== 'string' || !PET_ID_PATTERN.test(entry.id)) {
    fail(`unsupported pet id ${String(entry.id)}`);
  }
  if (seen.has(entry.id)) fail(`duplicate pet id ${entry.id}`);
  seen.add(entry.id);
  assertNonEmptyString(entry.displayName, `${entry.id} displayName`);
  assertNonEmptyString(entry.description, `${entry.id} description`);
  if (!PET_SCOPES.has(entry.scope)) fail(`${entry.id} scope must be public or private`);
  if (entry.spriteVersionNumber !== 2) fail(`${entry.id} must use spriteVersionNumber 2`);
  if (typeof entry.available !== 'boolean') fail(`${entry.id} available must be boolean`);

  const manifestFile = resolveInside(root, entry.manifestPath, `${entry.id} manifestPath`);
  const spritesheetFile = resolveInside(root, entry.spritesheetPath, `${entry.id} spritesheetPath`);
  const provenanceFile = resolveInside(root, entry.provenancePath, `${entry.id} provenancePath`);
  if (path.dirname(manifestFile) !== path.dirname(spritesheetFile)
      || path.dirname(manifestFile) !== path.dirname(provenanceFile)) {
    fail(`${entry.id} package files must share one catalog directory`);
  }
  if (path.basename(path.dirname(manifestFile)) !== entry.id) {
    fail(`${entry.id} package directory must match its pet id`);
  }
  if (path.basename(manifestFile) !== 'pet.json' || path.basename(spritesheetFile) !== 'spritesheet.webp') {
    fail(`${entry.id} package must use pet.json and spritesheet.webp`);
  }

  await assertNoSymlinkedPath(root, manifestFile, `${entry.id} manifest`);
  await assertNoSymlinkedPath(root, provenanceFile, `${entry.id} provenance`);
  if (entry.available) await assertNoSymlinkedPath(root, spritesheetFile, `${entry.id} spritesheet`);
  const manifestBytes = await readPlainFile(manifestFile, `${entry.id} manifest`);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail(`${entry.id} manifest is not valid JSON`);
  }
  const provenance = await readPlainJson(provenanceFile, `${entry.id} provenance`);
  validateManifest(manifest, entry);
  validatePetProvenance(provenance, entry, options);
  if (!SHA256_PATTERN.test(entry.manifestSha256)) fail(`${entry.id} requires a lowercase manifest SHA-256`);
  if (sha256(manifestBytes) !== entry.manifestSha256) fail(`${entry.id} manifest SHA-256 does not match the catalog`);

  if (entry.available) {
    if (!SHA256_PATTERN.test(entry.spritesheetSha256)) fail(`${entry.id} requires a lowercase SHA-256`);
    if (entry.notReadyReason !== null) fail(`${entry.id} available entry must have null notReadyReason`);
    const actual = await sha256File(spritesheetFile, `${entry.id} spritesheet`);
    if (actual !== entry.spritesheetSha256) fail(`${entry.id} spritesheet SHA-256 does not match the catalog`);
  } else {
    assertNonEmptyString(entry.notReadyReason, `${entry.id} notReadyReason`);
    if (entry.spritesheetSha256 !== null) fail(`${entry.id} unavailable entry must have null spritesheetSha256`);
    if (await detailsOrNull(spritesheetFile)) fail(`${entry.id} has an untracked spritesheet while marked unavailable`);
  }

  return Object.freeze({
    ...entry,
    manifestFile,
    spritesheetFile,
    provenanceFile,
    catalogRoot: root,
    manifest: Object.freeze(manifest),
    provenance: Object.freeze(provenance)
  });
}

export async function loadPetCatalog(options = {}) {
  const requestedCatalogFile = path.resolve(options.catalogFile ?? CATALOG_FILE);
  const catalogFile = await realpath(requestedCatalogFile).catch((error) => {
    if (error.code === 'ENOENT') fail('catalog.json is missing');
    throw error;
  });
  const root = path.dirname(catalogFile);
  const defaultCatalogFile = await realpath(path.resolve(CATALOG_FILE)).catch((error) => {
    if (error.code === 'ENOENT') fail('default catalog.json is missing');
    throw error;
  });
  const requirePublicRights = catalogFile === defaultCatalogFile;
  const raw = await readPlainJson(catalogFile, 'catalog.json');
  assertPlainObject(raw, 'catalog.json');
  if (raw.schema_version !== '1') fail('catalog schema_version must be 1');
  if (!Array.isArray(raw.pets) || raw.pets.length < 1 || raw.pets.length > MAX_CATALOG_PETS) {
    fail(`catalog must contain between 1 and ${MAX_CATALOG_PETS} pets`);
  }
  const seen = new Set();
  const pets = [];
  for (const entry of raw.pets) {
    pets.push(await validateEntry(entry, root, seen, { requirePublicRights }));
  }
  return Object.freeze({ schema_version: '1', file: catalogFile, root, pets: Object.freeze(pets) });
}

function catalogPet(catalog, id) {
  if (typeof id !== 'string' || !PET_ID_PATTERN.test(id)) {
    fail(`unknown or non-Buddy pet id ${String(id)}`);
  }
  const entry = catalog.pets.find((pet) => pet.id === id);
  if (!entry) fail(`pet ${id} is not present in this catalog`);
  return entry;
}

export function resolveCodexHome(explicit) {
  return path.resolve(explicit ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
}

async function canonicalCodexHome(explicit, { create = false } = {}) {
  const requested = resolveCodexHome(explicit);
  if (create) await mkdir(requested, { recursive: true, mode: 0o700 });
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    if (!create && error.code === 'ENOENT') return requested;
    throw error;
  }
  const details = await lstat(canonical);
  if (!details.isDirectory()) fail('Codex home must resolve to a directory');
  return canonical;
}

function codexHomeRegistryKey(codexHome) {
  return sha256(Buffer.from(resolveCodexHome(codexHome))).slice(0, 32);
}

function registryFile(dataDir, codexHome) {
  return path.join(
    resolveDataDir(dataDir),
    'pets',
    'homes',
    codexHomeRegistryKey(codexHome),
    'installed.json'
  );
}

function petHomeDataDirectory(dataDir, codexHome) {
  return path.dirname(registryFile(dataDir, codexHome));
}

function legacyRegistryFile(dataDir) {
  return path.join(resolveDataDir(dataDir), 'pets', 'installed.json');
}

function emptyRegistry() {
  return { schema_version: '1', installed: {}, backups: [] };
}

function validateRegistryRecord(record, label, expectedId) {
  assertPlainObject(record, label);
  if (typeof record.id !== 'string' || !PET_ID_PATTERN.test(record.id)) {
    fail(`${label} has an unknown or non-Buddy pet id`);
  }
  if (expectedId !== undefined && record.id !== expectedId) fail(`${label} id does not match its registry key`);
  if (!PET_SCOPES.has(record.scope)) fail(`${label} has an invalid scope`);
  if (!SHA256_PATTERN.test(record.manifest_sha256)) fail(`${label} has an invalid manifest SHA-256`);
  if (!SHA256_PATTERN.test(record.spritesheet_sha256)) fail(`${label} has an invalid spritesheet SHA-256`);
}

function validateRegistry(value) {
  if (value === null) return emptyRegistry();
  assertPlainObject(value, 'pet install registry');
  if (value.schema_version !== '1') fail('unsupported pet install registry schema');
  assertPlainObject(value.installed, 'pet install registry installed');
  if (!Array.isArray(value.backups)) fail('pet install registry backups must be an array');
  for (const [id, record] of Object.entries(value.installed)) {
    if (!PET_ID_PATTERN.test(id)) fail(`pet install registry contains unknown or non-Buddy id ${id}`);
    validateRegistryRecord(record, `pet install registry installed.${id}`, id);
    assertNonEmptyString(record.target, `pet install registry installed.${id}.target`);
    if (!path.isAbsolute(record.target)) fail(`pet install registry installed.${id}.target must be absolute`);
    assertNonEmptyString(record.installed_at, `pet install registry installed.${id}.installed_at`);
  }
  const backupIds = new Set();
  for (const [index, record] of value.backups.entries()) {
    const label = `pet install registry backups[${index}]`;
    validateRegistryRecord(record, label);
    if (typeof record.backup_id !== 'string' || !BACKUP_ID_PATTERN.test(record.backup_id)) {
      fail(`${label}.backup_id is invalid`);
    }
    if (backupIds.has(record.backup_id)) fail(`${label}.backup_id is duplicated`);
    backupIds.add(record.backup_id);
    assertNonEmptyString(record.path, `${label}.path`);
    if (!path.isAbsolute(record.path)) fail(`${label}.path must be absolute`);
    assertNonEmptyString(record.original_target, `${label}.original_target`);
    if (!path.isAbsolute(record.original_target)) fail(`${label}.original_target must be absolute`);
    assertNonEmptyString(record.removed_at, `${label}.removed_at`);
  }
  return value;
}

async function readRegistry(dataDir, codexHome) {
  await ensurePetRegistryDirectory(dataDir, codexHome);
  const current = await readPrivateJson(registryFile(dataDir, codexHome));
  if (current !== null) return validateRegistry(current);

  // v0.2 stored every Codex home in one registry. Read matching records as a
  // non-destructive compatibility view; the next mutation writes the scoped file.
  const legacy = validateRegistry(await readPrivateJson(legacyRegistryFile(dataDir)));
  const petsRoot = path.join(resolveCodexHome(codexHome), 'pets');
  const installed = {};
  for (const [id, record] of Object.entries(legacy.installed)) {
    if (record.target === path.join(petsRoot, id)) installed[id] = record;
  }
  return {
    schema_version: '1',
    installed,
    backups: legacy.backups.filter(
      (record) => record.original_target === path.join(petsRoot, record.id)
    )
  };
}

async function ensurePetRegistryDirectory(dataDir, codexHome) {
  const dataRoot = resolveDataDir(dataDir);
  await ensurePrivateStatePath(dataRoot, path.dirname(registryFile(dataDir, codexHome)));
}

async function ensureDirectory(directory, label) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) fail(`${label} must be a non-symlink directory`);
  return directory;
}

async function assertSafePathAncestors(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} is outside the canonical pets directory`);
  }
  const rootDetails = await detailsOrNull(resolvedRoot);
  if (!rootDetails || rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    fail('Codex pets directory must be an existing non-symlink directory');
  }
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, component);
    const details = await detailsOrNull(current);
    if (!details || details.isSymbolicLink() || !details.isDirectory()) {
      fail(`${label} ancestors must be existing non-symlink directories`);
    }
  }
}

async function assertSafeTransactionPathAncestors(intent, petsRoot) {
  await assertSafePathAncestors(petsRoot, intent.target, 'pet transaction target');
  if (intent.backup) {
    await assertSafePathAncestors(petsRoot, intent.backup.path, 'pet transaction backup');
  }
}

async function syncFile(file) {
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inspectPackage(directory) {
  const details = await detailsOrNull(directory);
  if (!details) return null;
  if (details.isSymbolicLink()) return { safe: false, reason: 'target is a symbolic link' };
  if (!details.isDirectory()) return { safe: false, reason: 'target is not a directory' };
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== PACKAGE_FILES.length || names.some((name, index) => name !== PACKAGE_FILES[index])) {
    return { safe: false, reason: 'package contains unexpected or missing files' };
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) return { safe: false, reason: `${entry.name} is not a regular file` };
  }
  return {
    safe: true,
    manifest_sha256: await sha256File(path.join(directory, 'pet.json'), 'installed pet manifest'),
    spritesheet_sha256: await sha256File(path.join(directory, 'spritesheet.webp'), 'installed pet spritesheet')
  };
}

function hashesMatch(actual, expected) {
  return actual?.safe === true
    && actual.manifest_sha256 === expected.manifest_sha256
    && actual.spritesheet_sha256 === expected.spritesheet_sha256;
}

async function sourcePackage(entry) {
  if (!entry.available) fail(`${entry.id} is not available: ${entry.notReadyReason}`);
  await assertNoSymlinkedPath(entry.catalogRoot, entry.manifestFile, `${entry.id} manifest`);
  await assertNoSymlinkedPath(entry.catalogRoot, entry.spritesheetFile, `${entry.id} spritesheet`);
  const manifestBytes = await readPlainFile(entry.manifestFile, `${entry.id} manifest`);
  const spritesheetBytes = await readPlainFile(entry.spritesheetFile, `${entry.id} spritesheet`);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail(`${entry.id} manifest is not valid JSON`);
  }
  validateManifest(manifest, entry);
  const manifestSha256 = sha256(manifestBytes);
  const spritesheetSha256 = sha256(spritesheetBytes);
  if (manifestSha256 !== entry.manifestSha256) fail(`${entry.id} manifest changed after catalog validation`);
  if (spritesheetSha256 !== entry.spritesheetSha256) fail(`${entry.id} spritesheet changed after catalog validation`);
  return {
    manifest_sha256: manifestSha256,
    spritesheet_sha256: spritesheetSha256,
    manifest_bytes: manifestBytes,
    spritesheet_bytes: spritesheetBytes
  };
}

function installRecord(entry, target, hashes) {
  return {
    id: entry.id,
    scope: entry.scope,
    target,
    manifest_sha256: hashes.manifest_sha256,
    spritesheet_sha256: hashes.spritesheet_sha256,
    installed_at: new Date().toISOString()
  };
}

async function writePackageFile(file, bytes) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyPackage(source, temporary) {
  await mkdir(temporary, { mode: 0o700 });
  const manifestTarget = path.join(temporary, 'pet.json');
  const spritesheetTarget = path.join(temporary, 'spritesheet.webp');
  await writePackageFile(manifestTarget, source.manifest_bytes);
  await writePackageFile(spritesheetTarget, source.spritesheet_bytes);
  await chmod(manifestTarget, 0o600);
  await chmod(spritesheetTarget, 0o600);
  await syncFile(manifestTarget);
  await syncFile(spritesheetTarget);
}

function packageReference(hashes) {
  if (!hashes) return null;
  return {
    manifest_sha256: hashes.manifest_sha256,
    spritesheet_sha256: hashes.spritesheet_sha256
  };
}

function packageReferenceMatches(actual, expected) {
  if (expected === null) return actual === null;
  return hashesMatch(actual, expected);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function transactionIntent({
  operation,
  entry,
  target,
  backup = null,
  beforeTarget,
  afterTarget,
  beforeInstalled,
  afterInstalled,
  beforeBackupRecord = null,
  afterBackupRecord = null,
  result
}) {
  return {
    schema_version: '1',
    operation,
    pet_id: entry.id,
    scope: entry.scope,
    target,
    backup: backup ? { backup_id: backup.backup_id, path: backup.path } : null,
    before: {
      target: packageReference(beforeTarget),
      installed: cloneJson(beforeInstalled ?? null),
      backup_package: packageReference(beforeBackupRecord),
      backup_record: cloneJson(beforeBackupRecord)
    },
    after: {
      target: packageReference(afterTarget),
      installed: cloneJson(afterInstalled ?? null),
      backup_package: packageReference(afterBackupRecord),
      backup_record: cloneJson(afterBackupRecord)
    },
    result: cloneJson(result)
  };
}

function validatePackageReference(reference, label) {
  if (reference === null) return;
  assertPlainObject(reference, label);
  if (!SHA256_PATTERN.test(reference.manifest_sha256)
      || !SHA256_PATTERN.test(reference.spritesheet_sha256)) {
    fail(`${label} has invalid package hashes`);
  }
}

function validateTransactionRegistryRecord(record, label, expectedId, target, backupPath = null) {
  if (record === null) return;
  validateRegistryRecord(record, label, expectedId);
  if (backupPath === null) {
    if (record.target !== target) fail(`${label}.target does not match the transaction target`);
    assertNonEmptyString(record.installed_at, `${label}.installed_at`);
    return;
  }
  if (record.path !== backupPath || record.original_target !== target) {
    fail(`${label} does not match the transaction backup paths`);
  }
  assertNonEmptyString(record.removed_at, `${label}.removed_at`);
}

function validateTransactionIntent(intent, petsRoot) {
  assertPlainObject(intent, 'pet transaction intent');
  if (intent.schema_version !== '1') fail('pet transaction intent has an unsupported schema');
  if (!['install', 'remove', 'restore', 'update'].includes(intent.operation)) {
    fail('pet transaction intent has an unsupported operation');
  }
    if (typeof intent.pet_id !== 'string' || !PET_ID_PATTERN.test(intent.pet_id)) {
      fail('pet transaction intent has an unknown pet id');
    }
    if (!PET_SCOPES.has(intent.scope)) fail('pet transaction intent has an invalid scope');
  const expectedTarget = path.join(petsRoot, intent.pet_id);
  if (intent.target !== expectedTarget) fail('pet transaction intent targets an unexpected path');
  assertPlainObject(intent.before, 'pet transaction before state');
  assertPlainObject(intent.after, 'pet transaction after state');
  assertPlainObject(intent.result, 'pet transaction result');
  validatePackageReference(intent.before.target, 'pet transaction before target');
  validatePackageReference(intent.after.target, 'pet transaction after target');
  let backupPath = null;
  if (intent.backup !== null) {
    assertPlainObject(intent.backup, 'pet transaction backup');
    if (typeof intent.backup.backup_id !== 'string' || !BACKUP_ID_PATTERN.test(intent.backup.backup_id)) {
      fail('pet transaction backup id is invalid');
    }
    backupPath = path.join(
      petsRoot,
      '.buddy-reviewer-backups',
      intent.pet_id,
      intent.backup.backup_id
    );
    if (intent.backup.path !== backupPath) fail('pet transaction backup targets an unexpected path');
  }
  validatePackageReference(intent.before.backup_package, 'pet transaction before backup');
  validatePackageReference(intent.after.backup_package, 'pet transaction after backup');
  if (!backupPath && (intent.before.backup_package !== null || intent.after.backup_package !== null
      || intent.before.backup_record !== null || intent.after.backup_record !== null)) {
    fail('pet transaction without a backup path contains backup state');
  }
  validateTransactionRegistryRecord(
    intent.before.installed,
    'pet transaction before installed record',
    intent.pet_id,
    expectedTarget
  );
  validateTransactionRegistryRecord(
    intent.after.installed,
    'pet transaction after installed record',
    intent.pet_id,
    expectedTarget
  );
  validateTransactionRegistryRecord(
    intent.before.backup_record,
    'pet transaction before backup record',
    intent.pet_id,
    expectedTarget,
    backupPath
  );
  validateTransactionRegistryRecord(
    intent.after.backup_record,
    'pet transaction after backup record',
    intent.pet_id,
    expectedTarget,
    backupPath
  );
  return intent;
}

function registryProjectionMatches(registry, intent, side) {
  const expected = intent[side];
  const actualInstalled = registry.installed[intent.pet_id] ?? null;
  if (JSON.stringify(actualInstalled) !== JSON.stringify(expected.installed)) return false;
  if (!intent.backup) return expected.backup_record === null;
  const actualBackup = registry.backups.find(
    (record) => record.backup_id === intent.backup.backup_id
  ) ?? null;
  return JSON.stringify(actualBackup) === JSON.stringify(expected.backup_record);
}

function applyRegistryProjection(registry, intent, side) {
  const expected = intent[side];
  if (expected.installed === null) delete registry.installed[intent.pet_id];
  else registry.installed[intent.pet_id] = cloneJson(expected.installed);
  if (intent.backup) {
    registry.backups = registry.backups.filter(
      (record) => record.backup_id !== intent.backup.backup_id
    );
    if (expected.backup_record !== null) registry.backups.push(cloneJson(expected.backup_record));
  }
}

async function completeTransaction(transaction, outcome, reason) {
  return recordPetTransactionStep(transaction, 'complete', { outcome, reason });
}

async function reconcileTransactionsLocked({ homeDataDir, petsRoot, registryPath, registry, writeRegistry }) {
  const transactions = await readPetTransactions({ homeDataDir });
  const results = [];
  for (const transaction of transactions) {
    if (!transaction.valid) {
      results.push({ transactionId: transaction.id, outcome: 'needs_attention', reason: transaction.reason });
      continue;
    }
    if (transaction.status !== 'pending') {
      results.push({
        transactionId: transaction.id,
        petId: transaction.intent?.pet_id ?? null,
        operation: transaction.intent?.operation ?? null,
        outcome: transaction.status,
        reason: transaction.steps.complete?.payload?.reason ?? null,
        reconciledNow: false
      });
      continue;
    }
    let intent;
    try {
      intent = validateTransactionIntent(transaction.intent, petsRoot);
    } catch (error) {
      await completeTransaction(transaction, 'needs_attention', 'invalid_intent').catch(() => {});
      results.push({
        transactionId: transaction.id,
        petId: transaction.intent?.pet_id ?? null,
        operation: transaction.intent?.operation ?? null,
        outcome: 'needs_attention',
        reason: 'invalid_intent'
      });
      continue;
    }

    try {
      await assertSafeTransactionPathAncestors(intent, petsRoot);
    } catch {
      await completeTransaction(transaction, 'needs_attention', 'unsafe_transaction_paths').catch(() => {});
      results.push({
        transactionId: transaction.id,
        petId: intent.pet_id,
        operation: intent.operation,
        outcome: 'needs_attention',
        reason: 'unsafe_transaction_paths'
      });
      continue;
    }

    const targetState = await inspectPackage(intent.target);
    const backupState = intent.backup ? await inspectPackage(intent.backup.path) : null;
    const filesystemBefore = packageReferenceMatches(targetState, intent.before.target)
      && (!intent.backup || packageReferenceMatches(backupState, intent.before.backup_package));
    const filesystemAfter = packageReferenceMatches(targetState, intent.after.target)
      && (!intent.backup || packageReferenceMatches(backupState, intent.after.backup_package));
    const registryBefore = registryProjectionMatches(registry, intent, 'before');
    const registryAfter = registryProjectionMatches(registry, intent, 'after');

    const updateInterruptedAfterBackupMove = intent.operation === 'update'
      && intent.backup
      && targetState === null
      && packageReferenceMatches(backupState, intent.before.target)
      && registryBefore
      && !transaction.steps.filesystem_committed
      && !transaction.steps.registry_committed;
    if (updateInterruptedAfterBackupMove) {
      try {
        await assertSafeTransactionPathAncestors(intent, petsRoot);
      } catch {
        await completeTransaction(transaction, 'needs_attention', 'unsafe_transaction_paths').catch(() => {});
        results.push({
          transactionId: transaction.id,
          petId: intent.pet_id,
          operation: intent.operation,
          outcome: 'needs_attention',
          reason: 'unsafe_transaction_paths'
        });
        continue;
      }
      try {
        await rename(intent.backup.path, intent.target);
        const restoredTarget = await inspectPackage(intent.target);
        const removedBackup = await inspectPackage(intent.backup.path);
        if (!packageReferenceMatches(restoredTarget, intent.before.target) || removedBackup !== null) {
          throw new Error('exact rollback verification failed');
        }
        await completeTransaction(transaction, 'rolled_back', 'interrupted_update_exact_backup_restored');
        results.push({
          transactionId: transaction.id,
          petId: intent.pet_id,
          operation: intent.operation,
          outcome: 'rolled_back',
          reason: 'interrupted_update_exact_backup_restored',
          reconciledNow: true
        });
      } catch {
        await completeTransaction(transaction, 'needs_attention', 'interrupted_update_rollback_failed').catch(() => {});
        results.push({
          transactionId: transaction.id,
          petId: intent.pet_id,
          operation: intent.operation,
          outcome: 'needs_attention',
          reason: 'interrupted_update_rollback_failed'
        });
      }
      continue;
    }

    if (filesystemAfter && registryAfter) {
      await recordPetTransactionStep(transaction, 'filesystem_committed', {
        target: intent.target,
        backup: intent.backup?.path ?? null
      });
      await recordPetTransactionStep(transaction, 'registry_committed', { registry: registryPath });
      await completeTransaction(transaction, 'complete', 'exact_after_state');
      results.push({
        transactionId: transaction.id,
        petId: intent.pet_id,
        operation: intent.operation,
        outcome: 'complete',
        result: intent.result,
        reconciledNow: true
      });
      continue;
    }
    if (filesystemAfter && registryBefore && !transaction.steps.registry_committed) {
      await recordPetTransactionStep(transaction, 'filesystem_committed', {
        target: intent.target,
        backup: intent.backup?.path ?? null
      });
      applyRegistryProjection(registry, intent, 'after');
      await writeRegistry(registryPath, registry);
      await recordPetTransactionStep(transaction, 'registry_committed', { registry: registryPath });
      await completeTransaction(transaction, 'complete', 'registry_reconciled_from_exact_hashes');
      results.push({
        transactionId: transaction.id,
        petId: intent.pet_id,
        operation: intent.operation,
        outcome: 'complete',
        result: intent.result,
        reconciledNow: true
      });
      continue;
    }
    if (filesystemBefore && registryBefore
        && !transaction.steps.filesystem_committed
        && !transaction.steps.registry_committed) {
      await completeTransaction(transaction, 'rolled_back', 'exact_before_state');
      results.push({
        transactionId: transaction.id,
        petId: intent.pet_id,
        operation: intent.operation,
        outcome: 'rolled_back',
        reason: 'exact_before_state',
        reconciledNow: true
      });
      continue;
    }

    await completeTransaction(transaction, 'needs_attention', 'state_does_not_match_exact_before_or_after');
    results.push({
      transactionId: transaction.id,
      petId: intent.pet_id,
      operation: intent.operation,
      outcome: 'needs_attention',
      reason: 'state_does_not_match_exact_before_or_after'
    });
  }
  return { registry, transactions: results };
}

function assertNoTransactionNeedsAttention(results, petId) {
  const blocked = results.find(
    (result) => result.outcome === 'needs_attention'
      && (petId === null || !result.petId || result.petId === petId)
  );
  if (blocked) fail(`transaction ${blocked.transactionId} needs_attention before ${petId} can be changed`);
}

function reconciledOperationResult(results, operation, petId, predicate = () => true) {
  return results.find(
    (result) => result.reconciledNow === true
      && result.outcome === 'complete'
      && result.operation === operation
      && result.petId === petId
      && result.result
      && predicate(result.result)
  )?.result ?? null;
}

async function beginOperationTransaction(homeDataDir, intent) {
  return beginPetTransaction({ homeDataDir, intent });
}

export async function reconcilePetTransactions(options = {}) {
  const codexHome = await canonicalCodexHome(options.codexHome, { create: true });
  const petsRoot = await ensureDirectory(path.join(codexHome, 'pets'), 'Codex pets directory');
  const registryPath = registryFile(options.dataDir, codexHome);
  const homeDataDir = petHomeDataDirectory(options.dataDir, codexHome);
  const writeRegistry = options.writeRegistry ?? writePrivateJsonAtomic;
  await ensurePetRegistryDirectory(options.dataDir, codexHome);
  return withFileLock(registryPath, async () => {
    const registry = await readRegistry(options.dataDir, codexHome);
    return reconcileTransactionsLocked({
      homeDataDir,
      petsRoot,
      registryPath,
      registry,
      writeRegistry
    });
  });
}

export async function installPet(id, options = {}) {
  const catalog = await loadPetCatalog(options);
  const entry = catalogPet(catalog, id);
  const expected = await sourcePackage(entry);
  const codexHome = await canonicalCodexHome(options.codexHome, { create: true });
  const petsRoot = await ensureDirectory(path.join(codexHome, 'pets'), 'Codex pets directory');
  const target = path.join(petsRoot, entry.id);
  const stagingRoot = await ensureDirectory(path.join(petsRoot, '.buddy-reviewer-staging'), 'Buddy pet staging directory');
  const registryPath = registryFile(options.dataDir, codexHome);
  const homeDataDir = petHomeDataDirectory(options.dataDir, codexHome);
  const writeRegistry = options.writeRegistry ?? writePrivateJsonAtomic;
  await ensurePetRegistryDirectory(options.dataDir, codexHome);

  return withFileLock(registryPath, async () => {
    let registry = await readRegistry(options.dataDir, codexHome);
    const reconciled = await reconcileTransactionsLocked({
      homeDataDir, petsRoot, registryPath, registry, writeRegistry
    });
    registry = reconciled.registry;
    assertNoTransactionNeedsAttention(reconciled.transactions, entry.id);
    const existing = await inspectPackage(target);
    if (existing) {
      if (!hashesMatch(existing, expected)) fail(`refusing to overwrite differing target ${target}: ${existing.reason ?? 'hash mismatch'}`);
      const result = { action: 'already_installed', id: entry.id, displayName: entry.displayName, target, scope: entry.scope };
      const installedRecord = installRecord(entry, target, expected);
      const intent = transactionIntent({
        operation: 'install', entry, target,
        beforeTarget: existing,
        afterTarget: expected,
        beforeInstalled: registry.installed[entry.id] ?? null,
        afterInstalled: installedRecord,
        result
      });
      const transaction = await beginOperationTransaction(homeDataDir, intent);
      try {
        await recordPetTransactionStep(transaction, 'filesystem_committed', { target, backup: null });
        registry.installed[entry.id] = installedRecord;
        await writeRegistry(registryPath, registry);
        await recordPetTransactionStep(transaction, 'registry_committed', { registry: registryPath });
        await completeTransaction(transaction, 'complete', 'install_already_present_exact_hashes');
      } catch (error) {
        throw new Error(
          `installed package was preserved at ${target}, but its ownership registry update failed; rerun install to reconcile it`,
          { cause: error }
        );
      }
      return result;
    }

    const result = { action: 'installed', id: entry.id, displayName: entry.displayName, target, scope: entry.scope };
    const installedRecord = installRecord(entry, target, expected);
    const intent = transactionIntent({
      operation: 'install', entry, target,
      beforeTarget: null,
      afterTarget: expected,
      beforeInstalled: registry.installed[entry.id] ?? null,
      afterInstalled: installedRecord,
      result
    });
    const transaction = await beginOperationTransaction(homeDataDir, intent);
    const temporary = path.join(stagingRoot, `${entry.id}-${randomUUID()}`);
    let installed = false;
    try {
      await copyPackage(expected, temporary);
      const copied = await inspectPackage(temporary);
      if (!hashesMatch(copied, expected)) fail(`${entry.id} staged package failed hash verification`);
      if (await detailsOrNull(target)) fail(`target ${target} appeared during installation`);
      await rename(temporary, target);
      installed = true;
      try {
        await recordPetTransactionStep(transaction, 'filesystem_committed', { target, backup: null });
        registry.installed[entry.id] = installedRecord;
        await writeRegistry(registryPath, registry);
        await recordPetTransactionStep(transaction, 'registry_committed', { registry: registryPath });
        await completeTransaction(transaction, 'complete', 'installed_exact_hashes');
      } catch (error) {
        throw new Error(
          `installed package was preserved at ${target}, but its ownership registry update failed; rerun install to reconcile it`,
          { cause: error }
        );
      }
      return result;
    } finally {
      if (!installed) await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function removePet(id, options = {}) {
  const catalog = await loadPetCatalog(options);
  const entry = catalogPet(catalog, id);
  const codexHome = await canonicalCodexHome(options.codexHome, { create: true });
  const petsRoot = await ensureDirectory(path.join(codexHome, 'pets'), 'Codex pets directory');
  const target = path.join(petsRoot, entry.id);
  const registryPath = registryFile(options.dataDir, codexHome);
  const homeDataDir = petHomeDataDirectory(options.dataDir, codexHome);
  const writeRegistry = options.writeRegistry ?? writePrivateJsonAtomic;
  await ensurePetRegistryDirectory(options.dataDir, codexHome);

  return withFileLock(registryPath, async () => {
    let registry = await readRegistry(options.dataDir, codexHome);
    const reconciled = await reconcileTransactionsLocked({
      homeDataDir, petsRoot, registryPath, registry, writeRegistry
    });
    registry = reconciled.registry;
    assertNoTransactionNeedsAttention(reconciled.transactions, entry.id);
    const reconciledRemove = reconciledOperationResult(reconciled.transactions, 'remove', entry.id);
    if (reconciledRemove) return reconciledRemove;
    const owned = registry.installed[entry.id];
    if (!owned || owned.target !== target) fail(`${entry.id} is not recorded as a Buddy-owned installation`);
    const current = await inspectPackage(target);
    if (!current) fail(`${entry.id} is recorded as installed but its target is missing`);
    if (!hashesMatch(current, owned)) {
      fail(`refusing to remove modified or unsafe target ${target}: ${current.reason ?? 'hash mismatch'}`);
    }

    const backupsRoot = await ensureDirectory(
      path.join(petsRoot, '.buddy-reviewer-backups'),
      'Buddy pet backups directory'
    );
    const backupRoot = await ensureDirectory(path.join(backupsRoot, entry.id), 'Buddy pet backup directory');
    const backupId = `${Date.now()}-${randomUUID()}`;
    const backup = path.join(backupRoot, backupId);
    const record = {
      backup_id: backupId,
      id: entry.id,
      scope: entry.scope,
      path: backup,
      original_target: target,
      manifest_sha256: owned.manifest_sha256,
      spritesheet_sha256: owned.spritesheet_sha256,
      removed_at: new Date().toISOString()
    };
    const result = {
      action: 'removed_to_backup', id: entry.id, displayName: entry.displayName, target, backupId, backup
    };
    const intent = transactionIntent({
      operation: 'remove', entry, target,
      backup: { backup_id: backupId, path: backup },
      beforeTarget: current,
      afterTarget: null,
      beforeInstalled: owned,
      afterInstalled: null,
      beforeBackupRecord: null,
      afterBackupRecord: record,
      result
    });
    const transaction = await beginOperationTransaction(homeDataDir, intent);
    await rename(target, backup);
    try {
      await recordPetTransactionStep(transaction, 'filesystem_committed', { target, backup });
      delete registry.installed[entry.id];
      registry.backups.push(record);
      await writeRegistry(registryPath, registry);
      await recordPetTransactionStep(transaction, 'registry_committed', { registry: registryPath });
      await completeTransaction(transaction, 'complete', 'removed_to_exact_backup');
    } catch (error) {
      throw new Error(
        `pet package was preserved at recovery path ${backup}, but its ownership registry update failed; do not delete that recovery path`,
        { cause: error }
      );
    }
    return result;
  });
}

export async function restorePet(backupId, options = {}) {
  if (typeof backupId !== 'string' || !BACKUP_ID_PATTERN.test(backupId)) fail('invalid backup id');
  const catalog = await loadPetCatalog(options);
  const codexHome = await canonicalCodexHome(options.codexHome, { create: true });
  const petsRoot = await ensureDirectory(path.join(codexHome, 'pets'), 'Codex pets directory');
  const registryPath = registryFile(options.dataDir, codexHome);
  const homeDataDir = petHomeDataDirectory(options.dataDir, codexHome);
  const writeRegistry = options.writeRegistry ?? writePrivateJsonAtomic;
  await ensurePetRegistryDirectory(options.dataDir, codexHome);

  return withFileLock(registryPath, async () => {
    let registry = await readRegistry(options.dataDir, codexHome);
    const reconciled = await reconcileTransactionsLocked({
      homeDataDir, petsRoot, registryPath, registry, writeRegistry
    });
    registry = reconciled.registry;
    assertNoTransactionNeedsAttention(reconciled.transactions, null);
    const reconciledRestore = reconciled.transactions.find(
      (result) => result.reconciledNow === true
        && result.outcome === 'complete'
        && result.operation === 'restore'
        && result.result?.backupId === backupId
    )?.result;
    if (reconciledRestore) return reconciledRestore;
    const record = registry.backups.find((item) => item?.backup_id === backupId);
    if (!record) fail(`backup ${backupId} is not recorded`);
    const entry = catalogPet(catalog, record.id);
    const target = path.join(petsRoot, entry.id);
    if (record.original_target !== target) fail(`backup ${backupId} targets an unexpected path`);
    const backupsRoot = path.join(petsRoot, '.buddy-reviewer-backups');
    const backupRootDetails = await detailsOrNull(backupsRoot);
    if (!backupRootDetails || backupRootDetails.isSymbolicLink() || !backupRootDetails.isDirectory()) {
      fail('Buddy pet backups directory must be an existing non-symlink directory');
    }
    const expectedBackupRoot = path.join(backupsRoot, entry.id);
    const petBackupRootDetails = await detailsOrNull(expectedBackupRoot);
    if (!petBackupRootDetails || petBackupRootDetails.isSymbolicLink() || !petBackupRootDetails.isDirectory()) {
      fail(`${entry.id} backup directory must be an existing non-symlink directory`);
    }
    const expectedBackup = path.join(expectedBackupRoot, backupId);
    if (record.path !== expectedBackup) {
      fail(`backup ${backupId} has an unexpected path`);
    }
    if (await detailsOrNull(target)) fail(`refusing to restore over existing target ${target}`);
    const current = await inspectPackage(record.path);
    if (!hashesMatch(current, record)) {
      fail(`refusing to restore modified or unsafe backup ${backupId}: ${current?.reason ?? 'hash mismatch'}`);
    }

    const installedRecord = installRecord(entry, target, record);
    const result = { action: 'restored', id: entry.id, displayName: entry.displayName, target, backupId };
    const intent = transactionIntent({
      operation: 'restore', entry, target,
      backup: { backup_id: backupId, path: record.path },
      beforeTarget: null,
      afterTarget: record,
      beforeInstalled: registry.installed[entry.id] ?? null,
      afterInstalled: installedRecord,
      beforeBackupRecord: record,
      afterBackupRecord: null,
      result
    });
    const transaction = await beginOperationTransaction(homeDataDir, intent);
    await rename(record.path, target);
    try {
      await recordPetTransactionStep(transaction, 'filesystem_committed', { target, backup: record.path });
      registry.backups = registry.backups.filter((item) => item.backup_id !== backupId);
      registry.installed[entry.id] = installedRecord;
      await writeRegistry(registryPath, registry);
      await recordPetTransactionStep(transaction, 'registry_committed', { registry: registryPath });
      await completeTransaction(transaction, 'complete', 'restored_from_exact_backup');
    } catch (error) {
      throw new Error(
        `restored package was preserved at ${target}, but its ownership registry update failed; do not delete that recovery path`,
        { cause: error }
      );
    }
    return result;
  });
}

export async function updatePet(id, options = {}) {
  const catalog = await loadPetCatalog(options);
  const entry = catalogPet(catalog, id);
  const expected = await sourcePackage(entry);
  const codexHome = await canonicalCodexHome(options.codexHome, { create: true });
  const petsRoot = await ensureDirectory(path.join(codexHome, 'pets'), 'Codex pets directory');
  const target = path.join(petsRoot, entry.id);
  const stagingRoot = await ensureDirectory(
    path.join(petsRoot, '.buddy-reviewer-staging'),
    'Buddy pet staging directory'
  );
  const registryPath = registryFile(options.dataDir, codexHome);
  const homeDataDir = petHomeDataDirectory(options.dataDir, codexHome);
  const writeRegistry = options.writeRegistry ?? writePrivateJsonAtomic;
  const renamePath = options.renamePath ?? rename;
  await ensurePetRegistryDirectory(options.dataDir, codexHome);

  return withFileLock(registryPath, async () => {
    let registry = await readRegistry(options.dataDir, codexHome);
    const reconciled = await reconcileTransactionsLocked({
      homeDataDir, petsRoot, registryPath, registry, writeRegistry
    });
    registry = reconciled.registry;
    assertNoTransactionNeedsAttention(reconciled.transactions, entry.id);
    const reconciledUpdate = reconciledOperationResult(reconciled.transactions, 'update', entry.id);
    if (reconciledUpdate) return reconciledUpdate;

    const owned = registry.installed[entry.id];
    if (!owned || owned.target !== target) fail(`${entry.id} is not recorded as a Buddy-owned installation`);
    const current = await inspectPackage(target);
    if (!current || !hashesMatch(current, owned)) {
      fail(`refusing to update modified, missing, or unsafe target ${target}: ${current?.reason ?? 'hash mismatch'}`);
    }
    if (hashesMatch(current, expected)) {
      return {
        action: 'already_current', id: entry.id, displayName: entry.displayName,
        target, scope: entry.scope
      };
    }

    const backupsRoot = await ensureDirectory(
      path.join(petsRoot, '.buddy-reviewer-backups'),
      'Buddy pet backups directory'
    );
    const backupRoot = await ensureDirectory(path.join(backupsRoot, entry.id), 'Buddy pet backup directory');
    const backupId = `${Date.now()}-${randomUUID()}`;
    const backup = path.join(backupRoot, backupId);
    const backupRecord = {
      backup_id: backupId,
      id: entry.id,
      scope: entry.scope,
      path: backup,
      original_target: target,
      manifest_sha256: owned.manifest_sha256,
      spritesheet_sha256: owned.spritesheet_sha256,
      removed_at: new Date().toISOString()
    };
    const installedRecord = installRecord(entry, target, expected);
    const result = {
      action: 'updated', id: entry.id, displayName: entry.displayName,
      target, scope: entry.scope, backupId, backup
    };
    const intent = transactionIntent({
      operation: 'update', entry, target,
      backup: { backup_id: backupId, path: backup },
      beforeTarget: current,
      afterTarget: expected,
      beforeInstalled: owned,
      afterInstalled: installedRecord,
      beforeBackupRecord: null,
      afterBackupRecord: backupRecord,
      result
    });
    const transaction = await beginOperationTransaction(homeDataDir, intent);
    const temporary = path.join(stagingRoot, `${entry.id}-${randomUUID()}`);
    try {
      await copyPackage(expected, temporary);
      const staged = await inspectPackage(temporary);
      if (!hashesMatch(staged, expected)) fail(`${entry.id} staged update failed hash verification`);
      if (await detailsOrNull(backup)) fail(`update backup ${backup} appeared before commit`);

      await renamePath(target, backup);
      try {
        await renamePath(temporary, target);
      } catch (error) {
        const targetAfterFailure = await inspectPackage(target);
        const backupAfterFailure = await inspectPackage(backup);
        if (targetAfterFailure === null && hashesMatch(backupAfterFailure, owned)) {
          try {
            await renamePath(backup, target);
            const restored = await inspectPackage(target);
            if (!hashesMatch(restored, owned) || await detailsOrNull(backup)) {
              throw new Error('rollback hash verification failed');
            }
            await completeTransaction(transaction, 'rolled_back', 'update_publish_failed_original_restored');
          } catch (rollbackError) {
            await completeTransaction(transaction, 'needs_attention', 'update_rollback_failed').catch(() => {});
            throw new Error(
              `update could not publish or restore ${target}; transaction ${transaction.id} needs_attention`,
              { cause: rollbackError }
            );
          }
          throw new Error(`update failed before commit; the original package was restored at ${target}`, { cause: error });
        }
        await completeTransaction(transaction, 'needs_attention', 'update_publish_state_ambiguous').catch(() => {});
        throw new Error(
          `update left an ambiguous package state at ${target}; transaction ${transaction.id} needs_attention`,
          { cause: error }
        );
      }

      const published = await inspectPackage(target);
      const rollback = await inspectPackage(backup);
      if (!hashesMatch(published, expected) || !hashesMatch(rollback, owned)) {
        await completeTransaction(transaction, 'needs_attention', 'update_commit_hash_verification_failed').catch(() => {});
        fail(`update hash verification failed; transaction ${transaction.id} needs_attention`);
      }

      try {
        await recordPetTransactionStep(transaction, 'filesystem_committed', { target, backup });
        registry.installed[entry.id] = installedRecord;
        registry.backups.push(backupRecord);
        await writeRegistry(registryPath, registry);
        await recordPetTransactionStep(transaction, 'registry_committed', { registry: registryPath });
        await completeTransaction(transaction, 'complete', 'updated_with_exact_rollback_backup');
      } catch (error) {
        throw new Error(
          `updated package was preserved at ${target} and rollback backup at ${backup}, but the ownership registry update failed; rerun update to reconcile it`,
          { cause: error }
        );
      }
      return result;
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function listPets(options = {}) {
  const catalog = await loadPetCatalog(options);
  return catalog.pets.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    description: entry.description,
    scope: entry.scope,
    spriteVersionNumber: entry.spriteVersionNumber,
    available: entry.available,
    notReadyReason: entry.notReadyReason
  }));
}

export async function petStatus(options = {}) {
  const catalog = await loadPetCatalog(options);
  const codexHome = await canonicalCodexHome(options.codexHome);
  const petsRoot = path.join(codexHome, 'pets');
  const registry = await readRegistry(options.dataDir, codexHome);
  const statuses = [];
  for (const entry of catalog.pets) {
    const target = path.join(petsRoot, entry.id);
    const current = await inspectPackage(target);
    const owned = registry.installed[entry.id];
    let installStatus = 'not_installed';
    if (current && !owned) installStatus = current.safe ? 'unowned' : 'unsafe';
    if (current && owned) {
      installStatus = owned.target === target && hashesMatch(current, owned) ? 'installed' : 'modified';
    }
    if (!current && owned) installStatus = 'missing';
    statuses.push({
      id: entry.id,
      displayName: entry.displayName,
      scope: entry.scope,
      available: entry.available,
      installStatus,
      target
    });
  }
  return { pets: statuses, backups: registry.backups.map((item) => ({ backupId: item.backup_id, id: item.id })) };
}
