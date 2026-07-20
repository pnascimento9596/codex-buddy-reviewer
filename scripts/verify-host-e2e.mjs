#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { escapeDiagnosticLine, escapeTerminalControls, hasUnsafeTerminalControls } from '../src/policy.mjs';
import { canonicalJson, opaqueKey, workspaceKey } from '../src/state.mjs';

export const MACHINE_HOST_GATES = Object.freeze([
  'release_artifact',
  'installed_snapshot',
  'workspace_identity',
  'installed_pet',
  'turn_receipt',
  'review_completed_outbox',
  'continuation_observed'
]);

export const MANUAL_HOST_GATES = Object.freeze([
  'command_menu_discovery',
  'no_argument_toggle',
  'hook_trust_completed',
  'combined_stop_continuation',
  'stop_continuation_no_loop'
]);

export const MANUAL_VISUAL_GATES = Object.freeze([
  'pet_visible_before_turn',
  'pet_running_during_worker',
  'pet_running_during_review',
  'pet_ready_after_completion'
]);

const REPORT_SCHEMA_VERSION = '2';
const RELEASE_SCHEMA_VERSION = '1';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const WORKSPACE_PATTERN = /^[0-9a-f]{16}$/;
const OPAQUE_PATTERN = /^[0-9a-f]{24}$/;
const PET_ID_PATTERN = /^buddy-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 128 * 1024;
const MAX_SECRET_BASE64_BYTES = 48 * 1024;
const MAX_SECRET_GZIP_BYTES = 36 * 1024;
const BUNDLE_SCHEMA_VERSION = '1';
const SUCCESSFUL_REVIEW_STATUSES = new Set(['findings', 'no_findings', 'abstain']);
const REVIEW_PROVIDERS = new Set(['claude', 'grok', 'ollama', 'opencode']);
const REVIEWER_RUN_STATUSES = new Set(['succeeded', 'failed', 'circuit_open']);

const MACHINE_EVIDENCE_KEYS = Object.freeze({
  release_artifact: ['artifact_sha256', 'file_count', 'release_manifest_sha256'],
  installed_snapshot: ['file_count', 'snapshot_sha256'],
  workspace_identity: ['workspace_key'],
  installed_pet: ['manifest_sha256', 'pet_id', 'spritesheet_sha256'],
  turn_receipt: [
    'baseline_tree', 'changed_path_count', 'created_at', 'final_tree', 'model', 'patch_hash',
    'provider', 'receipt_sha256', 'review_key', 'reviewers', 'terminal_status'
  ],
  review_completed_outbox: ['event_id', 'occurred_at', 'outbox_sha256', 'review_key'],
  continuation_observed: [
    'completed_sha256', 'presentation_observed_at', 'presentation_status', 'review_key', 'terminal_status'
  ]
});

const HELP = `Codex Buddy host evidence v2

Usage:
  verify-host-e2e.mjs collect \\
    --artifact <public-artifact-directory> \\
    --installed-snapshot <installed-plugin-directory> \\
    --workspace <acceptance-repository> \\
    --runtime-data-dir <PLUGIN_DATA-directory> \\
    --codex-home <Codex-home> \\
    --pet-id <public-pet-id> \\
    --session-id <host-session-id> \\
    --turn-id <host-turn-id> \\
    --task-reference <private-reference> \\
    --started-at <ISO-timestamp> \\
    --output <new-report.json> [--json]
  verify-host-e2e.mjs validate --report <report.json> [--json]
  verify-host-e2e.mjs validate-bundle \\
    --artifact <public-artifact-directory> \\
    --bundle <bundle.json> [--json]
  verify-host-e2e.mjs decode-bundle-secret \\
    --output <new-bundle.json>

Collect derives release, installed-snapshot, pet, receipt, outbox, and completed
evidence from the filesystem and writes a mode-0600 report without overwriting.
It never operates Codex or contacts a provider. The operator may then edit only
the manual_host_gates and manual_visual_gates blocks before validate.

Machine evidence cannot prove hook trust, command-menu discovery, the visible
combined response, absence of a visible host loop, or native pet animation.
Those remain explicit manual_pass/manual_fail attestations.

Validate-bundle is the final-release gate. It requires a strict bundle with
exactly one complete, individually valid, artifact-bound v2 report for every
public pet named by the release manifest.

Decode-bundle-secret reads one canonical base64-encoded, single-member gzip
stream from stdin, enforces the GitHub secret and decompressed bundle limits,
and writes a mode-0600 JSON file without overwriting.
`;

class HostEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostEvidenceError';
    this.evidenceCode = code;
  }
}

function fail(code, message) {
  throw new HostEvidenceError(code, message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function gzipHeaderEnd(bytes) {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) {
    fail('host_evidence_bundle_compression', 'host evidence bundle secret must contain one gzip stream');
  }
  const flags = bytes[3];
  if ((flags & 0xe0) !== 0) {
    fail('host_evidence_bundle_compression', 'host evidence bundle gzip header uses reserved flags');
  }
  let offset = 10;
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > bytes.length) {
      fail('host_evidence_bundle_compression', 'host evidence bundle gzip extra field is truncated');
    }
    const length = bytes.readUInt16LE(offset);
    offset += 2 + length;
    if (offset > bytes.length) {
      fail('host_evidence_bundle_compression', 'host evidence bundle gzip extra field is truncated');
    }
  }
  for (const flag of [0x08, 0x10]) {
    if ((flags & flag) === 0) continue;
    const terminator = bytes.indexOf(0, offset);
    if (terminator < 0) {
      fail('host_evidence_bundle_compression', 'host evidence bundle gzip text field is unterminated');
    }
    offset = terminator + 1;
  }
  if ((flags & 0x02) !== 0) {
    if (offset + 2 > bytes.length) {
      fail('host_evidence_bundle_compression', 'host evidence bundle gzip header checksum is truncated');
    }
    if ((crc32(bytes.subarray(0, offset)) & 0xffff) !== bytes.readUInt16LE(offset)) {
      fail('host_evidence_bundle_compression', 'host evidence bundle gzip header checksum is invalid');
    }
    offset += 2;
  }
  if (offset + 8 > bytes.length) {
    fail('host_evidence_bundle_compression', 'host evidence bundle gzip body is truncated');
  }
  return offset;
}

export function decodeHostEvidenceBundleSecret(encoded) {
  const encodedBytes = Buffer.isBuffer(encoded) ? encoded : Buffer.from(String(encoded ?? ''), 'utf8');
  if (!encodedBytes.length || encodedBytes.length > MAX_SECRET_BASE64_BYTES) {
    fail(
      'host_evidence_bundle_secret_oversized',
      'host evidence bundle secret is empty or exceeds the 48 KiB base64 limit'
    );
  }
  const text = encodedBytes.toString('ascii');
  if (encodedBytes.some((byte) => byte > 0x7f) || text.length !== encodedBytes.length || text.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    fail(
      'host_evidence_bundle_secret_malformed',
      'host evidence bundle secret must be canonical single-line base64'
    );
  }
  const compressed = Buffer.from(text, 'base64');
  if (compressed.toString('base64') !== text) {
    fail(
      'host_evidence_bundle_secret_malformed',
      'host evidence bundle secret must be canonical single-line base64'
    );
  }
  if (compressed.length > MAX_SECRET_GZIP_BYTES) {
    fail(
      'host_evidence_bundle_secret_oversized',
      'host evidence bundle secret exceeds the 36 KiB compressed limit'
    );
  }
  const bodyOffset = gzipHeaderEnd(compressed);
  let result;
  try {
    result = inflateRawSync(compressed.subarray(bodyOffset), {
      info: true,
      maxOutputLength: MAX_BUNDLE_BYTES
    });
  } catch {
    fail(
      'host_evidence_bundle_compression',
      'host evidence bundle gzip body is malformed or exceeds 128 KiB'
    );
  }
  const trailerOffset = bodyOffset + result.engine.bytesWritten;
  if (trailerOffset + 8 !== compressed.length) {
    fail(
      'host_evidence_bundle_compression',
      'host evidence bundle gzip stream has trailing data or multiple members'
    );
  }
  const expectedCrc = compressed.readUInt32LE(trailerOffset);
  const expectedSize = compressed.readUInt32LE(trailerOffset + 4);
  if (crc32(result.buffer) !== expectedCrc || result.buffer.length !== expectedSize) {
    fail('host_evidence_bundle_compression', 'host evidence bundle gzip trailer is invalid');
  }
  return result.buffer;
}

async function readBoundedStdin(maximum) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maximum) {
      fail(
        'host_evidence_bundle_secret_oversized',
        'host evidence bundle secret exceeds the 48 KiB base64 limit'
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function boundedText(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || hasUnsafeTerminalControls(value)) {
    throw new Error(`${label} must be non-empty, terminal-safe text of at most ${maximum} characters`);
  }
  return value;
}

function strictTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function timestampWithin(value, startedAt, collectedAt, label) {
  strictTimestamp(value, label);
  if (Date.parse(value) < Date.parse(startedAt) || Date.parse(value) > Date.parse(collectedAt)) {
    throw new Error(`${label} is outside the host evidence collection window`);
  }
}

async function detailsOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function canonicalDirectory(requested, label, { rejectRootSymlink = false } = {}) {
  if (typeof requested !== 'string' || !requested) fail(`${label}_missing`, `${label} is required`);
  const resolved = path.resolve(requested);
  const details = await detailsOrNull(resolved);
  if (!details || !details.isDirectory()) fail(`${label}_missing`, `${label} must be an existing directory`);
  if (rejectRootSymlink && details.isSymbolicLink()) fail(`${label}_unsafe`, `${label} must not be a symbolic link`);
  return realpath(resolved);
}

async function regularBytes(file, label, maximum = MAX_FILE_BYTES) {
  const details = await detailsOrNull(file);
  if (!details || details.isSymbolicLink() || !details.isFile()) fail(`${label}_unsafe`, `${label} must be a regular non-symlink file`);
  if (details.size > maximum) fail(`${label}_oversized`, `${label} exceeds its byte limit`);
  return readFile(file);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label}_malformed`, `${label} is not valid JSON`);
  }
}

async function collectTree(root, relative = '', files = []) {
  const directory = relative ? path.join(root, ...relative.split('/')) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail('tree_symlink', `tree contains a symbolic link at ${child}`);
    if (entry.isDirectory()) await collectTree(root, child, files);
    else if (entry.isFile()) {
      const bytes = await regularBytes(path.join(root, ...child.split('/')), 'tree_file');
      files.push({ path: child, bytes: bytes.length, sha256: sha256(bytes) });
    } else fail('tree_unsupported_type', `tree contains an unsupported filesystem type at ${child}`);
  }
  return files;
}

function treeSha256(files) {
  return sha256(Buffer.from(canonicalJson(files.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes,
    sha256: entry.sha256
  })))));
}

function safeManifestPath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value)) {
    fail('release_manifest_path', `${label} must be a POSIX relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail('release_manifest_path', `${label} contains an unsafe segment`);
  }
  return value;
}

async function verifyReleaseArtifact(root) {
  const files = await collectTree(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  const releaseManifestBytes = await regularBytes(path.join(root, 'release-manifest.json'), 'release_manifest', MAX_REPORT_BYTES);
  const manifest = parseJson(releaseManifestBytes, 'release_manifest');
  exactKeys(
    manifest,
    ['schema_version', 'package_name', 'version', 'source_commit', 'public_pet_ids', 'files'],
    'release manifest'
  );
  if (manifest.schema_version !== RELEASE_SCHEMA_VERSION || typeof manifest.package_name !== 'string'
      || !manifest.package_name || !SEMVER_PATTERN.test(manifest.version) || !COMMIT_PATTERN.test(manifest.source_commit)
      || !Array.isArray(manifest.public_pet_ids) || !manifest.public_pet_ids.length || !Array.isArray(manifest.files)) {
    fail('release_manifest_identity', 'release manifest identity is invalid');
  }
  const publicPetIds = new Set();
  for (const id of manifest.public_pet_ids) {
    if (typeof id !== 'string' || !PET_ID_PATTERN.test(id) || publicPetIds.has(id)) {
      fail('release_manifest_pets', 'release manifest contains an invalid or duplicate public pet id');
    }
    publicPetIds.add(id);
  }

  const expected = new Set(['release-manifest.json']);
  let previous = '';
  for (const [index, entry] of manifest.files.entries()) {
    exactKeys(entry, ['path', 'bytes', 'mode', 'sha256'], `release manifest files[${index}]`);
    const relative = safeManifestPath(entry.path, `release manifest files[${index}].path`);
    if (relative <= previous || expected.has(relative) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || entry.mode !== '0644' || !SHA256_PATTERN.test(entry.sha256)) {
      fail('release_manifest_files', 'release manifest files must be sorted, unique, and hash-pinned');
    }
    previous = relative;
    expected.add(relative);
    const actual = byPath.get(relative);
    if (!actual || actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      fail('release_artifact_mismatch', `release artifact does not match ${relative}`);
    }
  }
  if (files.length !== expected.size || files.some((entry) => !expected.has(entry.path))) {
    fail('release_artifact_paths', 'release artifact path set does not match its manifest');
  }

  const pluginBytes = await regularBytes(path.join(root, '.codex-plugin', 'plugin.json'), 'plugin_manifest', MAX_REPORT_BYTES);
  const plugin = parseJson(pluginBytes, 'plugin_manifest');
  if (plugin.name !== manifest.package_name || plugin.version !== manifest.version) {
    fail('release_plugin_identity', 'release manifest and plugin identity do not match');
  }
  const hooksBytes = await regularBytes(path.join(root, 'hooks', 'hooks.json'), 'hooks_definition', MAX_REPORT_BYTES);
  parseJson(hooksBytes, 'hooks_definition');
  const catalogBytes = await regularBytes(path.join(root, 'assets', 'pets', 'catalog.json'), 'pet_catalog', MAX_REPORT_BYTES);
  const catalog = parseJson(catalogBytes, 'pet_catalog');
  if (catalog.schema_version !== '1' || !Array.isArray(catalog.pets)) fail('pet_catalog_schema', 'pet catalog is invalid');
  const petById = new Map();
  for (const entry of catalog.pets) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || petById.has(entry.id)
        || !publicPetIds.has(entry.id) || entry.scope !== 'public' || entry.available !== true
        || !SHA256_PATTERN.test(entry.manifestSha256) || !SHA256_PATTERN.test(entry.spritesheetSha256)) {
      fail('pet_catalog_public_boundary', 'pet catalog does not match the public release boundary');
    }
    const publicManifest = byPath.get(`assets/pets/${entry.id}/pet.json`);
    const publicSpritesheet = byPath.get(`assets/pets/${entry.id}/spritesheet.webp`);
    if (publicManifest?.sha256 !== entry.manifestSha256
        || publicSpritesheet?.sha256 !== entry.spritesheetSha256) {
      fail('pet_catalog_artifact_binding', 'pet catalog hashes do not bind the public pet artifact bytes');
    }
    petById.set(entry.id, entry);
  }
  if (petById.size !== publicPetIds.size) fail('pet_catalog_public_boundary', 'pet catalog omits a public release pet');

  const releaseManifestSha256 = sha256(releaseManifestBytes);
  return Object.freeze({
    root,
    files: Object.freeze(files),
    fileMap: byPath,
    manifest,
    petById,
    release: Object.freeze({
      package_name: manifest.package_name,
      plugin_version: manifest.version,
      source_commit: manifest.source_commit,
      release_manifest_sha256: releaseManifestSha256,
      artifact_sha256: treeSha256(files),
      plugin_manifest_sha256: sha256(pluginBytes),
      hooks_sha256: sha256(hooksBytes)
    })
  });
}

async function inspectInstalledSnapshot(root, artifact) {
  const files = await collectTree(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  const plugin = byPath.get('.codex-plugin/plugin.json') ?? null;
  const hooks = byPath.get('hooks/hooks.json') ?? null;
  const identity = Object.freeze({
    snapshot_sha256: treeSha256(files),
    file_count: files.length,
    plugin_manifest_sha256: plugin?.sha256 ?? null,
    hooks_sha256: hooks?.sha256 ?? null
  });
  const expectedByPath = new Map(artifact.files.map((entry) => [entry.path, entry]));
  if (files.length !== artifact.files.length || files.some((entry) => {
    const expected = expectedByPath.get(entry.path);
    return !expected || expected.bytes !== entry.bytes || expected.sha256 !== entry.sha256;
  })) {
    fail('installed_snapshot_mismatch', 'installed snapshot path set or bytes differ from the release artifact');
  }
  return { identity, evidence: { file_count: files.length, snapshot_sha256: identity.snapshot_sha256 } };
}

async function inspectInstalledPet(codexHome, pet) {
  const petRoot = path.join(codexHome, 'pets', pet.id);
  const details = await detailsOrNull(petRoot);
  if (!details || details.isSymbolicLink() || !details.isDirectory()) fail('installed_pet_missing', 'installed pet directory is missing or unsafe');
  const entries = await readdir(petRoot, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== 2 || names[0] !== 'pet.json' || names[1] !== 'spritesheet.webp'
      || entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) {
    fail('installed_pet_shape', 'installed pet package has unexpected files');
  }
  const manifestSha256 = sha256(await regularBytes(path.join(petRoot, 'pet.json'), 'installed_pet_manifest'));
  const spritesheetSha256 = sha256(await regularBytes(path.join(petRoot, 'spritesheet.webp'), 'installed_pet_spritesheet'));
  if (manifestSha256 !== pet.manifestSha256 || spritesheetSha256 !== pet.spritesheetSha256) {
    fail('installed_pet_mismatch', 'installed pet bytes differ from the release catalog');
  }
  return { pet_id: pet.id, manifest_sha256: manifestSha256, spritesheet_sha256: spritesheetSha256 };
}

function machineCheckSuccess(evidence) {
  return Object.freeze({ status: 'pass', evidence: Object.freeze(evidence), failure_code: null });
}

function machineCheckFailure(error, fallback) {
  const code = typeof error?.evidenceCode === 'string' && /^[a-z0-9_]{1,64}$/.test(error.evidenceCode)
    ? error.evidenceCode
    : fallback;
  return Object.freeze({ status: 'fail', evidence: null, failure_code: code });
}

async function machineCheck(callback, fallback) {
  try {
    return machineCheckSuccess(await callback());
  } catch (error) {
    return machineCheckFailure(error, fallback);
  }
}

async function readHashedJsonEvidence(file, label) {
  const bytes = await regularBytes(file, label, MAX_REPORT_BYTES);
  return { value: parseJson(bytes, label), sha256: sha256(bytes) };
}

function validateReceipt(receipt, receiptSha256, reviewKey, completedStatus, startedAt, collectedAt) {
  if (!receipt || receipt.schema_version !== '1' || receipt.review_key !== reviewKey
      || !SUCCESSFUL_REVIEW_STATUSES.has(receipt.terminal_status)
      || typeof receipt.model !== 'string' || !receipt.model || !GIT_OBJECT_PATTERN.test(receipt.baseline_tree)
      || !GIT_OBJECT_PATTERN.test(receipt.final_tree) || receipt.baseline_tree === receipt.final_tree
      || !SHA256_PATTERN.test(receipt.patch_hash) || !Number.isSafeInteger(receipt.changed_path_count)
      || receipt.changed_path_count < 1 || receipt.result?.status !== receipt.terminal_status
      || receipt.terminal_status !== completedStatus || receipt.result?.schema_version !== '2'
      || typeof receipt.result?.summary !== 'string' || !receipt.result.summary
      || receipt.result.summary.length > 1200 || !Array.isArray(receipt.result?.findings)
      || receipt.result.findings.length > 5 || !Array.isArray(receipt.result?.comments)
      || receipt.result.comments.length > 3
      || (receipt.terminal_status === 'findings') !== (receipt.result.findings.length > 0)
      || (receipt.terminal_status === 'abstain' && receipt.result.comments.length > 0)) {
    fail('turn_receipt_contract', 'turn receipt does not describe a completed provider-backed changed turn');
  }
  const reviewers = validateReviewerRuns(receipt);
  timestampWithin(receipt.created_at, startedAt, collectedAt, 'turn receipt created_at');
  return {
    review_key: reviewKey,
    terminal_status: receipt.terminal_status,
    provider: receipt.provider,
    model: receipt.model,
    baseline_tree: receipt.baseline_tree,
    final_tree: receipt.final_tree,
    patch_hash: receipt.patch_hash,
    changed_path_count: receipt.changed_path_count,
    created_at: receipt.created_at,
    receipt_sha256: receiptSha256,
    reviewers
  };
}

function boundedReviewerComposite(values, maximum) {
  const unique = [...new Set(values)];
  const joined = unique.join('+');
  if (joined.length <= maximum) return joined;
  const digest = sha256(Buffer.from(joined)).slice(0, 12);
  return `${unique.length}#${digest}`;
}

function validateReviewerResult(result, label) {
  if (!result || result.schema_version !== '2' || !SUCCESSFUL_REVIEW_STATUSES.has(result.status)
      || typeof result.summary !== 'string' || !result.summary || result.summary.length > 1200
      || !Array.isArray(result.findings) || result.findings.length > 5
      || !Array.isArray(result.comments) || result.comments.length > 3
      || (result.status === 'findings') !== (result.findings.length > 0)
      || (result.status === 'abstain' && result.comments.length > 0)) {
    fail('turn_receipt_contract', `${label} is not a valid reviewer result`);
  }
}

function validateReviewerFailure(failure, label) {
  exactKeys(failure, ['stage', 'failure_code', 'message'], label);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(failure.stage)
      || !/^[a-z][a-z0-9_]{0,63}$/.test(failure.failure_code)
      || typeof failure.message !== 'string' || !failure.message || failure.message.length > 240
      || hasUnsafeTerminalControls(failure.message) || /[\r\n\t]/.test(failure.message)) {
    fail('turn_receipt_contract', `${label} is not a bounded safe failure`);
  }
}

function validateReviewerRuns(receipt) {
  const runs = receipt.reviewer_runs;
  if (!Array.isArray(runs) || runs.length < 1 || runs.length > 2) {
    fail('turn_receipt_contract', 'turn receipt must retain one or two attributed reviewer runs');
  }
  let successes = 0;
  const evidence = runs.map((run, index) => {
    exactKeys(run, [
      'source_index', 'provider', 'model', 'status', 'result', 'failure',
      'summary_claim_advisory', 'provider_run', 'egress_capability'
    ], `turn receipt reviewer run ${index}`);
    if (run.source_index !== index || !REVIEW_PROVIDERS.has(run.provider)
        || typeof run.model !== 'string' || !run.model || run.model.length > 200
        || !REVIEWER_RUN_STATUSES.has(run.status)) {
      fail('turn_receipt_contract', `turn receipt reviewer run ${index} has invalid attribution`);
    }
    if (run.status === 'succeeded') {
      validateReviewerResult(run.result, `turn receipt reviewer run ${index} result`);
      if (run.failure !== null) fail('turn_receipt_contract', 'successful reviewer run cannot retain a failure');
      successes += 1;
    } else {
      if (run.result !== null) fail('turn_receipt_contract', 'failed reviewer run cannot retain a result');
      validateReviewerFailure(run.failure, `turn receipt reviewer run ${index} failure`);
      if ((run.status === 'circuit_open') !== (run.failure.failure_code === 'circuit_open')) {
        fail('turn_receipt_contract', 'reviewer run status does not match its safe failure code');
      }
    }
    return {
      source_index: index,
      provider: run.provider,
      model: run.model,
      status: run.status
    };
  });
  if (successes < 1
      || receipt.provider !== boundedReviewerComposite(runs.map((run) => run.provider), 120)
      || receipt.model !== boundedReviewerComposite(runs.map((run) => run.model), 200)) {
    fail('turn_receipt_contract', 'turn receipt aggregate identity is not bound to its reviewer runs');
  }
  return evidence;
}

function eventSafeText(value, maximum) {
  if (value === null || value === undefined) return null;
  const safe = escapeTerminalControls(String(value)).replaceAll('\r', '');
  return safe.length <= maximum ? safe : `${safe.slice(0, maximum - 1)}…`;
}

function publicReviewItem(item, kind) {
  const classification = kind === 'finding'
    ? { severity: item.severity }
    : { category: item.category };
  return {
    ...classification,
    confidence: item.confidence,
    title: eventSafeText(item.title, 160),
    body: eventSafeText(item.body, 1200),
    path: eventSafeText(item.path, 500),
    line_side: item.line_side ?? 'new',
    line_start: item.line_start,
    line_end: item.line_end,
    recommendation: eventSafeText(item.recommendation, 1200)
  };
}

function expectedPublicReview(receipt) {
  return {
    status: receipt.result.status,
    summary: eventSafeText(receipt.result.summary, 1600),
    findings: receipt.result.findings.slice(0, 5).map((item) => publicReviewItem(item, 'finding')),
    comments: receipt.result.comments.slice(0, 3).map((item) => publicReviewItem(item, 'comment')),
    provider: eventSafeText(receipt.provider, 120),
    model: eventSafeText(receipt.model, 200)
  };
}

function expectedPublicReviewerOutcomes(receipt) {
  return receipt.reviewer_runs.map((run) => ({
    source_index: run.source_index,
    provider: eventSafeText(run.provider, 120),
    model: eventSafeText(run.model, 200),
    status: run.status,
    result: run.status === 'succeeded' ? {
      status: run.result.status,
      summary: eventSafeText(run.result.summary, 800),
      findings: run.result.findings.slice(0, 3).map((item) => publicReviewItem(item, 'finding')),
      comments: run.result.comments.slice(0, 2).map((item) => publicReviewItem(item, 'comment'))
    } : null,
    failure: run.status === 'succeeded' ? null : {
      stage: run.failure.stage,
      failure_code: run.failure.failure_code,
      message: eventSafeText(run.failure.message, 240)
    }
  }));
}

function eventIdentity(event) {
  return {
    schema_version: '1',
    event_type: event.event_type,
    workspace_key: event.workspace_key,
    session_key: event.session_key,
    turn_key: event.turn_key,
    review_key: event.review_key,
    presentation_state: event.presentation_state,
    payload: event.payload
  };
}

function validateReviewCompletedEvent(event, outboxSha256, expected, startedAt, collectedAt) {
  exactKeys(
    event?.payload,
    ['headline', 'detail', 'worker_summary', 'review', 'summary_advisory', 'companion', 'reviews'],
    'review_completed outbox payload'
  );
  if (!event || event.schema_version !== '2' || event.event_type !== 'review_completed'
      || event.workspace_key !== expected.workspaceKey || event.session_key !== expected.sessionKey
      || event.turn_key !== expected.turnKey || event.review_key !== expected.reviewKey
      || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !SHA256_PATTERN.test(event.event_id)
      || event.event_id !== sha256(Buffer.from(canonicalJson(eventIdentity(event))))
      || event.presentation_state !== ({ findings: 'findings', no_findings: 'success', abstain: 'abstain' })[
        expected.receipt.terminal_status
      ]
      || canonicalJson(event.payload.review) !== canonicalJson(expectedPublicReview(expected.receipt))
      || canonicalJson(event.payload.reviews) !== canonicalJson(expectedPublicReviewerOutcomes(expected.receipt))) {
    fail('review_completed_outbox_contract', 'review_completed outbox event is invalid or mismatched');
  }
  timestampWithin(event.occurred_at, startedAt, collectedAt, 'review_completed occurred_at');
  return {
    event_id: event.event_id,
    review_key: event.review_key,
    occurred_at: event.occurred_at,
    outbox_sha256: outboxSha256
  };
}

function manualGateTemplate(kind) {
  return {
    status: 'pending',
    observer: null,
    observed_at: null,
    notes: kind === 'host' ? 'Pending human host observation.' : 'Pending human visual observation.'
  };
}

function machineEvidenceMaterial(report) {
  return {
    schema_version: report.schema_version,
    release: report.release,
    installed_snapshot: report.installed_snapshot,
    host: report.host,
    workspace: report.workspace,
    pet: report.pet,
    turn: report.turn,
    run: report.run,
    machine_checks: report.machine_checks
  };
}

function machineEvidenceSha256(report) {
  return sha256(Buffer.from(canonicalJson(machineEvidenceMaterial(report))));
}

export async function collectHostEvidenceV2(options) {
  const artifactRoot = await canonicalDirectory(options.artifactRoot, 'artifact', { rejectRootSymlink: true });
  const installedSnapshotRoot = await canonicalDirectory(
    options.installedSnapshotRoot,
    'installed_snapshot',
    { rejectRootSymlink: true }
  );
  const workspaceRoot = await canonicalDirectory(options.workspaceRoot, 'workspace');
  const runtimeDataDir = await canonicalDirectory(options.runtimeDataDir, 'runtime_data');
  const codexHome = await canonicalDirectory(options.codexHome, 'codex_home');
  const petId = boundedText(options.petId, 64, 'pet id');
  if (!PET_ID_PATTERN.test(petId)) throw new Error('pet id is invalid');
  const sessionId = boundedText(options.sessionId, 512, 'session id');
  const turnId = boundedText(options.turnId, 512, 'turn id');
  const taskReference = boundedText(options.taskReference, 256, 'task reference');
  const startedAt = strictTimestamp(options.startedAt, 'started_at');
  const collectedAt = (options.now ? options.now() : new Date()).toISOString();
  strictTimestamp(collectedAt, 'collected_at');
  if (Date.parse(collectedAt) < Date.parse(startedAt)) throw new Error('collected_at precedes started_at');

  // A malformed release cannot be an evidence anchor, so release verification is
  // intentionally a hard precondition rather than a reportable machine failure.
  const artifact = await verifyReleaseArtifact(artifactRoot);
  const pet = artifact.petById.get(petId);
  if (!pet) fail('pet_not_in_release', 'selected pet is not in the public release manifest');

  let installedIdentity = {
    snapshot_sha256: null,
    file_count: null,
    plugin_manifest_sha256: null,
    hooks_sha256: null
  };
  const machineChecks = {};
  machineChecks.release_artifact = machineCheckSuccess({
    artifact_sha256: artifact.release.artifact_sha256,
    file_count: artifact.files.length,
    release_manifest_sha256: artifact.release.release_manifest_sha256
  });
  machineChecks.installed_snapshot = await machineCheck(async () => {
    const inspected = await inspectInstalledSnapshot(installedSnapshotRoot, artifact);
    installedIdentity = inspected.identity;
    return inspected.evidence;
  }, 'installed_snapshot_unavailable');
  if (machineChecks.installed_snapshot.status === 'fail') {
    const files = await collectTree(installedSnapshotRoot).catch(() => null);
    if (files) {
      files.sort((left, right) => left.path.localeCompare(right.path));
      const byPath = new Map(files.map((entry) => [entry.path, entry]));
      installedIdentity = {
        snapshot_sha256: treeSha256(files),
        file_count: files.length,
        plugin_manifest_sha256: byPath.get('.codex-plugin/plugin.json')?.sha256 ?? null,
        hooks_sha256: byPath.get('hooks/hooks.json')?.sha256 ?? null
      };
    }
  }

  const expectedWorkspaceKey = workspaceKey(workspaceRoot);
  const sessionKey = opaqueKey(sessionId);
  const turnKey = opaqueKey(turnId);
  machineChecks.workspace_identity = machineCheckSuccess({ workspace_key: expectedWorkspaceKey });
  machineChecks.installed_pet = await machineCheck(
    () => inspectInstalledPet(codexHome, { id: petId, ...pet }),
    'installed_pet_unavailable'
  );

  const completedFile = path.join(
    runtimeDataDir,
    'turns',
    expectedWorkspaceKey,
    sessionKey,
    turnKey,
    'completed.json'
  );
  let completed = null;
  machineChecks.continuation_observed = await machineCheck(async () => {
    const completedRecord = await readHashedJsonEvidence(completedFile, 'completed_delivery');
    completed = completedRecord.value;
    if (completed.schema_version !== '1' || !SHA256_PATTERN.test(completed.review_key)
        || !SUCCESSFUL_REVIEW_STATUSES.has(completed.terminal_status)
        || completed.presentation_status !== 'observed') {
      fail('continuation_not_observed', 'completed delivery is not durably observed');
    }
    timestampWithin(completed.completed_at, startedAt, collectedAt, 'completed delivery completed_at');
    timestampWithin(
      completed.presentation_observed_at,
      startedAt,
      collectedAt,
      'completed delivery presentation_observed_at'
    );
    return {
      review_key: completed.review_key,
      terminal_status: completed.terminal_status,
      presentation_status: completed.presentation_status,
      presentation_observed_at: completed.presentation_observed_at,
      completed_sha256: completedRecord.sha256
    };
  }, 'completed_delivery_unavailable');

  const reviewKey = machineChecks.continuation_observed.status === 'pass' ? completed.review_key : null;
  let receipt = null;
  let receiptEvidence = null;
  machineChecks.turn_receipt = await machineCheck(async () => {
    if (!reviewKey) fail('completed_delivery_dependency', 'turn receipt requires a valid completed delivery');
    const receiptRecord = await readHashedJsonEvidence(
      path.join(runtimeDataDir, 'automatic-reviews', expectedWorkspaceKey, `${reviewKey}.json`),
      'turn_receipt'
    );
    receipt = receiptRecord.value;
    receiptEvidence = validateReceipt(
      receipt,
      receiptRecord.sha256,
      reviewKey,
      completed.terminal_status,
      startedAt,
      collectedAt
    );
    return receiptEvidence;
  }, 'turn_receipt_unavailable');

  machineChecks.review_completed_outbox = await machineCheck(async () => {
    if (!reviewKey || !receiptEvidence) fail('turn_receipt_dependency', 'outbox evidence requires a valid turn receipt');
    const sessionDirectory = path.join(runtimeDataDir, 'outbox', expectedWorkspaceKey, sessionKey);
    const entries = await readdir(sessionDirectory, { withFileTypes: true });
    const matches = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile() || !/^([0-9a-f]{64})\.json$/.test(entry.name)) {
        fail('review_completed_outbox_shape', 'outbox session directory contains an unsupported entry');
      }
      const eventRecord = await readHashedJsonEvidence(
        path.join(sessionDirectory, entry.name),
        'review_completed_outbox'
      );
      const event = eventRecord.value;
      if (event.event_type === 'review_completed' && event.review_key === reviewKey && event.turn_key === turnKey) {
        if (entry.name !== `${event.event_id}.json`) fail('review_completed_outbox_filename', 'outbox filename does not match event id');
        matches.push(eventRecord);
      }
    }
    if (matches.length !== 1) fail('review_completed_outbox_cardinality', 'expected exactly one review_completed event for the turn');
    return validateReviewCompletedEvent(matches[0].value, matches[0].sha256, {
      workspaceKey: expectedWorkspaceKey,
      sessionKey,
      turnKey,
      reviewKey,
      receipt
    }, startedAt, collectedAt);
  }, 'review_completed_outbox_unavailable');

  const report = {
    schema_version: REPORT_SCHEMA_VERSION,
    release: artifact.release,
    installed_snapshot: installedIdentity,
    host: {
      platform: process.platform,
      architecture: process.arch,
      node_version: process.version
    },
    workspace: { workspace_key: expectedWorkspaceKey, task_reference: taskReference },
    pet: {
      id: petId,
      manifest_sha256: pet.manifestSha256,
      spritesheet_sha256: pet.spritesheetSha256
    },
    turn: { session_key: sessionKey, turn_key: turnKey, review_key: reviewKey },
    run: { started_at: startedAt, collected_at: collectedAt },
    machine_checks: machineChecks,
    machine_evidence_sha256: null,
    manual_host_gates: Object.fromEntries(MANUAL_HOST_GATES.map((id) => [id, manualGateTemplate('host')])),
    manual_visual_gates: Object.fromEntries(MANUAL_VISUAL_GATES.map((id) => [id, manualGateTemplate('visual')]))
  };
  report.machine_evidence_sha256 = machineEvidenceSha256(report);
  return report;
}

function validateMachineCheck(check, id, report) {
  exactKeys(check, ['status', 'evidence', 'failure_code'], `machine check ${id}`);
  if (!['pass', 'fail'].includes(check.status)) throw new Error(`machine check ${id} must use pass or fail`);
  if (check.status === 'fail') {
    if (check.evidence !== null || typeof check.failure_code !== 'string'
        || !/^[a-z0-9_]{1,64}$/.test(check.failure_code)) {
      throw new Error(`failed machine check ${id} must contain only a stable failure code`);
    }
    return;
  }
  if (check.failure_code !== null) throw new Error(`passing machine check ${id} must not claim a failure`);
  exactKeys(check.evidence, MACHINE_EVIDENCE_KEYS[id], `machine check ${id} evidence`);
  const evidence = check.evidence;
  if (id === 'release_artifact') {
    if (evidence.artifact_sha256 !== report.release.artifact_sha256
        || evidence.release_manifest_sha256 !== report.release.release_manifest_sha256
        || !Number.isSafeInteger(evidence.file_count) || evidence.file_count < 1) {
      throw new Error('release artifact machine evidence is not bound to the report');
    }
  } else if (id === 'installed_snapshot') {
    if (evidence.snapshot_sha256 !== report.installed_snapshot.snapshot_sha256
        || evidence.snapshot_sha256 !== report.release.artifact_sha256
        || evidence.file_count !== report.installed_snapshot.file_count) {
      throw new Error('installed snapshot machine evidence is not byte-identical to the release artifact');
    }
  } else if (id === 'workspace_identity') {
    if (evidence.workspace_key !== report.workspace.workspace_key) throw new Error('workspace machine evidence is mismatched');
  } else if (id === 'installed_pet') {
    if (evidence.pet_id !== report.pet.id || evidence.manifest_sha256 !== report.pet.manifest_sha256
        || evidence.spritesheet_sha256 !== report.pet.spritesheet_sha256) {
      throw new Error('installed pet machine evidence is mismatched');
    }
  } else if (id === 'turn_receipt') {
    if (evidence.review_key !== report.turn.review_key || !SUCCESSFUL_REVIEW_STATUSES.has(evidence.terminal_status)
        || typeof evidence.provider !== 'string' || !evidence.provider
        || typeof evidence.model !== 'string' || !evidence.model
        || !GIT_OBJECT_PATTERN.test(evidence.baseline_tree) || !GIT_OBJECT_PATTERN.test(evidence.final_tree)
        || evidence.baseline_tree === evidence.final_tree || !SHA256_PATTERN.test(evidence.patch_hash)
        || !SHA256_PATTERN.test(evidence.receipt_sha256)
        || !Number.isSafeInteger(evidence.changed_path_count) || evidence.changed_path_count < 1) {
      throw new Error('turn receipt machine evidence is invalid or mismatched');
    }
    if (!Array.isArray(evidence.reviewers) || evidence.reviewers.length < 1 || evidence.reviewers.length > 2) {
      throw new Error('turn receipt machine evidence has invalid reviewer attribution');
    }
    let successfulReviewers = 0;
    for (const [index, reviewer] of evidence.reviewers.entries()) {
      exactKeys(reviewer, ['source_index', 'provider', 'model', 'status'], `turn receipt reviewer evidence ${index}`);
      if (reviewer.source_index !== index || !REVIEW_PROVIDERS.has(reviewer.provider)
          || typeof reviewer.model !== 'string' || !reviewer.model || reviewer.model.length > 200
          || !REVIEWER_RUN_STATUSES.has(reviewer.status)) {
        throw new Error('turn receipt machine evidence has invalid reviewer attribution');
      }
      if (reviewer.status === 'succeeded') successfulReviewers += 1;
    }
    if (successfulReviewers < 1
        || evidence.provider !== boundedReviewerComposite(evidence.reviewers.map((reviewer) => reviewer.provider), 120)
        || evidence.model !== boundedReviewerComposite(evidence.reviewers.map((reviewer) => reviewer.model), 200)) {
      throw new Error('turn receipt machine evidence is not bound to its reviewer set');
    }
    timestampWithin(evidence.created_at, report.run.started_at, report.run.collected_at, 'turn receipt evidence created_at');
  } else if (id === 'review_completed_outbox') {
    if (!SHA256_PATTERN.test(evidence.event_id) || !SHA256_PATTERN.test(evidence.outbox_sha256)
        || evidence.review_key !== report.turn.review_key) {
      throw new Error('outbox machine evidence is invalid or mismatched');
    }
    timestampWithin(evidence.occurred_at, report.run.started_at, report.run.collected_at, 'outbox evidence occurred_at');
  } else if (id === 'continuation_observed') {
    if (evidence.review_key !== report.turn.review_key || evidence.presentation_status !== 'observed'
        || !SUCCESSFUL_REVIEW_STATUSES.has(evidence.terminal_status)
        || !SHA256_PATTERN.test(evidence.completed_sha256)) {
      throw new Error('completed delivery machine evidence is invalid or mismatched');
    }
    timestampWithin(
      evidence.presentation_observed_at,
      report.run.started_at,
      report.run.collected_at,
      'completed delivery evidence observed_at'
    );
  }
}

function validateManualGate(gate, id, kind, report) {
  exactKeys(gate, ['status', 'observer', 'observed_at', 'notes'], `manual ${kind} gate ${id}`);
  if (!['manual_pass', 'manual_fail', 'pending'].includes(gate.status)) {
    throw new Error(`manual ${kind} gate ${id} must use manual_pass, manual_fail, or pending`);
  }
  boundedText(gate.notes, 1000, `manual ${kind} gate ${id}.notes`);
  if (gate.status === 'pending') {
    if (gate.observer !== null || gate.observed_at !== null) {
      throw new Error(`pending manual ${kind} gate ${id} must not contain an attestation`);
    }
    return;
  }
  boundedText(gate.observer, 200, `manual ${kind} gate ${id}.observer`);
  timestampWithin(
    gate.observed_at,
    report.run.started_at,
    report.run.collected_at,
    `manual ${kind} gate ${id}.observed_at`
  );
}

export function validateHostE2eReport(report) {
  exactKeys(report, [
    'schema_version', 'release', 'installed_snapshot', 'host', 'workspace', 'pet', 'turn', 'run',
    'machine_checks', 'machine_evidence_sha256', 'manual_host_gates', 'manual_visual_gates'
  ], 'host evidence report');
  if (report.schema_version !== REPORT_SCHEMA_VERSION) throw new Error('host evidence report must use strict schema version 2');

  exactKeys(report.release, [
    'package_name', 'plugin_version', 'source_commit', 'release_manifest_sha256', 'artifact_sha256',
    'plugin_manifest_sha256', 'hooks_sha256'
  ], 'host evidence release binding');
  boundedText(report.release.package_name, 128, 'release package_name');
  if (!SEMVER_PATTERN.test(report.release.plugin_version) || !COMMIT_PATTERN.test(report.release.source_commit)
      || !SHA256_PATTERN.test(report.release.release_manifest_sha256)
      || !SHA256_PATTERN.test(report.release.artifact_sha256)
      || !SHA256_PATTERN.test(report.release.plugin_manifest_sha256)
      || !SHA256_PATTERN.test(report.release.hooks_sha256)) {
    throw new Error('host evidence release binding is invalid');
  }

  exactKeys(report.installed_snapshot, [
    'snapshot_sha256', 'file_count', 'plugin_manifest_sha256', 'hooks_sha256'
  ], 'host evidence installed snapshot');
  for (const field of ['snapshot_sha256', 'plugin_manifest_sha256', 'hooks_sha256']) {
    if (report.installed_snapshot[field] !== null && !SHA256_PATTERN.test(report.installed_snapshot[field])) {
      throw new Error(`host evidence installed_snapshot.${field} is invalid`);
    }
  }
  if (report.installed_snapshot.file_count !== null
      && (!Number.isSafeInteger(report.installed_snapshot.file_count) || report.installed_snapshot.file_count < 1)) {
    throw new Error('host evidence installed_snapshot.file_count is invalid');
  }
  if (report.installed_snapshot.snapshot_sha256 === report.release.artifact_sha256
      && (report.installed_snapshot.plugin_manifest_sha256 !== report.release.plugin_manifest_sha256
        || report.installed_snapshot.hooks_sha256 !== report.release.hooks_sha256)) {
    throw new Error('host evidence installed snapshot hashes are not bound to the release');
  }

  exactKeys(report.host, ['platform', 'architecture', 'node_version'], 'host evidence host');
  boundedText(report.host.platform, 32, 'host platform');
  boundedText(report.host.architecture, 32, 'host architecture');
  boundedText(report.host.node_version, 64, 'host node version');

  exactKeys(report.workspace, ['workspace_key', 'task_reference'], 'host evidence workspace');
  if (!WORKSPACE_PATTERN.test(report.workspace.workspace_key)) throw new Error('host evidence workspace_key is invalid');
  boundedText(report.workspace.task_reference, 256, 'host evidence task_reference');

  exactKeys(report.pet, ['id', 'manifest_sha256', 'spritesheet_sha256'], 'host evidence pet');
  if (!PET_ID_PATTERN.test(report.pet.id) || !SHA256_PATTERN.test(report.pet.manifest_sha256)
      || !SHA256_PATTERN.test(report.pet.spritesheet_sha256)) throw new Error('host evidence pet binding is invalid');

  exactKeys(report.turn, ['session_key', 'turn_key', 'review_key'], 'host evidence turn');
  if (!OPAQUE_PATTERN.test(report.turn.session_key) || !OPAQUE_PATTERN.test(report.turn.turn_key)
      || (report.turn.review_key !== null && !SHA256_PATTERN.test(report.turn.review_key))) {
    throw new Error('host evidence turn binding is invalid');
  }

  exactKeys(report.run, ['started_at', 'collected_at'], 'host evidence run');
  strictTimestamp(report.run.started_at, 'host evidence started_at');
  strictTimestamp(report.run.collected_at, 'host evidence collected_at');
  if (Date.parse(report.run.collected_at) < Date.parse(report.run.started_at)) {
    throw new Error('host evidence collected_at precedes started_at');
  }

  exactKeys(report.machine_checks, MACHINE_HOST_GATES, 'host evidence machine checks');
  for (const id of MACHINE_HOST_GATES) validateMachineCheck(report.machine_checks[id], id, report);
  if (report.machine_checks.turn_receipt.status === 'pass'
      && report.machine_checks.continuation_observed.status === 'pass'
      && report.machine_checks.turn_receipt.evidence.terminal_status
        !== report.machine_checks.continuation_observed.evidence.terminal_status) {
    throw new Error('host evidence receipt and completed terminal statuses are mismatched');
  }
  if (!SHA256_PATTERN.test(report.machine_evidence_sha256)
      || report.machine_evidence_sha256 !== machineEvidenceSha256(report)) {
    throw new Error('host evidence machine digest does not match the report');
  }

  exactKeys(report.manual_host_gates, MANUAL_HOST_GATES, 'host evidence manual host gates');
  exactKeys(report.manual_visual_gates, MANUAL_VISUAL_GATES, 'host evidence manual visual gates');
  for (const id of MANUAL_HOST_GATES) validateManualGate(report.manual_host_gates[id], id, 'host', report);
  for (const id of MANUAL_VISUAL_GATES) validateManualGate(report.manual_visual_gates[id], id, 'visual', report);

  const machineFailed = MACHINE_HOST_GATES.filter((id) => report.machine_checks[id].status === 'fail');
  const hostFailed = MANUAL_HOST_GATES.filter((id) => report.manual_host_gates[id].status === 'manual_fail');
  const hostPending = MANUAL_HOST_GATES.filter((id) => report.manual_host_gates[id].status === 'pending');
  const visualFailed = MANUAL_VISUAL_GATES.filter((id) => report.manual_visual_gates[id].status === 'manual_fail');
  const visualPending = MANUAL_VISUAL_GATES.filter((id) => report.manual_visual_gates[id].status === 'pending');
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    complete: !machineFailed.length && !hostFailed.length && !hostPending.length && !visualFailed.length && !visualPending.length,
    machine_complete: !machineFailed.length,
    machine_passed: MACHINE_HOST_GATES.length - machineFailed.length,
    manual_host_attested_passed: MANUAL_HOST_GATES.length - hostFailed.length - hostPending.length,
    manual_visual_attested_passed: MANUAL_VISUAL_GATES.length - visualFailed.length - visualPending.length,
    machine_failed: machineFailed,
    manual_host_failed: hostFailed,
    manual_host_pending: hostPending,
    manual_visual_failed: visualFailed,
    manual_visual_pending: visualPending
  };
}

export async function validateHostEvidenceBundle(bundle, artifactRoot) {
  exactKeys(bundle, ['schema_version', 'reports'], 'host evidence bundle');
  if (bundle.schema_version !== BUNDLE_SCHEMA_VERSION) {
    throw new Error('host evidence bundle must use strict schema version 1');
  }
  if (!Array.isArray(bundle.reports) || !bundle.reports.length || bundle.reports.length > 64) {
    throw new Error('host evidence bundle reports must be a nonempty bounded array');
  }

  const canonicalArtifactRoot = await canonicalDirectory(artifactRoot, 'artifact', { rejectRootSymlink: true });
  const artifact = await verifyReleaseArtifact(canonicalArtifactRoot);
  const expectedPetIds = new Set(artifact.manifest.public_pet_ids);
  const reportsByPetId = new Map();

  for (const [index, report] of bundle.reports.entries()) {
    const petId = report?.pet?.id;
    if (typeof petId !== 'string' || !PET_ID_PATTERN.test(petId)) {
      throw new Error(`host evidence bundle reports[${index}] has an invalid pet id`);
    }
    if (!expectedPetIds.has(petId)) {
      throw new Error(`host evidence bundle contains unknown public pet id ${petId}`);
    }
    if (reportsByPetId.has(petId)) {
      throw new Error(`host evidence bundle contains duplicate report for ${petId}`);
    }
    reportsByPetId.set(petId, report);
  }

  const missingPetIds = [...expectedPetIds].filter((petId) => !reportsByPetId.has(petId));
  if (missingPetIds.length) {
    throw new Error(`host evidence bundle is missing reports for ${missingPetIds.join(', ')}`);
  }
  if (reportsByPetId.size !== expectedPetIds.size) {
    throw new Error('host evidence bundle pet set does not exactly match the release manifest');
  }

  for (const petId of artifact.manifest.public_pet_ids) {
    const report = reportsByPetId.get(petId);
    const result = validateHostE2eReport(report);
    if (!result.complete) {
      throw new Error(`host evidence report for ${petId} is not complete`);
    }
    if (canonicalJson(report.release) !== canonicalJson(artifact.release)) {
      throw new Error(`host evidence report for ${petId} is not bound to this exact public artifact`);
    }
    const expectedPet = artifact.petById.get(petId);
    if (report.pet.manifest_sha256 !== expectedPet.manifestSha256
        || report.pet.spritesheet_sha256 !== expectedPet.spritesheetSha256) {
      throw new Error(`host evidence report for ${petId} is not bound to the artifact pet bytes`);
    }
  }

  return {
    schema_version: BUNDLE_SCHEMA_VERSION,
    complete: true,
    report_count: reportsByPetId.size,
    public_pet_ids: [...artifact.manifest.public_pet_ids]
  };
}

export function parseHostE2eArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('-') ? args.shift() : 'validate';
  if (!['collect', 'validate', 'validate-bundle', 'decode-bundle-secret'].includes(action)) {
    throw new Error('host evidence action must be collect, validate, validate-bundle, or decode-bundle-secret');
  }
  const options = { action, json: false };
  const pathFlags = new Set([
    '--artifact', '--installed-snapshot', '--workspace', '--runtime-data-dir', '--codex-home', '--output', '--report',
    '--bundle'
  ]);
  const textFlags = new Set(['--pet-id', '--session-id', '--turn-id', '--task-reference', '--started-at']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (pathFlags.has(arg) || textFlags.has(arg)) {
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      index += 1;
      const key = {
        '--artifact': 'artifactRoot',
        '--installed-snapshot': 'installedSnapshotRoot',
        '--workspace': 'workspaceRoot',
        '--runtime-data-dir': 'runtimeDataDir',
        '--codex-home': 'codexHome',
        '--output': 'output',
        '--report': 'report',
        '--bundle': 'bundle',
        '--pet-id': 'petId',
        '--session-id': 'sessionId',
        '--turn-id': 'turnId',
        '--task-reference': 'taskReference',
        '--started-at': 'startedAt'
      }[arg];
      options[key] = pathFlags.has(arg) ? path.resolve(value) : value;
    } else throw new Error(`unknown host evidence argument: ${arg}`);
  }
  if (options.help) return options;
  if (action === 'validate') {
    if (!options.report) throw new Error('host evidence validate requires --report');
    const unsupported = Object.keys(options).find((key) => !['action', 'json', 'report'].includes(key));
    if (unsupported) throw new Error('host evidence collection flags are not allowed with validate');
  } else if (action === 'validate-bundle') {
    if (!options.bundle || !options.artifactRoot) {
      throw new Error('host evidence validate-bundle requires --bundle and --artifact');
    }
    const unsupported = Object.keys(options).find((key) => ![
      'action', 'json', 'bundle', 'artifactRoot'
    ].includes(key));
    if (unsupported) throw new Error('host evidence collection/report flags are not allowed with validate-bundle');
  } else if (action === 'decode-bundle-secret') {
    if (!options.output) throw new Error('host evidence decode-bundle-secret requires --output');
    const unsupported = Object.keys(options).find((key) => !['action', 'json', 'output'].includes(key));
    if (unsupported || options.json) {
      throw new Error('host evidence collection/report flags are not allowed with decode-bundle-secret');
    }
  } else {
    const required = [
      'artifactRoot', 'installedSnapshotRoot', 'workspaceRoot', 'runtimeDataDir', 'codexHome', 'petId',
      'sessionId', 'turnId', 'taskReference', 'startedAt', 'output'
    ];
    const missing = required.find((key) => options[key] === undefined);
    if (missing) throw new Error(`host evidence collect requires ${missing}`);
    if (options.report || options.bundle) {
      throw new Error('--report and --bundle are allowed only with their host evidence validation actions');
    }
  }
  return options;
}

async function writeExclusiveJson(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusiveBytes(file, bytes) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main() {
  try {
    const options = parseHostE2eArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    if (options.action === 'collect') {
      const report = await collectHostEvidenceV2(options);
      await writeExclusiveJson(options.output, report);
      const result = validateHostE2eReport(report);
      process.stdout.write(options.json
        ? `${JSON.stringify({ report: options.output, ...result }, null, 2)}\n`
        : `Buddy host machine evidence complete: ${result.machine_complete ? 'yes' : 'no'}; manual attestations remain pending.\n`);
      if (!result.machine_complete) process.exitCode = 2;
      return;
    }
    if (options.action === 'decode-bundle-secret') {
      const encoded = await readBoundedStdin(MAX_SECRET_BASE64_BYTES);
      const bytes = decodeHostEvidenceBundleSecret(encoded);
      await writeExclusiveBytes(options.output, bytes);
      process.stdout.write(`Buddy host evidence bundle secret decoded (${bytes.length} bytes).\n`);
      return;
    }
    if (options.action === 'validate-bundle') {
      const bytes = await regularBytes(options.bundle, 'host_evidence_bundle', MAX_BUNDLE_BYTES);
      const result = await validateHostEvidenceBundle(
        parseJson(bytes, 'host_evidence_bundle'),
        options.artifactRoot
      );
      process.stdout.write(options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Buddy host evidence bundle complete: yes (${result.report_count} public pets).\n`);
      return;
    }
    const bytes = await regularBytes(options.report, 'host_evidence_report', MAX_REPORT_BYTES);
    const result = validateHostE2eReport(parseJson(bytes, 'host_evidence_report'));
    process.stdout.write(options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Buddy host acceptance complete: ${result.complete ? 'yes' : 'no'}.\n`);
    if (!result.complete) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`Buddy host evidence failed: ${escapeDiagnosticLine(error?.message ?? error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
