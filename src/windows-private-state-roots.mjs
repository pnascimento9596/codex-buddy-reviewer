import { lstat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { providerTempParent } from './providers/temp-path.mjs';
import {
  enumerateRuntimeDataDirs,
  resolveDataDir,
  resolveRuntimeDataDir
} from './state.mjs';
import {
  WINDOWS_DACL_PROTOCOL_VERSION,
  ensurePrivateDir,
  filesystemAclCapable,
  verifyPrivateDir,
  verifyPrivateTree
} from './windows-private-state.mjs';
import { resolveVerifiedWindowsJobHelper } from './windows-job-supervisor.mjs';

export const WINDOWS_PRIVATE_STATE_ROOT_CLASSES = Object.freeze([
  'durable_data',
  'runtime_data',
  'provider_temp_parent'
]);

const WINDOWS_ASSURED_PATH_ORIGINS = new Set([
  'runtime_data_dir',
  'PLUGIN_DATA',
  'CLAUDE_PLUGIN_DATA',
  'legacy_fallback',
  'discovered_plugin_data_sibling'
]);

export const WINDOWS_PRIVATE_STATE_FAILURE_CODES = Object.freeze({
  generic: 'windows_private_state_acl_unavailable',
  filesystem: 'windows_private_state_filesystem_acl_unavailable',
  helperArch: 'windows_private_state_helper_arch_unavailable',
  helper: 'windows_private_state_helper_unavailable',
  helperProtocol: 'windows_private_state_helper_protocol_mismatch',
  rootSet: 'windows_private_state_root_set_changed',
  schema: 'windows_private_state_schema_unsupported'
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function helperOverrides(options) {
  const env = options.env ?? process.env;
  const helperManifestFile = options.windowsHelperManifestFile
    ?? env.CODEX_BUDDY_WINDOWS_HELPER_MANIFEST;
  const helperRoot = options.windowsHelperRoot
    ?? env.CODEX_BUDDY_WINDOWS_HELPER_ROOT;
  return {
    ...(helperManifestFile ? { helperManifestFile } : {}),
    ...(helperRoot ? { helperRoot } : {})
  };
}

function rootDefinitions(options) {
  if (options.roots !== undefined) {
    if (!Array.isArray(options.roots) || options.roots.length === 0) {
      throw new TypeError('Windows private-state roots must be a non-empty array');
    }
    return options.roots.map((root) => ({ class: root.class, path: root.path }));
  }
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  return [
    {
      class: 'durable_data',
      path: resolveDataDir(options.dataDir, env, home)
    },
    {
      class: 'runtime_data',
      path: resolveRuntimeDataDir(options.runtimeDataDir, env, home)
    },
    {
      class: 'provider_temp_parent',
      path: providerTempParent(options.tempBase ?? os.tmpdir())
    }
  ];
}

function validateRoots(roots) {
  const classes = new Set();
  for (const root of roots) {
    if (!root || typeof root !== 'object' || Array.isArray(root)
        || !WINDOWS_PRIVATE_STATE_ROOT_CLASSES.includes(root.class)
        || classes.has(root.class)
        || typeof root.path !== 'string' || !root.path) {
      throw new TypeError('Windows private-state root inventory is invalid');
    }
    classes.add(root.class);
  }
  if (classes.size !== WINDOWS_PRIVATE_STATE_ROOT_CLASSES.length
      || WINDOWS_PRIVATE_STATE_ROOT_CLASSES.some((rootClass) => !classes.has(rootClass))) {
    throw new TypeError('Windows private-state root inventory is incomplete');
  }
  return roots;
}

function windowsPathIdentity(value) {
  if (path.win32.isAbsolute(value)) return path.win32.normalize(value).toLowerCase();
  return path.resolve(value);
}

function rootBoundary(value) {
  return path.win32.isAbsolute(value) ? path.win32.parse(value).root : path.parse(value).root;
}

function validateRuntimeInventory(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('Windows assured runtime-path inventory must be an array');
  }
  const seen = new Set();
  const origins = new Set([
    'runtime_data_dir',
    'PLUGIN_DATA',
    'CLAUDE_PLUGIN_DATA',
    'discovered_plugin_data_sibling',
    'legacy_fallback'
  ]);
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.path !== 'string' || !entry.path
        || !origins.has(entry.origin)) {
      throw new TypeError('Windows assured runtime-path inventory is invalid');
    }
    const identity = windowsPathIdentity(entry.path);
    if (seen.has(identity)) {
      throw new TypeError('Windows assured runtime-path inventory contains duplicates');
    }
    seen.add(identity);
    return { path: entry.path, origin: entry.origin };
  });
}

async function assuredPathDefinitions(options, roots) {
  const enumerateImpl = options.enumerateRuntimeDataDirsImpl ?? enumerateRuntimeDataDirs;
  const entries = validateRuntimeInventory(await enumerateImpl({
    dataDir: options.dataDir,
    runtimeDataDir: options.runtimeDataDir,
    codexHome: options.codexHome,
    env: options.env,
    home: options.home,
    pluginName: options.pluginName,
    platform: options.platform,
    readdirImpl: options.readdirImpl,
    lstatImpl: options.lstatImpl
  }));
  const active = new Set(roots.map((root) => windowsPathIdentity(root.path)));
  return entries.filter((entry) => !active.has(windowsPathIdentity(entry.path)));
}

function inventoryIdentity(roots, assuredPaths) {
  const rootsIdentity = roots
    .map((root) => [root.class, windowsPathIdentity(root.path)])
    .sort(([leftClass, leftPath], [rightClass, rightPath]) => (
      leftClass.localeCompare(rightClass) || leftPath.localeCompare(rightPath)
    ));
  const assuredIdentity = assuredPaths
    .map((entry) => [entry.origin, windowsPathIdentity(entry.path)])
    .sort(([leftOrigin, leftPath], [rightOrigin, rightPath]) => (
      leftOrigin.localeCompare(rightOrigin) || leftPath.localeCompare(rightPath)
    ));
  return JSON.stringify({ roots: rootsIdentity, assured_paths: assuredIdentity });
}

async function inspectAssuredPath(entry, options) {
  const lstatImpl = options.lstatImpl ?? lstat;
  const readdirImpl = options.readdirImpl ?? readdir;
  let details;
  try {
    details = await lstatImpl(entry.path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ...entry, exists: false, holds_buddy_content: false };
    }
    throw error;
  }
  let holdsBuddyContent = false;
  if (details.isDirectory() && !details.isSymbolicLink()) {
    try {
      holdsBuddyContent = (await readdirImpl(entry.path)).length > 0;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { ...entry, exists: true, holds_buddy_content: holdsBuddyContent };
}

export function windowsPrivateStateFailureCodeForResult(result) {
  if (result?.code === 'filesystem_acl_unavailable') {
    return WINDOWS_PRIVATE_STATE_FAILURE_CODES.filesystem;
  }
  if (result?.code === 'protocol_mismatch') {
    return WINDOWS_PRIVATE_STATE_FAILURE_CODES.helperProtocol;
  }
  return typeof result?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(result.code)
    ? `windows_private_state_${result.code}`
    : WINDOWS_PRIVATE_STATE_FAILURE_CODES.generic;
}

function failedVerification({
  arch,
  code,
  message,
  helper = null,
  roots = [],
  assuredPaths = [],
  operation = null
}) {
  return deepFreeze({
    schema_version: '2',
    platform: 'win32',
    arch,
    ok: false,
    failure_code: code,
    message,
    helper,
    filesystem_acl_capable: false,
    roots,
    assured_paths: assuredPaths,
    operation
  });
}

function helperFailure(error, arch, roots) {
  const architectureUnavailable = arch === 'arm64'
    && ['helper_unavailable', 'unsupported_architecture', 'architecture_mismatch']
      .includes(error?.kind);
  return failedVerification({
    arch,
    code: architectureUnavailable
      ? WINDOWS_PRIVATE_STATE_FAILURE_CODES.helperArch
      : WINDOWS_PRIVATE_STATE_FAILURE_CODES.helper,
    message: architectureUnavailable
      ? 'No verified Windows ARM64 private-state helper is packaged.'
      : 'The verified Windows private-state helper is unavailable.',
    roots
  });
}

function helperSummary(helper) {
  return deepFreeze({
    verified: true,
    path: helper.path,
    arch: helper.arch,
    sha256: helper.sha256,
    protocol_version: helper.protocolVersion
  });
}

function operationImplementations(options) {
  return {
    filesystemAclCapable: options.filesystemAclCapableImpl ?? filesystemAclCapable,
    ensurePrivateDir: options.ensurePrivateDirImpl ?? ensurePrivateDir,
    verifyPrivateDir: options.verifyPrivateDirImpl ?? verifyPrivateDir,
    verifyPrivateTree: options.verifyPrivateTreeImpl ?? verifyPrivateTree
  };
}

async function resolveHelper(options, arch, roots) {
  const resolveHelperImpl = options.resolveHelper ?? resolveVerifiedWindowsJobHelper;
  const overrides = helperOverrides(options);
  const resolveOptions = {
    platform: 'win32',
    arch,
    ...(overrides.helperManifestFile ? { manifestFile: overrides.helperManifestFile } : {}),
    ...(overrides.helperRoot ? { helperRoot: overrides.helperRoot } : {})
  };
  try {
    const helper = await resolveHelperImpl(resolveOptions);
    if (!helper || helper.protocolVersion !== WINDOWS_DACL_PROTOCOL_VERSION) {
      return {
        failure: failedVerification({
          arch,
          code: WINDOWS_PRIVATE_STATE_FAILURE_CODES.helperProtocol,
          message: `Windows private-state helper protocol ${String(helper?.protocolVersion)} does not provide DACL protocol 2.`,
          helper: helper && typeof helper === 'object' ? helperSummary(helper) : null,
          roots
        })
      };
    }
    return { helper };
  } catch (error) {
    return { failure: helperFailure(error, arch, roots) };
  }
}

async function verifyRoots(options, { ensure, previous = null } = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return null;
  const arch = options.arch ?? process.arch;
  const roots = validateRoots(rootDefinitions(options));
  const assuredDefinitions = await assuredPathDefinitions(options, roots);
  if (previous && inventoryIdentity(roots, assuredDefinitions)
      !== inventoryIdentity(previous.roots, previous.assured_paths)) {
    return failedVerification({
      arch,
      code: WINDOWS_PRIVATE_STATE_FAILURE_CODES.rootSet,
      message: 'Windows private-state root or assured-path inventory changed after verification.',
      helper: previous.helper ?? null,
      roots,
      assuredPaths: assuredDefinitions,
      operation: { name: 'compare_root_set' }
    });
  }
  const previouslyEnsured = new Map(
    Array.isArray(previous?.roots)
      ? previous.roots.map((root) => [root.class, root.ensured === true])
      : []
  );
  const previouslyAssured = new Map(
    Array.isArray(previous?.assured_paths)
      ? previous.assured_paths.map((entry) => [windowsPathIdentity(entry.path), entry])
      : []
  );
  const assuredPaths = [];
  for (const entry of assuredDefinitions) {
    try {
      assuredPaths.push(await inspectAssuredPath(entry, options));
    } catch {
      return failedVerification({
        arch,
        code: WINDOWS_PRIVATE_STATE_FAILURE_CODES.helper,
        message: 'A Windows assured runtime path could not be inspected.',
        roots,
        assuredPaths,
        operation: { assured_path: entry.path, origin: entry.origin, name: 'inspect_assured_path' }
      });
    }
  }
  const resolved = await resolveHelper(options, arch, roots);
  if (resolved.failure) {
    return failedVerification({
      ...resolved.failure,
      arch,
      code: resolved.failure.failure_code,
      message: resolved.failure.message,
      helper: resolved.failure.helper,
      roots,
      assuredPaths
    });
  }
  const helper = resolved.helper;
  const helperInfo = helperSummary(helper);
  const implementations = operationImplementations(options);
  const daclOptions = {
    platform,
    arch,
    resolveHelper: async () => helper
  };
  const rootResults = [];
  const assuredResults = [];

  const fail = (code, message, operation) => failedVerification({
    arch,
    code,
    message,
    helper: helperInfo,
    roots: rootResults,
    assuredPaths: assuredResults,
    operation
  });

  const runOperations = async (target, operationBase, wasEnsured) => {
    let acl;
    try {
      acl = await implementations.filesystemAclCapable(target, daclOptions);
    } catch {
      return { failure: fail(
        WINDOWS_PRIVATE_STATE_FAILURE_CODES.helper,
        'The Windows private-state filesystem ACL probe failed.',
        { ...operationBase, name: 'filesystem_acl_capable' }
      ) };
    }
    if (!acl?.ok) {
      return { failure: fail(
        windowsPrivateStateFailureCodeForResult(acl),
        'A Windows private-state path is on a filesystem without verified persistent ACL support.',
        { ...operationBase, name: 'filesystem_acl_capable', helper_code: acl?.code ?? null }
      ) };
    }
    if (ensure) {
      let ensured;
      try {
        ensured = await implementations.ensurePrivateDir(target, daclOptions);
      } catch {
        return { failure: fail(
          WINDOWS_PRIVATE_STATE_FAILURE_CODES.helper,
          'The Windows private-state ensure operation failed.',
          { ...operationBase, name: 'ensure_private_dir' }
        ) };
      }
      if (!ensured?.ok) {
        return { failure: fail(
          windowsPrivateStateFailureCodeForResult(ensured),
          'A Windows private-state path could not be secured.',
          { ...operationBase, name: 'ensure_private_dir', helper_code: ensured?.code ?? null }
        ) };
      }
    }
    let verified;
    try {
      verified = await implementations.verifyPrivateDir(target, daclOptions);
    } catch {
      return { failure: fail(
        WINDOWS_PRIVATE_STATE_FAILURE_CODES.helper,
        'The Windows private-state directory verification operation failed.',
        { ...operationBase, name: 'verify_private_dir' }
      ) };
    }
    if (!verified?.ok) {
      return { failure: fail(
        windowsPrivateStateFailureCodeForResult(verified),
        'A Windows private-state path failed current-user DACL verification.',
        { ...operationBase, name: 'verify_private_dir', helper_code: verified?.code ?? null }
      ) };
    }
    let treeVerified;
    try {
      treeVerified = await implementations.verifyPrivateTree(target, rootBoundary(target), daclOptions);
    } catch {
      return { failure: fail(
        WINDOWS_PRIVATE_STATE_FAILURE_CODES.helper,
        'The Windows private-state ancestor-tree verification operation failed.',
        { ...operationBase, name: 'verify_private_tree' }
      ) };
    }
    if (!treeVerified?.ok) {
      return { failure: fail(
        windowsPrivateStateFailureCodeForResult(treeVerified),
        'A Windows private-state path has an unverified ancestor tree.',
        { ...operationBase, name: 'verify_private_tree', helper_code: treeVerified?.code ?? null }
      ) };
    }
    return {
      filesystem_acl_capable: true,
      ensured: ensure || wasEnsured,
      verified: true,
      tree_verified: true
    };
  };

  for (const root of roots) {
    const result = await runOperations(
      root.path,
      { root_class: root.class },
      previouslyEnsured.get(root.class) === true
    );
    if (result.failure) return result.failure;
    rootResults.push({ ...root, ...result });
  }

  for (const assured of assuredPaths) {
    if (!assured.exists) {
      assuredResults.push({
        ...assured,
        filesystem_acl_capable: null,
        ensured: false,
        verified: false,
        tree_verified: false
      });
      continue;
    }
    const previousAssured = previouslyAssured.get(windowsPathIdentity(assured.path));
    if (!ensure && previousAssured?.exists === false) {
      assuredResults.push({
        ...assured,
        filesystem_acl_capable: null,
        ensured: false,
        verified: false,
        tree_verified: false
      });
      return fail(
        WINDOWS_PRIVATE_STATE_FAILURE_CODES.rootSet,
        'A previously absent Windows private-state assured path became present and requires a fresh assurance cycle.',
        {
          assured_path: assured.path,
          origin: assured.origin,
          name: 'assured_path_became_present'
        }
      );
    }
    const operationBase = { assured_path: assured.path, origin: assured.origin };
    const result = await runOperations(
      assured.path,
      operationBase,
      previousAssured?.ensured === true
    );
    if (result.failure) return result.failure;
    assuredResults.push({ ...assured, ...result });
  }

  return deepFreeze({
    schema_version: '2',
    platform,
    arch,
    ok: true,
    failure_code: null,
    message: null,
    helper: helperInfo,
    filesystem_acl_capable: true,
    roots: rootResults,
    assured_paths: assuredResults,
    operation: ensure ? 'ensure_and_verify' : 'verify_only'
  });
}

export function windowsPrivateStateVerificationIsComplete(verification, { requireEnsured = true } = {}) {
  if (!verification || verification.schema_version !== '2'
      || verification.platform !== 'win32' || verification.ok !== true
      || verification.failure_code !== null
      || verification.helper?.verified !== true
      || verification.helper.arch !== verification.arch
      || typeof verification.helper.path !== 'string' || !verification.helper.path
      || !/^[a-f0-9]{64}$/u.test(verification.helper.sha256)
      || verification.helper.protocol_version !== WINDOWS_DACL_PROTOCOL_VERSION
      || verification.filesystem_acl_capable !== true
      || !Array.isArray(verification.roots)
      || verification.roots.length !== WINDOWS_PRIVATE_STATE_ROOT_CLASSES.length
      || !Array.isArray(verification.assured_paths)) {
    return false;
  }
  const roots = new Map(verification.roots.map((root) => [root.class, root]));
  if (roots.size !== WINDOWS_PRIVATE_STATE_ROOT_CLASSES.length) return false;
  const activeComplete = WINDOWS_PRIVATE_STATE_ROOT_CLASSES.every((rootClass) => {
    const root = roots.get(rootClass);
    if (!root || typeof root.path !== 'string' || !root.path) return false;
    return root.filesystem_acl_capable === true
      && root.verified === true
      && root.tree_verified === true
      && (!requireEnsured || root.ensured === true);
  });
  if (!activeComplete) return false;
  const activePaths = new Set(verification.roots.map((root) => windowsPathIdentity(root.path)));
  const assuredPaths = new Set();
  return verification.assured_paths.every((entry) => {
    if (!entry || typeof entry.path !== 'string' || !entry.path
        || typeof entry.origin !== 'string'
        || !WINDOWS_ASSURED_PATH_ORIGINS.has(entry.origin)
        || typeof entry.exists !== 'boolean'
        || typeof entry.holds_buddy_content !== 'boolean') {
      return false;
    }
    const identity = windowsPathIdentity(entry.path);
    if (activePaths.has(identity) || assuredPaths.has(identity)) return false;
    assuredPaths.add(identity);
    if (!entry.exists) {
      return entry.holds_buddy_content === false
        && entry.filesystem_acl_capable === null
        && entry.ensured === false
        && entry.verified === false
        && entry.tree_verified === false;
    }
    return entry.filesystem_acl_capable === true
      && entry.verified === true
      && entry.tree_verified === true
      && (!requireEnsured || entry.ensured === true);
  });
}

export function windowsPrivateStateRootIsVerified(verification, rootClass, rootPath) {
  if (!windowsPrivateStateVerificationIsComplete(verification, { requireEnsured: false })) return false;
  return verification.roots.some((root) => root.class === rootClass
    && root.path === rootPath && root.verified === true);
}

export function windowsPrivateStateDaclOptions(verification) {
  if (!windowsPrivateStateVerificationIsComplete(verification, { requireEnsured: false })) {
    throw new WindowsPrivateStateVerificationError(verification);
  }
  const helper = Object.freeze({
    path: verification.helper.path,
    arch: verification.helper.arch,
    sha256: verification.helper.sha256,
    protocolVersion: verification.helper.protocol_version
  });
  return Object.freeze({
    platform: 'win32',
    arch: verification.arch,
    resolveHelper: async () => helper
  });
}

export async function ensureWindowsPrivateStateRoots(options = {}) {
  return verifyRoots(options, { ensure: true });
}

export async function reverifyWindowsPrivateStateRoots(previous, options = {}) {
  if (!windowsPrivateStateVerificationIsComplete(previous)) {
    const schemaUnsupported = previous?.schema_version !== '2';
    return failedVerification({
      arch: options.arch ?? previous?.arch ?? process.arch,
      code: schemaUnsupported
        ? WINDOWS_PRIVATE_STATE_FAILURE_CODES.schema
        : previous?.failure_code ?? WINDOWS_PRIVATE_STATE_FAILURE_CODES.generic,
      message: schemaUnsupported
        ? 'Windows private-state schema v1 proofs are rejected because they never covered assured paths.'
        : 'Windows private-state roots were not previously ensured and verified.',
      helper: previous?.helper ?? null,
      roots: Array.isArray(previous?.roots) ? previous.roots : [],
      assuredPaths: Array.isArray(previous?.assured_paths) ? previous.assured_paths : []
    });
  }
  return verifyRoots({ ...options, arch: options.arch ?? previous.arch }, {
    ensure: false,
    previous
  });
}

export class WindowsPrivateStateVerificationError extends Error {
  constructor(verification, {
    execution = 'not_started',
    message = verification?.message ?? 'Windows private-state verification failed.'
  } = {}) {
    super(message);
    this.name = 'WindowsPrivateStateVerificationError';
    this.failureCode = verification?.failure_code ?? WINDOWS_PRIVATE_STATE_FAILURE_CODES.generic;
    this.platformIntegrityFailure = true;
    this.providerExecution = execution;
    this.blockMutation = true;
    Object.defineProperty(this, 'verification', {
      value: verification,
      enumerable: false,
      writable: false
    });
  }
}

export function assertWindowsPrivateStateVerification(verification, options = {}) {
  const requireEnsured = options.requireEnsured ?? false;
  if (windowsPrivateStateVerificationIsComplete(verification, { requireEnsured })) return verification;
  throw new WindowsPrivateStateVerificationError(verification, options);
}

export function isWindowsPlatformIntegrityFailure(error) {
  return error?.platformIntegrityFailure === true;
}
