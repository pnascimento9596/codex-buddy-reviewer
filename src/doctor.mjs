import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPetCatalog, resolveCodexHome } from './pet-catalog.mjs';
import { modeFile, resolveRepositoryRoot, reviewersForMode } from './mode.mjs';
import { validatePresentationProfile } from './presentation-state.mjs';
import { supportedProviderIds } from './provider-registry.mjs';
import { providerEgressPlatformPolicy } from './provider-egress-platform.mjs';
import { assessProviderModelIdentifier } from './secret-scan.mjs';
import {
  summaryClaimGuardConsentFile,
  validateSummaryClaimGuardConsent
} from './summary-claim-guard.mjs';
import { resolveDataDir, resolveRuntimeDataDir, workspaceKey } from './state.mjs';
import { resolveVerifiedWindowsJobHelper } from './windows-job-supervisor.mjs';

const DEFAULT_PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHECK_STATUSES = new Set(['pass', 'warn', 'fail', 'unknown']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TRANSACTION_ID_PATTERN = /^[0-9]+-[0-9a-f-]{36}$/;
const OPAQUE_KEY_PATTERN = /^[0-9a-f]{24}$/;
const EGRESS_PROVIDERS = new Set(supportedProviderIds());
const EGRESS_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const EGRESS_STATES = new Set(['issued', 'consumed']);
const EGRESS_RECORD_FIELDS = [
  'capability_id',
  'token_sha256',
  'workspace_key',
  'session_key',
  'turn_key',
  'review_key',
  'mode_revision',
  'provider',
  'model',
  'effort',
  'timeout_ms',
  'configuration_sha256',
  'approval_sha256',
  'content_policy_version',
  'channel_inventory_sha256',
  'prompt_sha256',
  'prompt_bytes',
  'response_schema_sha256',
  'summary_consent_revision',
  'summary_sha256',
  'summary_packet_sha256',
  'owner_pid',
  'owner_nonce',
  'issued_at',
  'spend_deadline_at',
  'deadline_at',
  'state',
  'consumed_at'
];
const MAX_EGRESS_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_ACTIVE_EGRESS_RECORDS = 1_024;
const MAX_EGRESS_PROMPT_BYTES = 2 * 1024 * 1024;
const EGRESS_SPEND_WINDOW_MS = 30_000;
const EGRESS_DEADLINE_GRACE_MS = 10_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function detailsOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readRegularJson(file, label) {
  const details = await detailsOrNull(file);
  if (!details) return null;
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readBoundedRegularJsonNoFollow(file, label, maximumBytes) {
  let before;
  try {
    before = await lstat(file, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (before.size > BigInt(maximumBytes)) {
    throw new Error(`${label} exceeds the bounded ${maximumBytes}-byte doctor read`);
  }

  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      throw new Error(`${label} changed while it was being opened`);
    }
    const byteLength = Number(opened.size);
    const buffer = Buffer.alloc(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const result = await handle.read(buffer, offset, byteLength - offset, offset);
      if (result.bytesRead === 0) throw new Error(`${label} changed while it was being read`);
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(opened, after)) {
      throw new Error(`${label} changed while it was being read`);
    }
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function canonicalExistingPath(requested) {
  const resolved = path.resolve(requested);
  let cursor = resolved;
  const missingSegments = [];
  while (true) {
    try {
      return path.join(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function homeRegistryKey(codexHome) {
  return sha256(Buffer.from(path.resolve(codexHome))).slice(0, 32);
}

function registryPaths(dataDir, codexHome) {
  const dataRoot = resolveDataDir(dataDir);
  const homeDataDir = path.join(dataRoot, 'pets', 'homes', homeRegistryKey(codexHome));
  return {
    homeDataDir,
    current: path.join(homeDataDir, 'installed.json'),
    legacy: path.join(dataRoot, 'pets', 'installed.json')
  };
}

function validateHashRecord(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`${label} must be an object`);
  if (!SHA256_PATTERN.test(record.manifest_sha256) || !SHA256_PATTERN.test(record.spritesheet_sha256)) {
    throw new Error(`${label} has invalid hashes`);
  }
  return record;
}

async function readRegistryView(dataDir, codexHome) {
  const files = registryPaths(dataDir, codexHome);
  const current = await readRegularJson(files.current, 'pet registry');
  const raw = current ?? await readRegularJson(files.legacy, 'legacy pet registry');
  if (raw === null) return { schema_version: '1', installed: {}, backups: [], file: files.current };
  if (!raw || typeof raw !== 'object' || raw.schema_version !== '1'
      || !raw.installed || typeof raw.installed !== 'object' || Array.isArray(raw.installed)
      || !Array.isArray(raw.backups)) {
    throw new Error('pet registry has an unsupported shape');
  }
  if (current) return { ...raw, file: files.current };
  const petsRoot = path.join(codexHome, 'pets');
  const installed = {};
  for (const [id, record] of Object.entries(raw.installed)) {
    if (record?.target === path.join(petsRoot, id)) installed[id] = record;
  }
  return {
    schema_version: '1',
    installed,
    backups: raw.backups.filter((record) => record?.original_target === path.join(petsRoot, record?.id)),
    file: files.current,
    legacy_file: files.legacy
  };
}

async function inspectPackage(directory) {
  const details = await detailsOrNull(directory);
  if (!details) return { exists: false, safe: true, manifest_sha256: null, spritesheet_sha256: null };
  if (details.isSymbolicLink() || !details.isDirectory()) {
    return { exists: true, safe: false, reason: 'target is not a regular package directory' };
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== 2 || names[0] !== 'pet.json' || names[1] !== 'spritesheet.webp'
      || entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) {
    return { exists: true, safe: false, reason: 'package contains unexpected, missing, or non-regular files' };
  }
  return {
    exists: true,
    safe: true,
    manifest_sha256: sha256(await readFile(path.join(directory, 'pet.json'))),
    spritesheet_sha256: sha256(await readFile(path.join(directory, 'spritesheet.webp')))
  };
}

export async function inspectPetStateReadOnly(options = {}) {
  const codexHome = await canonicalExistingPath(resolveCodexHome(options.codexHome));
  const catalog = await loadPetCatalog({ catalogFile: options.catalogFile });
  const registry = await readRegistryView(options.dataDir, codexHome);
  const petId = options.petId;
  const entries = petId ? catalog.pets.filter((entry) => entry.id === petId) : catalog.pets;
  if (petId && entries.length !== 1) throw new Error(`unknown Buddy pet id ${String(petId)}`);
  const pets = [];
  for (const entry of entries) {
    const target = path.join(codexHome, 'pets', entry.id);
    const current = await inspectPackage(target);
    const owned = registry.installed[entry.id] ?? null;
    if (owned) validateHashRecord(owned, `${entry.id} installed record`);
    let status = 'not_installed';
    if (current.exists && !current.safe) status = 'unsafe';
    else if (current.exists && !owned) status = 'unowned';
    else if (!current.exists && owned) status = 'missing';
    else if (current.exists && owned) {
      status = owned.target === target
        && current.manifest_sha256 === owned.manifest_sha256
        && current.spritesheet_sha256 === owned.spritesheet_sha256
        ? 'owned'
        : 'modified';
    }
    const desired = {
      manifest_sha256: entry.manifestSha256,
      spritesheet_sha256: entry.spritesheetSha256
    };
    const catalogCurrent = current.safe && current.exists
      && current.manifest_sha256 === desired.manifest_sha256
      && current.spritesheet_sha256 === desired.spritesheet_sha256;
    pets.push({
      id: entry.id,
      scope: entry.scope,
      target,
      status,
      catalog_current: catalogCurrent,
      current,
      owned,
      desired
    });
  }
  return {
    codex_home: codexHome,
    catalog_file: catalog.file,
    catalog_root: catalog.root,
    registry_file: registry.file,
    registry_schema_version: registry.schema_version,
    backups: registry.backups,
    pets
  };
}

export async function inspectPetTransactionsReadOnly(options = {}) {
  const codexHome = await canonicalExistingPath(resolveCodexHome(options.codexHome));
  const { homeDataDir } = registryPaths(options.dataDir, codexHome);
  const root = path.join(homeDataDir, 'transactions');
  const rootDetails = await detailsOrNull(root);
  if (!rootDetails) return { root, transactions: [] };
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    return { root, transactions: [{ id: null, status: 'needs_attention', reason: 'transaction root is unsafe' }] };
  }
  const transactions = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !TRANSACTION_ID_PATTERN.test(entry.name)) {
      transactions.push({ id: entry.name, status: 'needs_attention', reason: 'unexpected transaction entry' });
      continue;
    }
    const directory = path.join(root, entry.name);
    try {
      const intent = await readRegularJson(path.join(directory, '00-intent.json'), 'pet transaction intent');
      const complete = await readRegularJson(path.join(directory, '30-complete.json'), 'pet transaction completion');
      if (!intent?.payload?.intent || intent.transaction_id !== entry.name) {
        throw new Error('transaction has an invalid or missing intent');
      }
      const outcome = complete?.payload?.outcome ?? 'pending';
      if (!['pending', 'complete', 'rolled_back', 'needs_attention'].includes(outcome)) {
        throw new Error('transaction has an unsupported completion outcome');
      }
      transactions.push({
        id: entry.name,
        pet_id: intent.payload.intent.pet_id ?? null,
        operation: intent.payload.intent.operation ?? null,
        status: outcome,
        reason: complete?.payload?.reason ?? null
      });
    } catch (error) {
      transactions.push({ id: entry.name, status: 'needs_attention', reason: error.message });
    }
  }
  return { root, transactions };
}

export async function readPluginManifest(options = {}) {
  const pluginRoot = await canonicalExistingPath(options.pluginRoot ?? DEFAULT_PLUGIN_ROOT);
  const manifestFile = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = await readRegularJson(manifestFile, 'plugin manifest');
  if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('plugin manifest is missing required identity fields');
  }
  return { plugin_root: pluginRoot, manifest_file: manifestFile, manifest };
}

async function readModeStateReadOnly(root, dataDir) {
  const file = modeFile(root, dataDir);
  const stored = await readRegularJson(file, 'mode state');
  if (stored === null) {
    return {
      file,
      exists: false,
      state: { config_revision: 0, workspace_root: root, enabled: false },
      reviewers: []
    };
  }
  if (stored.schema_version !== '1' || stored.workspace_root !== root
      || !Number.isInteger(stored.config_revision) || typeof stored.enabled !== 'boolean') {
    throw new Error('mode state has an unsupported or mismatched shape');
  }
  return { file, exists: true, state: stored, reviewers: reviewersForMode(stored) };
}

function exactDataKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function validExactTimestamp(value) {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

async function inspectExistingDirectoryChain(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its configured data root`);
  }
  let current = resolvedRoot;
  for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`${label} directory chain must contain only non-symlink directories`);
    }
  }
  return true;
}

function validateEgressRecordReadOnly(record, expectedWorkspaceKey) {
  exactDataKeys(record, EGRESS_RECORD_FIELDS, 'egress capability record');
  const issuedAtMs = Date.parse(record.issued_at);
  const spendDeadlineAtMs = Date.parse(record.spend_deadline_at);
  const consumedAtMs = record.consumed_at === null ? null : Date.parse(record.consumed_at);
  const deadlineAtMs = record.deadline_at === null ? null : Date.parse(record.deadline_at);
  if (!SHA256_PATTERN.test(record.capability_id)
      || !SHA256_PATTERN.test(record.token_sha256)
      || record.workspace_key !== expectedWorkspaceKey
      || !OPAQUE_KEY_PATTERN.test(record.session_key)
      || !OPAQUE_KEY_PATTERN.test(record.turn_key)
      || !SHA256_PATTERN.test(record.review_key)
      || !Number.isSafeInteger(record.mode_revision) || record.mode_revision < 0
      || !EGRESS_PROVIDERS.has(record.provider)
      || !assessProviderModelIdentifier(record.model).allowed
      || !EGRESS_EFFORTS.has(record.effort)
      || !Number.isInteger(record.timeout_ms) || record.timeout_ms < 1_000 || record.timeout_ms > 480_000
      || !SHA256_PATTERN.test(record.configuration_sha256)
      || !SHA256_PATTERN.test(record.approval_sha256)
      || record.content_policy_version !== '1'
      || !SHA256_PATTERN.test(record.channel_inventory_sha256)
      || !SHA256_PATTERN.test(record.prompt_sha256)
      || !Number.isSafeInteger(record.prompt_bytes) || record.prompt_bytes < 1
      || record.prompt_bytes > MAX_EGRESS_PROMPT_BYTES
      || !SHA256_PATTERN.test(record.response_schema_sha256)
      || (record.summary_consent_revision !== null
        && (!Number.isSafeInteger(record.summary_consent_revision) || record.summary_consent_revision < 1))
      || (record.summary_sha256 !== null && !SHA256_PATTERN.test(record.summary_sha256))
      || (record.summary_packet_sha256 !== null && !SHA256_PATTERN.test(record.summary_packet_sha256))
      || !((record.summary_consent_revision === null) === (record.summary_sha256 === null)
        && (record.summary_sha256 === null) === (record.summary_packet_sha256 === null))
      || !Number.isSafeInteger(record.owner_pid) || record.owner_pid < 1
      || typeof record.owner_nonce !== 'string' || !/^[0-9a-f]{32}$/.test(record.owner_nonce)
      || !validExactTimestamp(record.issued_at) || !validExactTimestamp(record.spend_deadline_at)
      || spendDeadlineAtMs !== issuedAtMs + EGRESS_SPEND_WINDOW_MS
      || !EGRESS_STATES.has(record.state)
      || (record.state === 'issued'
        ? record.consumed_at !== null || record.deadline_at !== null
        : !validExactTimestamp(record.consumed_at) || !validExactTimestamp(record.deadline_at)
          || consumedAtMs < issuedAtMs || consumedAtMs > spendDeadlineAtMs
          || deadlineAtMs !== consumedAtMs + record.timeout_ms + EGRESS_DEADLINE_GRACE_MS)) {
    throw new Error('egress capability record is invalid');
  }
  return record;
}

async function inspectEgressRegistryReadOnly(root, dataDir) {
  const key = workspaceKey(root);
  const dataRoot = path.resolve(resolveDataDir(dataDir));
  const directory = path.join(dataRoot, 'egress', key);
  const file = path.join(directory, 'active.json');
  const directoryExists = await inspectExistingDirectoryChain(
    dataRoot,
    directory,
    'egress capability registry'
  );
  if (!directoryExists) return { file, missing: true, active: 0, issued: 0, consumed: 0 };
  const registry = await readBoundedRegularJsonNoFollow(
    file,
    'egress capability registry',
    MAX_EGRESS_REGISTRY_BYTES
  );
  if (registry === null) return { file, missing: true, active: 0, issued: 0, consumed: 0 };
  exactDataKeys(registry, ['schema_version', 'workspace_key', 'active'], 'egress capability registry');
  if (registry.workspace_key !== key || !Array.isArray(registry.active)
      || (registry.schema_version !== '2'
        && !(registry.schema_version === '1' && registry.active.length === 0))) {
    throw new Error('egress capability registry has an invalid schema or workspace');
  }
  if (registry.active.length > MAX_ACTIVE_EGRESS_RECORDS) {
    throw new Error(`egress capability registry exceeds ${MAX_ACTIVE_EGRESS_RECORDS} active records`);
  }
  const capabilityIds = new Set();
  let issued = 0;
  let consumed = 0;
  for (const raw of registry.active) {
    const record = validateEgressRecordReadOnly(raw, key);
    if (capabilityIds.has(record.capability_id)) {
      throw new Error('egress capability registry has a duplicate capability id');
    }
    capabilityIds.add(record.capability_id);
    if (record.state === 'issued') issued += 1;
    else consumed += 1;
  }
  return { file, missing: false, active: registry.active.length, issued, consumed };
}

async function processContainmentCheck(mode, options) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return check(
      'process_containment',
      'pass',
      'Provider subprocesses are configured for supervised POSIX process-group cleanup.',
      {
        detail: 'This is lifecycle containment, not an OS sandbox or a filesystem/network isolation boundary.'
      }
    );
  }

  const arch = options.arch ?? process.arch;
  const environment = options.env ?? process.env;
  const manifestFile = options.windowsHelperManifestFile
    ?? environment.CODEX_BUDDY_WINDOWS_HELPER_MANIFEST;
  const helperRoot = options.windowsHelperRoot
    ?? environment.CODEX_BUDDY_WINDOWS_HELPER_ROOT;
  try {
    const helper = await (options.resolveWindowsHelper ?? resolveVerifiedWindowsJobHelper)({
      platform,
      arch,
      ...(manifestFile ? { manifestFile } : {}),
      ...(helperRoot ? { helperRoot } : {})
    });
    if (!helper || helper.arch !== arch || !SHA256_PATTERN.test(helper.sha256)
        || typeof helper.path !== 'string' || helper.protocolVersion !== '1') {
      throw new Error('Windows Job Object helper resolver returned invalid verification metadata');
    }
    return check(
      'process_containment',
      'pass',
      'Windows Job Object helper metadata passed hash and architecture verification.',
      {
        helper_arch: helper.arch,
        detail: 'This read-only check did not execute the helper and is not runtime proof of Job Object assignment or descendant cleanup; Job Objects provide lifecycle containment, not an OS sandbox.'
      }
    );
  } catch (error) {
    const enabled = mode?.state?.enabled === true;
    return check(
      'process_containment',
      enabled ? 'fail' : 'warn',
      'Verified Windows Job Object containment is unavailable; provider execution will fail closed.',
      {
        detail: error instanceof Error ? error.message : String(error),
        mode_enabled: enabled
      }
    );
  }
}

function providerEgressPrivacyCheck(mode, options) {
  const policy = providerEgressPlatformPolicy(options.platform ?? process.platform);
  if (policy.allowed) {
    return check(
      'provider_egress_privacy',
      'pass',
      policy.summary,
      { mode_enabled: mode?.state?.enabled === true }
    );
  }
  const enabled = mode?.state?.enabled === true;
  return check(
    'provider_egress_privacy',
    enabled ? 'fail' : 'warn',
    policy.summary,
    {
      failure_code: policy.failureCode,
      detail: policy.detail,
      mode_enabled: enabled
    }
  );
}

function check(id, status, summary, extra = {}) {
  if (!CHECK_STATUSES.has(status)) throw new Error(`invalid doctor status for ${id}`);
  return { id, status, summary, ...extra };
}

function overallStatus(checks) {
  if (checks.some((item) => item.status === 'fail')) return 'fail';
  if (checks.some((item) => item.status === 'warn')) return 'warn';
  if (checks.some((item) => item.status === 'unknown')) return 'unknown';
  return 'pass';
}

async function scanBoundedJsonDirectory(directory, label, validate, maximum = 1_000) {
  const details = await detailsOrNull(directory);
  if (!details) return { count: 0, missing: true };
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`${label} must be a non-symlink directory`);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > maximum) throw new Error(`${label} exceeds the bounded ${maximum}-entry doctor scan`);
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('.lock')) continue;
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`${label} contains an unsupported entry: ${entry.name}`);
    }
    const value = await readRegularJson(path.join(directory, entry.name), `${label} entry`);
    validate(value, entry.name);
    count += 1;
  }
  return { count, missing: false };
}

function validateTerminalReceipt(value) {
  if (!value || value.schema_version !== '1' || typeof value.terminal_status !== 'string'
      || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) {
    throw new Error('automatic review receipt has an unsupported shape');
  }
  const models = [
    value.model,
    value.provider_run?.model,
    ...(Array.isArray(value.reviews) ? value.reviews.map((item) => item?.model) : []),
    ...(Array.isArray(value.review_failures) ? value.review_failures.map((item) => item?.model) : []),
    ...(Array.isArray(value.reviewer_runs) ? value.reviewer_runs.map((item) => item?.model) : [])
  ].filter((item) => item !== null && item !== undefined);
  if ((value.result && models.length === 0)
      || models.some((model) => !assessProviderModelIdentifier(model).allowed)) {
    throw new Error('automatic review receipt contains an invalid model identifier');
  }
}

function validateCircuitRecord(value) {
  if (!value || value.schema_version !== '1' || !Number.isSafeInteger(value.consecutive_failures)
      || value.consecutive_failures < 0
      || (value.open_until !== null && !Number.isFinite(Date.parse(value.open_until)))) {
    throw new Error('provider circuit record has an unsupported shape');
  }
}

export async function runDoctor(options = {}) {
  const checks = [];
  let root = null;
  try {
    root = await (options.resolveRoot ?? resolveRepositoryRoot)(options.root ?? options.cwd ?? process.cwd());
    root = await canonicalExistingPath(root);
    checks.push(check('workspace', 'pass', 'Git workspace resolved.', { workspace_root: root }));
  } catch (error) {
    checks.push(check('workspace', 'fail', 'Git workspace could not be resolved.', { detail: error.message }));
  }

  let plugin = null;
  try {
    plugin = await readPluginManifest(options);
    checks.push(check('plugin_manifest', 'pass', 'Plugin manifest is readable.', {
      plugin_name: plugin.manifest.name,
      plugin_version: plugin.manifest.version
    }));
  } catch (error) {
    checks.push(check('plugin_manifest', 'fail', 'Plugin source could not be validated.', { detail: error.message }));
  }
  if (plugin) {
    try {
      const hooks = await readRegularJson(path.join(plugin.plugin_root, 'hooks', 'hooks.json'), 'hooks definition');
      const validHooks = Array.isArray(hooks?.hooks?.UserPromptSubmit)
        && Array.isArray(hooks?.hooks?.Stop);
      checks.push(check('hook_definition', validHooks ? 'pass' : 'fail', validHooks
        ? 'UserPromptSubmit and Stop hook definitions are present.'
        : 'Required hook definitions are missing.'));
    } catch (error) {
      checks.push(check('hook_definition', 'fail', 'Hook definition could not be validated.', { detail: error.message }));
    }
    try {
      const skill = await detailsOrNull(path.join(plugin.plugin_root, 'skills', 'buddy-review', 'SKILL.md'));
      const validSkill = skill?.isFile() && !skill.isSymbolicLink();
      checks.push(check('command_skill_source', validSkill ? 'pass' : 'fail', validSkill
        ? 'Buddy Review command skill source is present.'
        : 'Buddy Review command skill source is missing or unsafe.'));
    } catch (error) {
      checks.push(check('command_skill_source', 'fail', 'Command skill source could not be validated.', { detail: error.message }));
    }
  } else {
    checks.push(check('hook_definition', 'unknown', 'Hook definition was not checked because plugin validation failed.'));
    checks.push(check('command_skill_source', 'unknown', 'Command skill source was not checked because plugin validation failed.'));
  }

  let mode = null;
  if (root) {
    try {
      mode = await readModeStateReadOnly(root, options.dataDir);
      checks.push(check('mode_state', mode.state.enabled ? 'pass' : 'warn', mode.state.enabled
        ? `Workspace review mode is enabled with ${mode.reviewers.length} configured reviewer connection(s).`
        : mode.exists
          ? `Workspace review mode is disabled with ${mode.reviewers.length} configured reviewer connection(s).`
          : 'Workspace review mode is disabled and has no stored reviewer configuration.', {
        configured_reviewer_count: mode.reviewers.length,
        configured_reviewers: mode.reviewers.map((reviewer, index) => ({
          role: index === 0 ? 'primary' : 'secondary',
          provider: reviewer.provider,
          model: reviewer.model,
          effort: reviewer.effort
        })),
        supported_providers: supportedProviderIds()
      }));
    } catch (error) {
      checks.push(check('mode_state', 'fail', 'Workspace mode state is invalid.', { detail: error.message }));
    }
    try {
      const egress = await inspectEgressRegistryReadOnly(root, options.dataDir);
      checks.push(check('egress_registry', egress.active > 0 ? 'warn' : 'pass', egress.active > 0
        ? `${egress.active} unresolved egress capability record(s) remain active.`
        : egress.missing
          ? 'No active egress capability registry exists for this workspace.'
          : 'The egress capability registry has no unresolved records.', {
        registry_file: egress.file,
        active_count: egress.active,
        issued_count: egress.issued,
        consumed_count: egress.consumed
      }));
    } catch (error) {
      checks.push(check('egress_registry', 'fail', 'Egress capability registry state is invalid or unsafe.', {
        detail: error.message
      }));
    }
    try {
      const dataRoot = resolveDataDir(options.dataDir);
      const file = path.join(dataRoot, 'presentation', workspaceKey(root), 'profile.json');
      const raw = await readRegularJson(file, 'presentation profile');
      if (raw === null) {
        checks.push(check('presentation_profile', 'pass', 'Default native:selected/precise presentation profile is active.'));
      } else {
        const profile = validatePresentationProfile(raw, root);
        checks.push(check('presentation_profile', 'pass', `Presentation profile is ${profile.pet_id}/${profile.personality}.`));
      }
    } catch (error) {
      checks.push(check('presentation_profile', 'fail', 'Presentation profile is invalid.', { detail: error.message }));
    }
    try {
      const raw = await readRegularJson(
        summaryClaimGuardConsentFile(root, options.dataDir),
        'summary-claim guard consent'
      );
      if (raw === null) {
        checks.push(check('summary_claim_guard', 'pass', mode?.reviewers?.length === 2
          ? 'Worker-summary advisory egress is disabled; both reviewers receive technical evidence only.'
          : 'Worker-summary advisory egress is disabled by default.', {
          primary_reviewer_only: true,
          secondary_summary_egress: false
        }));
      } else {
        const consent = validateSummaryClaimGuardConsent(raw);
        const primaryReviewer = mode?.reviewers?.[0] ?? null;
        const hasSecondaryReviewer = mode?.reviewers?.length === 2;
        const bindingMatches = !consent.enabled || (
          consent.provider === primaryReviewer?.provider && consent.model === primaryReviewer?.model
        );
        checks.push(check('summary_claim_guard', bindingMatches ? 'pass' : 'warn', consent.enabled
          ? bindingMatches
            ? hasSecondaryReviewer
              ? `Worker-summary advisory egress is explicitly bound to primary reviewer ${consent.provider}/${consent.model}; the secondary reviewer receives technical evidence only.`
              : `Worker-summary advisory egress is explicitly bound to primary reviewer ${consent.provider}/${consent.model}.`
            : 'Worker-summary advisory consent is stale for the current primary reviewer and will fail closed.'
          : hasSecondaryReviewer
            ? 'Worker-summary advisory egress is disabled; both reviewers receive technical evidence only.'
            : 'Worker-summary advisory egress is disabled.', {
          primary_reviewer_only: true,
          secondary_summary_egress: false,
          ...(primaryReviewer ? {
            primary_reviewer: {
              provider: primaryReviewer.provider,
              model: primaryReviewer.model
            }
          } : {})
        }));
      }
    } catch (error) {
      checks.push(check('summary_claim_guard', 'fail', 'Summary-claim guard consent is invalid.', { detail: error.message }));
    }
    try {
      const runtimeRoot = resolveRuntimeDataDir(options.runtimeDataDir);
      const workspace = workspaceKey(root);
      const receipts = await scanBoundedJsonDirectory(
        path.join(runtimeRoot, 'automatic-reviews', workspace),
        'automatic review receipts',
        validateTerminalReceipt
      );
      checks.push(check('receipt_state', 'pass', receipts.missing
        ? 'No automatic review receipts exist for this workspace yet.'
        : `${receipts.count} automatic review receipt(s) passed bounded structural checks.`));
      const circuits = await scanBoundedJsonDirectory(
        path.join(runtimeRoot, 'circuits', workspace),
        'provider circuits',
        validateCircuitRecord
      );
      checks.push(check('circuit_state', 'pass', circuits.missing
        ? 'No provider circuit state exists for this workspace yet.'
        : `${circuits.count} provider circuit record(s) passed bounded structural checks.`));
    } catch (error) {
      checks.push(check('receipt_state', 'fail', 'Private receipt or circuit state is invalid.', { detail: error.message }));
      checks.push(check('circuit_state', 'fail', 'Private receipt or circuit state is invalid.', { detail: error.message }));
    }
  } else {
    checks.push(check('mode_state', 'unknown', 'Workspace mode state could not be located.'));
    checks.push(check('egress_registry', 'unknown', 'Egress capability registry could not be located.'));
    checks.push(check('presentation_profile', 'unknown', 'Presentation profile could not be located.'));
    checks.push(check('summary_claim_guard', 'unknown', 'Summary-claim guard consent could not be located.'));
    checks.push(check('receipt_state', 'unknown', 'Automatic review receipts could not be located.'));
    checks.push(check('circuit_state', 'unknown', 'Provider circuits could not be located.'));
  }

  checks.push(providerEgressPrivacyCheck(mode, options));
  checks.push(await processContainmentCheck(mode, options));

  try {
    const petState = await inspectPetStateReadOnly(options);
    const unsafe = petState.pets.filter((pet) => ['unsafe', 'modified'].includes(pet.status));
    const installed = petState.pets.filter((pet) => pet.current.exists && pet.current.safe);
    checks.push(check('pet_packages', unsafe.length ? 'fail' : installed.length ? 'pass' : 'warn', unsafe.length
      ? `${unsafe.length} Buddy pet package(s) are modified or unsafe.`
      : installed.length
        ? `${installed.length} Buddy pet package(s) are present.`
        : 'No Buddy pet package is installed.'));
  } catch (error) {
    checks.push(check('pet_packages', 'fail', 'Pet catalog or package state could not be inspected.', { detail: error.message }));
  }

  try {
    const transactionState = await inspectPetTransactionsReadOnly(options);
    const needsAttention = transactionState.transactions.filter((item) => item.status === 'needs_attention');
    const pending = transactionState.transactions.filter((item) => item.status === 'pending');
    const status = needsAttention.length ? 'fail' : pending.length ? 'warn' : 'pass';
    checks.push(check('pet_transactions', status, needsAttention.length
      ? `${needsAttention.length} pet transaction(s) need attention.`
      : pending.length
        ? `${pending.length} pet transaction(s) are pending reconciliation.`
        : 'No unresolved pet transactions were found.', {
      pending_count: pending.length,
      needs_attention_count: needsAttention.length
    }));
  } catch (error) {
    checks.push(check('pet_transactions', 'fail', 'Pet transactions could not be inspected safely.', { detail: error.message }));
  }

  if (options.includeProviderCheck === true) {
    if (typeof options.providerCheck !== 'function') {
      checks.push(check('provider', 'unknown', 'Provider check was requested but no explicit check hook was supplied.'));
    } else {
      try {
        const result = await options.providerCheck({ root, mode: mode?.state ?? null });
        if (!result || !CHECK_STATUSES.has(result.status)) throw new Error('provider check returned an invalid status');
        checks.push(check('provider', result.status, result.summary ?? 'Explicit provider check completed.', {
          ...(result.detail ? { detail: result.detail } : {}),
          ...(Number.isSafeInteger(result.configured_count)
            ? { configured_count: result.configured_count }
            : {}),
          ...(Number.isSafeInteger(result.passed_count) ? { passed_count: result.passed_count } : {}),
          ...(Array.isArray(result.reviewer_checks) ? { reviewer_checks: result.reviewer_checks } : {})
        }));
      } catch {
        checks.push(check('provider', 'fail', 'Explicit provider check failed safely.', {
          detail: 'No provider error output was included in diagnostics.'
        }));
      }
    }
  } else {
    checks.push(check('provider', 'unknown', 'Provider was not contacted; run an explicit provider check to verify it.'));
  }

  if (typeof options.hostVersionCheck === 'function') {
    try {
      const version = await options.hostVersionCheck();
      checks.push(check('host_version', version ? 'pass' : 'unknown', version
        ? `Codex host CLI reports ${version}.`
        : 'Codex host version was not available.'));
    } catch (error) {
      checks.push(check('host_version', 'unknown', 'Codex host version could not be read.', { detail: error.message }));
    }
  } else {
    checks.push(check('host_version', 'unknown', 'Codex host version was not interrogated.'));
  }

  checks.push(check('host_hook_trust', 'unknown', 'Hook trust is a manual Codex host state and was not automated.', { manual: true }));
  checks.push(check('host_command_discovery', 'unknown', 'Command-menu discovery is a manual Codex host state.', { manual: true }));
  checks.push(check('host_pet_selection_wake', 'unknown', 'Pet selection and /pet wake state are manual Codex host states.', { manual: true }));

  return {
    schema_version: '1',
    checked_at: new Date().toISOString(),
    overall: overallStatus(checks),
    checks
  };
}
