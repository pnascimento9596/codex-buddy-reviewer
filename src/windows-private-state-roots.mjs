import os from 'node:os';

import { providerTempParent } from './providers/temp-path.mjs';
import { resolveDataDir, resolveRuntimeDataDir } from './state.mjs';
import {
  WINDOWS_DACL_PROTOCOL_VERSION,
  ensurePrivateDir,
  filesystemAclCapable,
  verifyPrivateDir
} from './windows-private-state.mjs';
import { resolveVerifiedWindowsJobHelper } from './windows-job-supervisor.mjs';

export const WINDOWS_PRIVATE_STATE_ROOT_CLASSES = Object.freeze([
  'durable_data',
  'runtime_data',
  'provider_temp_parent'
]);

export const WINDOWS_PRIVATE_STATE_FAILURE_CODES = Object.freeze({
  generic: 'windows_private_state_acl_unavailable',
  filesystem: 'windows_private_state_filesystem_acl_unavailable',
  helperArch: 'windows_private_state_helper_arch_unavailable',
  helper: 'windows_private_state_helper_unavailable',
  helperProtocol: 'windows_private_state_helper_protocol_mismatch'
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

function failureCodeForResult(result) {
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

function failedVerification({ arch, code, message, helper = null, roots = [], operation = null }) {
  return deepFreeze({
    schema_version: '1',
    platform: 'win32',
    arch,
    ok: false,
    failure_code: code,
    message,
    helper,
    filesystem_acl_capable: false,
    roots,
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
    verifyPrivateDir: options.verifyPrivateDirImpl ?? verifyPrivateDir
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
  const roots = validateRoots(previous
    ? previous.roots.map((root) => ({ class: root.class, path: root.path }))
    : rootDefinitions(options));
  const previouslyEnsured = new Map(
    Array.isArray(previous?.roots)
      ? previous.roots.map((root) => [root.class, root.ensured === true])
      : []
  );
  const resolved = await resolveHelper(options, arch, roots);
  if (resolved.failure) return resolved.failure;
  const helper = resolved.helper;
  const helperInfo = helperSummary(helper);
  const implementations = operationImplementations(options);
  const daclOptions = {
    platform,
    arch,
    resolveHelper: async () => helper
  };
  const rootResults = [];

  for (const root of roots) {
    let acl;
    try {
      acl = await implementations.filesystemAclCapable(root.path, daclOptions);
    } catch (error) {
      return failedVerification({
        arch,
        code: WINDOWS_PRIVATE_STATE_FAILURE_CODES.helper,
        message: 'The Windows private-state filesystem ACL probe failed.',
        helper: helperInfo,
        roots: rootResults,
        operation: { root_class: root.class, name: 'filesystem_acl_capable' }
      });
    }
    if (!acl?.ok) {
      return failedVerification({
        arch,
        code: failureCodeForResult(acl),
        message: 'A Windows private-state root is on a filesystem without verified persistent ACL support.',
        helper: helperInfo,
        roots: rootResults,
        operation: { root_class: root.class, name: 'filesystem_acl_capable', helper_code: acl?.code ?? null }
      });
    }

    if (ensure) {
      let ensured;
      try {
        ensured = await implementations.ensurePrivateDir(root.path, daclOptions);
      } catch {
        return failedVerification({
          arch,
          code: WINDOWS_PRIVATE_STATE_FAILURE_CODES.helper,
          message: 'The Windows private-state root ensure operation failed.',
          helper: helperInfo,
          roots: rootResults,
          operation: { root_class: root.class, name: 'ensure_private_dir' }
        });
      }
      if (!ensured?.ok) {
        return failedVerification({
          arch,
          code: failureCodeForResult(ensured),
          message: 'A Windows private-state root could not be secured.',
          helper: helperInfo,
          roots: rootResults,
          operation: { root_class: root.class, name: 'ensure_private_dir', helper_code: ensured?.code ?? null }
        });
      }
    }

    let verified;
    try {
      verified = await implementations.verifyPrivateDir(root.path, daclOptions);
    } catch {
      return failedVerification({
        arch,
        code: WINDOWS_PRIVATE_STATE_FAILURE_CODES.helper,
        message: 'The Windows private-state root verification operation failed.',
        helper: helperInfo,
        roots: rootResults,
        operation: { root_class: root.class, name: 'verify_private_dir' }
      });
    }
    if (!verified?.ok) {
      return failedVerification({
        arch,
        code: failureCodeForResult(verified),
        message: 'A Windows private-state root failed current-user DACL verification.',
        helper: helperInfo,
        roots: rootResults,
        operation: { root_class: root.class, name: 'verify_private_dir', helper_code: verified?.code ?? null }
      });
    }
    rootResults.push({
      class: root.class,
      path: root.path,
      filesystem_acl_capable: true,
      ensured: ensure || previouslyEnsured.get(root.class) === true,
      verified: true
    });
  }

  return deepFreeze({
    schema_version: '1',
    platform,
    arch,
    ok: true,
    failure_code: null,
    message: null,
    helper: helperInfo,
    filesystem_acl_capable: true,
    roots: rootResults,
    operation: ensure ? 'ensure_and_verify' : 'verify_only'
  });
}

export function windowsPrivateStateVerificationIsComplete(verification, { requireEnsured = true } = {}) {
  if (!verification || verification.schema_version !== '1'
      || verification.platform !== 'win32' || verification.ok !== true
      || verification.failure_code !== null
      || verification.helper?.verified !== true
      || verification.helper.arch !== verification.arch
      || typeof verification.helper.path !== 'string' || !verification.helper.path
      || !/^[a-f0-9]{64}$/u.test(verification.helper.sha256)
      || verification.helper.protocol_version !== WINDOWS_DACL_PROTOCOL_VERSION
      || verification.filesystem_acl_capable !== true
      || !Array.isArray(verification.roots)
      || verification.roots.length !== WINDOWS_PRIVATE_STATE_ROOT_CLASSES.length) {
    return false;
  }
  const roots = new Map(verification.roots.map((root) => [root.class, root]));
  return WINDOWS_PRIVATE_STATE_ROOT_CLASSES.every((rootClass) => {
    const root = roots.get(rootClass);
    return root && typeof root.path === 'string' && root.path
      && root.filesystem_acl_capable === true
      && root.verified === true
      && (!requireEnsured || root.ensured === true);
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
    return failedVerification({
      arch: options.arch ?? previous?.arch ?? process.arch,
      code: previous?.failure_code ?? WINDOWS_PRIVATE_STATE_FAILURE_CODES.generic,
      message: 'Windows private-state roots were not previously ensured and verified.',
      helper: previous?.helper ?? null,
      roots: Array.isArray(previous?.roots) ? previous.roots : []
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
