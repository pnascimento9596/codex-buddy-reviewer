import { spawn } from 'node:child_process';

import {
  WindowsContainmentError,
  resolveVerifiedWindowsJobHelper
} from './windows-job-supervisor.mjs';

export const WINDOWS_DACL_PROTOCOL_VERSION = '2';

// A legal 32,766-unit Windows path can exceed 64 KiB after UTF-8 JSON
// encoding, especially when controls must be escaped.
const MAX_DACL_JSON_BYTES = 256 * 1024;
const MAX_DACL_STDERR_BYTES = 4 * 1024;
const DEFAULT_DACL_TIMEOUT_MS = 30_000;
const DACL_OPS = new Set([
  'ensure_private_dir',
  'ensure_private_file',
  'verify_private_dir',
  'verify_private_file',
  'verify_private_tree',
  'filesystem_acl_capable',
  'protocol_info'
]);
const DACL_FAILURE_CODES = new Set([
  'invalid_arguments',
  'path_not_absolute',
  'not_a_directory',
  'not_a_file',
  'reparse_point',
  'filesystem_acl_unavailable',
  'owner_mismatch',
  'wide_acl',
  'deny_ace',
  'inheritance_enabled',
  'missing_required_ace',
  'create_failed',
  'set_security_failed',
  'open_failed',
  'ancestor_reparse',
  'ancestor_escape',
  'path_too_long',
  'protocol_mismatch'
]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const SID_PATTERN = /^S-[0-9]+(?:-[0-9]+)+$/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function daclError(message, { kind = 'dacl_protocol', stage = 'dacl_protocol', cause } = {}) {
  return new WindowsContainmentError(message, { kind, stage, cause });
}

function checkedString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw daclError(`${label} must be a non-empty string without NUL bytes`, {
      kind: 'invalid_arguments', stage: 'arguments'
    });
  }
  return value;
}

function assertNoTerminalControls(value) {
  if (typeof value === 'string' && CONTROL_CHARACTERS.test(value)) {
    throw daclError('Windows helper emitted an invalid DACL protocol response');
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) assertNoTerminalControls(nested);
  }
}

function hasExactKeys(value, required, optional = []) {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function parseDaclResponse(bytes, { op, path }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_DACL_JSON_BYTES
      || bytes[bytes.length - 1] !== 0x0a || bytes.subarray(0, -1).includes(0x0a)
      || bytes.includes(0x0d)) {
    throw daclError('Windows helper emitted an invalid DACL protocol response');
  }

  let value;
  try {
    value = JSON.parse(UTF8_DECODER.decode(bytes.subarray(0, -1)));
  } catch (error) {
    throw daclError('Windows helper emitted an invalid DACL protocol response', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw daclError('Windows helper emitted an invalid DACL protocol response');
  }
  assertNoTerminalControls(value);
  if (typeof value.ok !== 'boolean' || value.op !== op || value.protocol !== 2) {
    throw daclError('Windows helper emitted an invalid DACL protocol response');
  }

  if (!value.ok) {
    if (!hasExactKeys(
      value,
      ['ok', 'op', 'code', 'message', 'win32_error', 'protocol'],
      ['path']
    ) || !DACL_FAILURE_CODES.has(value.code)
      || typeof value.message !== 'string' || value.message.length === 0
      || !Number.isInteger(value.win32_error) || value.win32_error < 0
      || value.win32_error > 0xffff_ffff
      || (Object.hasOwn(value, 'path') && value.path !== path)) {
      throw daclError('Windows helper emitted an invalid DACL protocol response');
    }
    return Object.freeze(value);
  }

  if (op === 'protocol_info') {
    if (!hasExactKeys(value, ['ok', 'op', 'job_protocol', 'dacl_protocol', 'protocol'])
        || value.job_protocol !== 1 || value.dacl_protocol !== 2) {
      throw daclError('Windows helper emitted an invalid DACL protocol response');
    }
    return Object.freeze(value);
  }
  if (op === 'filesystem_acl_capable') {
    if (!hasExactKeys(value, ['ok', 'op', 'path', 'filesystem_acl_capable', 'protocol'])
        || value.path !== path || value.filesystem_acl_capable !== true) {
      throw daclError('Windows helper emitted an invalid DACL protocol response');
    }
    return Object.freeze(value);
  }
  if (!hasExactKeys(value, ['ok', 'op', 'path', 'owner_sid', 'protocol'])
      || value.path !== path || !SID_PATTERN.test(value.owner_sid)) {
    throw daclError('Windows helper emitted an invalid DACL protocol response');
  }
  return Object.freeze(value);
}

function protocolMismatch(op, path, helperProtocol) {
  const result = {
    ok: false,
    op,
    ...(path === undefined ? {} : { path }),
    code: 'protocol_mismatch',
    message: `Windows helper capability protocol ${String(helperProtocol)} does not provide DACL protocol 2`,
    win32_error: 0,
    protocol: 2
  };
  return Object.freeze(result);
}

export async function runWindowsDaclOp(op, options = {}) {
  if (!DACL_OPS.has(op)) {
    throw daclError('Unsupported Windows DACL operation', {
      kind: 'invalid_arguments', stage: 'arguments'
    });
  }
  const {
    path: targetPath,
    ancestorsUntil,
    platform = process.platform,
    arch = process.arch,
    helperManifestFile,
    helperRoot,
    timeoutMs = DEFAULT_DACL_TIMEOUT_MS,
    resolveHelper = resolveVerifiedWindowsJobHelper,
    spawnImpl = spawn
  } = options;
  if (op !== 'protocol_info') checkedString(targetPath, 'Windows DACL path');
  if (op === 'verify_private_tree') checkedString(ancestorsUntil, 'Windows DACL ancestor anchor');
  else if (ancestorsUntil !== undefined) {
    throw daclError('--ancestors-until is only valid for verify_private_tree', {
      kind: 'invalid_arguments', stage: 'arguments'
    });
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw daclError('Windows DACL timeout must be an integer from 1 to 3600000', {
      kind: 'invalid_arguments', stage: 'arguments'
    });
  }

  const resolveOptions = { platform, arch };
  if (helperManifestFile !== undefined) resolveOptions.manifestFile = helperManifestFile;
  if (helperRoot !== undefined) resolveOptions.helperRoot = helperRoot;
  const helper = await resolveHelper(resolveOptions);
  if (helper.protocolVersion !== WINDOWS_DACL_PROTOCOL_VERSION) {
    return protocolMismatch(op, targetPath, helper.protocolVersion);
  }

  const args = ['--protocol', WINDOWS_DACL_PROTOCOL_VERSION, 'dacl', op];
  if (targetPath !== undefined) args.push('--path', targetPath);
  if (ancestorsUntil !== undefined) args.push('--ancestors-until', ancestorsUntil);

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    const failOutputLimit = (stream) => {
      try { child.kill('SIGKILL'); } catch {}
      finish(daclError(`Windows DACL helper ${stream} exceeded its output limit`));
    };

    try {
      child = spawnImpl(helper.path, args, {
        detached: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });
    } catch (error) {
      throw daclError('Verified Windows DACL helper could not be spawned', {
        kind: 'containment_unavailable', stage: 'create_process', cause: error
      });
    }

    const deadline = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(daclError(`Windows DACL helper exceeded its ${timeoutMs} ms deadline`, {
        kind: 'deadline_exceeded', stage: 'wait_process'
      }));
    }, timeoutMs);
    deadline.unref();

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_DACL_JSON_BYTES) return failOutputLimit('stdout');
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_DACL_STDERR_BYTES) return failOutputLimit('stderr');
      stderr.push(chunk);
    });
    child.once('error', (error) => finish(daclError('Verified Windows DACL helper failed to launch', {
      kind: 'containment_unavailable', stage: 'create_process', cause: error
    })));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (signal !== null || ![0, 1, 125].includes(code) || stderrBytes !== 0) {
        return finish(daclError('Windows DACL helper closed with an invalid terminal state'));
      }
      let result;
      try {
        result = parseDaclResponse(Buffer.concat(stdout), { op, path: targetPath });
      } catch (error) {
        return finish(error);
      }
      const expectedCode = result.ok ? 0 : (result.code === 'invalid_arguments' ? 125 : code);
      if ((result.ok && code !== 0) || (!result.ok && ![1, 125].includes(code))
          || (result.code === 'invalid_arguments' && code !== expectedCode)) {
        return finish(daclError('Windows DACL helper result did not match its process exit'));
      }
      return finish(null, result);
    });
  });
}

export function ensurePrivateDir(path, options = {}) {
  return runWindowsDaclOp('ensure_private_dir', { ...options, path });
}

export function ensurePrivateFile(path, options = {}) {
  return runWindowsDaclOp('ensure_private_file', { ...options, path });
}

export function verifyPrivateDir(path, options = {}) {
  return runWindowsDaclOp('verify_private_dir', { ...options, path });
}

export function verifyPrivateFile(path, options = {}) {
  return runWindowsDaclOp('verify_private_file', { ...options, path });
}

export function verifyPrivateTree(path, ancestorsUntil, options = {}) {
  return runWindowsDaclOp('verify_private_tree', { ...options, path, ancestorsUntil });
}

export function filesystemAclCapable(path, options = {}) {
  return runWindowsDaclOp('filesystem_acl_capable', { ...options, path });
}
