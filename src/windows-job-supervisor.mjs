import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAbsoluteWindowsExecutablePath } from './executable.mjs';

export const WINDOWS_JOB_PROTOCOL_VERSION = '1';

const DEFAULT_HELPER_MANIFEST = fileURLToPath(
  new URL('../native/windows/helpers.json', import.meta.url)
);
const DEFAULT_HELPER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_HELPER_BYTES = 4 * 1024 * 1024;
const MAX_CONTROL_LINE_BYTES = 512;
const MAX_WINDOWS_COMMAND_LINE_UNITS = 32_766;
const MAX_WINDOWS_TIMEOUT_MS = 3_600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const HELPER_ESCALATION_MS = 2_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const CLOSED_ERROR_STAGES = new Set([
  'arguments',
  'connect_control',
  'control_protocol',
  'create_job',
  'configure_job',
  'create_timer',
  'create_process',
  'assign_job',
  'create_monitor',
  'resume_process',
  'wait_process',
  'query_exit',
  'terminate_job',
  'cleanup_job'
]);
const CLOSED_TERMINATION_REASONS = new Set([
  'timeout',
  'output_limit',
  'signal',
  'caller',
  'parent_death',
  'protocol'
]);
const PE_MACHINE = Object.freeze({ x64: 0x8664, arm64: 0xaa64 });

export class WindowsContainmentError extends Error {
  constructor(message, {
    kind = 'containment_unavailable',
    stage = null,
    win32Error = null,
    code = null,
    cause
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WindowsContainmentError';
    this.kind = kind;
    this.stage = stage;
    this.win32Error = win32Error;
    if (code) this.code = code;
  }
}

function containmentError(message, options = {}) {
  return new WindowsContainmentError(message, options);
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw containmentError(`${label} must be a non-empty string without NUL bytes`, {
      kind: 'invalid_arguments', stage: 'arguments'
    });
  }
  return value;
}

function checkedTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WINDOWS_TIMEOUT_MS) {
    throw containmentError(`Windows provider timeout must be an integer from 1 to ${MAX_WINDOWS_TIMEOUT_MS}`, {
      kind: 'invalid_arguments', stage: 'arguments'
    });
  }
  return value;
}

function assertAbortSignal(signal) {
  if (signal === undefined) return;
  if (!(signal instanceof AbortSignal)) {
    throw containmentError('Windows process cancellation signal must be an AbortSignal', {
      kind: 'invalid_arguments', stage: 'arguments'
    });
  }
}

function cancellationError(command) {
  return containmentError(`${command} was cancelled`, {
    kind: 'cancelled', stage: 'wait_process', code: 'ABORT_ERR'
  });
}

export function quoteWindowsArgument(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TypeError('Windows command arguments must be strings without NUL bytes');
  }

  let output = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      output += '\\'.repeat((backslashes * 2) + 1);
      output += '"';
      backslashes = 0;
      continue;
    }
    output += '\\'.repeat(backslashes);
    output += character;
    backslashes = 0;
  }
  output += '\\'.repeat(backslashes * 2);
  output += '"';
  return output;
}

export function buildWindowsCommandLine(command, args = []) {
  assertString(command, 'Windows provider command');
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new TypeError('Windows provider arguments must be an array of strings without NUL bytes');
  }
  const commandLine = [command, ...args].map(quoteWindowsArgument).join(' ');
  if (commandLine.length > MAX_WINDOWS_COMMAND_LINE_UNITS) {
    throw containmentError('Windows provider command line exceeds 32766 UTF-16 code units', {
      kind: 'invalid_arguments', stage: 'arguments'
    });
  }
  return commandLine;
}

function validateRelativeHelperPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || path.isAbsolute(value)) {
    throw containmentError('Windows helper manifest contains an invalid helper path');
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw containmentError('Windows helper path escapes its verified root');
  }
  return normalized;
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function equalHex(left, right) {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function readPeMachine(file, fileSize) {
  if (fileSize < 64) throw containmentError('Windows helper is not a valid PE image');
  const handle = await open(file, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0);
    if (dosRead.bytesRead !== dosHeader.length || dosHeader.toString('ascii', 0, 2) !== 'MZ') {
      throw containmentError('Windows helper is not a valid PE image');
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > fileSize - 6 || peOffset > MAX_HELPER_BYTES - 6) {
      throw containmentError('Windows helper contains an invalid PE header offset');
    }
    const peHeader = Buffer.alloc(6);
    const peRead = await handle.read(peHeader, 0, peHeader.length, peOffset);
    if (peRead.bytesRead !== peHeader.length || peHeader.toString('binary', 0, 4) !== 'PE\0\0') {
      throw containmentError('Windows helper is not a valid PE image');
    }
    return peHeader.readUInt16LE(4);
  } finally {
    await handle.close();
  }
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.schema_version !== '1'
      || manifest.protocol_version !== WINDOWS_JOB_PROTOCOL_VERSION
      || !manifest.helpers || typeof manifest.helpers !== 'object' || Array.isArray(manifest.helpers)) {
    throw containmentError('Windows helper manifest has an unsupported schema or protocol');
  }
  return manifest;
}

export async function resolveVerifiedWindowsJobHelper({
  platform = process.platform,
  arch = process.arch,
  manifestFile = DEFAULT_HELPER_MANIFEST,
  helperRoot = DEFAULT_HELPER_ROOT
} = {}) {
  if (platform !== 'win32') {
    throw containmentError('Windows Job Object supervision is unavailable on this platform', {
      kind: 'unsupported_platform'
    });
  }
  if (!Object.hasOwn(PE_MACHINE, arch)) {
    throw containmentError(`No Windows Job Object helper is supported for architecture ${String(arch)}`, {
      kind: 'unsupported_architecture'
    });
  }

  let manifest;
  try {
    manifest = validateManifestShape(JSON.parse(await readFile(manifestFile, 'utf8')));
  } catch (error) {
    if (error instanceof WindowsContainmentError) throw error;
    throw containmentError('Windows helper manifest could not be read or parsed', { cause: error });
  }

  const key = `win32-${arch}`;
  const record = manifest.helpers[key];
  if (!record || record.status !== 'verified') {
    throw containmentError(`No verified Windows Job Object helper is packaged for ${key}`, {
      kind: 'helper_unavailable'
    });
  }
  if (record.protocol_version !== WINDOWS_JOB_PROTOCOL_VERSION
      || !SHA256_PATTERN.test(record.sha256)) {
    throw containmentError(`Windows Job Object helper metadata is invalid for ${key}`);
  }

  const relative = validateRelativeHelperPath(record.path);
  const root = await realpath(helperRoot).catch((error) => {
    throw containmentError('Windows helper root could not be resolved', { cause: error });
  });
  const requested = path.resolve(root, relative);
  if (!pathInside(root, requested)) {
    throw containmentError('Windows helper path escapes its verified root');
  }

  let details;
  try {
    details = await lstat(requested);
  } catch (error) {
    throw containmentError('Verified Windows Job Object helper is missing', {
      kind: 'helper_unavailable', cause: error
    });
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw containmentError('Windows Job Object helper must be a regular non-symlink file');
  }
  if (details.size < 64 || details.size > MAX_HELPER_BYTES) {
    throw containmentError(`Windows Job Object helper must be from 64 to ${MAX_HELPER_BYTES} bytes`);
  }

  const canonical = await realpath(requested).catch((error) => {
    throw containmentError('Windows helper path could not be resolved', { cause: error });
  });
  if (!pathInside(root, canonical)) {
    throw containmentError('Windows helper resolves outside its verified root');
  }
  const actualHash = await sha256File(canonical);
  if (!equalHex(actualHash, record.sha256)) {
    throw containmentError('Windows Job Object helper failed its SHA-256 integrity check', {
      kind: 'integrity_mismatch'
    });
  }
  const machine = await readPeMachine(canonical, details.size);
  if (machine !== PE_MACHINE[arch]) {
    throw containmentError(`Windows Job Object helper PE architecture does not match ${arch}`, {
      kind: 'architecture_mismatch'
    });
  }

  return Object.freeze({
    path: canonical,
    arch,
    sha256: actualHash,
    protocolVersion: WINDOWS_JOB_PROTOCOL_VERSION
  });
}

export function parseWindowsJobControlLine(line, expectedToken = null) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_CONTROL_LINE_BYTES
      || line.includes('\r') || line.includes('\n') || /[^\x20-\x7e]/.test(line)) {
    throw containmentError('Windows helper emitted an invalid control record', {
      kind: 'control_protocol', stage: 'control_protocol'
    });
  }
  const fields = line.split(' ');
  if (fields[0] !== 'CBJ' || fields[1] !== WINDOWS_JOB_PROTOCOL_VERSION) {
    throw containmentError('Windows helper protocol version mismatch', {
      kind: 'control_protocol', stage: 'control_protocol'
    });
  }
  const type = fields[2];
  if (type === 'HELLO' && fields.length === 4 && TOKEN_PATTERN.test(fields[3])) {
    if (expectedToken !== null && fields[3] !== expectedToken) {
      throw containmentError('Windows helper control token mismatch', {
        kind: 'control_protocol', stage: 'control_protocol'
      });
    }
    return Object.freeze({ type: 'hello', token: fields[3] });
  }
  if (type === 'READY' && fields.length === 4 && /^[1-9][0-9]{0,9}$/.test(fields[3])) {
    const pid = Number(fields[3]);
    if (Number.isSafeInteger(pid) && pid <= 0xffff_ffff) return Object.freeze({ type: 'ready', pid });
  }
  if (type === 'EXIT' && fields.length === 4 && /^(?:0|[1-9][0-9]{0,9})$/.test(fields[3])) {
    const code = Number(fields[3]);
    if (Number.isSafeInteger(code) && code <= 0xffff_ffff) return Object.freeze({ type: 'exit', code });
  }
  if (type === 'ERROR' && fields.length === 5 && CLOSED_ERROR_STAGES.has(fields[3])
      && /^(?:0|[1-9][0-9]{0,9})$/.test(fields[4])) {
    const win32Error = Number(fields[4]);
    if (Number.isSafeInteger(win32Error) && win32Error <= 0xffff_ffff) {
      return Object.freeze({ type: 'error', stage: fields[3], win32Error });
    }
  }
  if (type === 'TERMINATED' && fields.length === 4 && CLOSED_TERMINATION_REASONS.has(fields[3])) {
    return Object.freeze({ type: 'terminated', reason: fields[3] });
  }
  throw containmentError('Windows helper emitted an unsupported control record', {
    kind: 'control_protocol', stage: 'control_protocol'
  });
}

export function parseWindowsJobControlBytes(lineBytes, expectedToken = null) {
  if (!Buffer.isBuffer(lineBytes) || lineBytes.length > MAX_CONTROL_LINE_BYTES) {
    throw containmentError('Windows helper emitted an invalid control record', {
      kind: 'control_protocol', stage: 'control_protocol'
    });
  }
  for (const byte of lineBytes) {
    if (byte < 0x20 || byte > 0x7e) {
      throw containmentError('Windows helper emitted an invalid control record', {
        kind: 'control_protocol', stage: 'control_protocol'
      });
    }
  }
  return parseWindowsJobControlLine(lineBytes.toString('ascii'), expectedToken);
}

export function validateWindowsJobHelperClose(terminalRecord, exitCode, signal) {
  let expectedExitCode;
  if (terminalRecord?.type === 'exit') expectedExitCode = terminalRecord.code;
  else if (terminalRecord?.type === 'terminated') expectedExitCode = 124;
  else if (terminalRecord?.type === 'error') expectedExitCode = 125;
  else {
    throw containmentError('Windows Job Object helper closed without a valid terminal state', {
      kind: 'control_protocol', stage: 'control_protocol'
    });
  }

  if (signal !== null || exitCode !== expectedExitCode) {
    throw containmentError('Windows Job Object helper close did not match its terminal control record', {
      kind: 'control_protocol', stage: 'control_protocol'
    });
  }
}

function helperFailure(command, record) {
  if (record.stage === 'create_process' && [2, 3].includes(record.win32Error)) {
    return containmentError(`${command} could not be spawned by the Windows Job Object supervisor`, {
      kind: 'spawn_error', stage: record.stage, win32Error: record.win32Error, code: 'ENOENT'
    });
  }
  return containmentError(`Windows Job Object supervision failed during ${record.stage}`, {
    kind: 'containment_unavailable', stage: record.stage, win32Error: record.win32Error
  });
}

function makePipeName(identifier) {
  return `\\\\.\\pipe\\codex-buddy-job-${process.pid}-${identifier}`;
}

export function createWindowsJobControlCredentials({ randomBytesImpl = randomBytes } = {}) {
  if (typeof randomBytesImpl !== 'function') {
    throw new TypeError('Windows control credential generator must be a function');
  }
  const tokenBytes = randomBytesImpl(32);
  const pipeIdentifierBytes = randomBytesImpl(32);
  if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 32
      || !Buffer.isBuffer(pipeIdentifierBytes) || pipeIdentifierBytes.length !== 32) {
    throw containmentError('Windows control credential generator returned invalid entropy', {
      kind: 'containment_unavailable', stage: 'connect_control'
    });
  }
  if (timingSafeEqual(tokenBytes, pipeIdentifierBytes)) {
    throw containmentError('Windows control pipe identifier collided with its HELLO authenticator', {
      kind: 'containment_unavailable', stage: 'connect_control'
    });
  }
  const token = tokenBytes.toString('hex');
  const pipeName = makePipeName(pipeIdentifierBytes.toString('hex'));
  if (pipeName.includes(token)) {
    throw containmentError('Windows control pipe address exposed its HELLO authenticator', {
      kind: 'containment_unavailable', stage: 'connect_control'
    });
  }
  return Object.freeze({ token, pipeName });
}

function appendBounded(target, chunk, currentBytes, maximum, label, cancel) {
  const nextBytes = currentBytes + chunk.length;
  if (nextBytes > maximum) {
    cancel(containmentError(`${label} exceeded ${maximum} bytes`, {
      kind: 'output_limit', stage: 'wait_process'
    }), 'output_limit');
    return currentBytes;
  }
  target.push(chunk);
  return nextBytes;
}

export async function runWindowsJobProcess(command, args, options = {}) {
  if (process.platform !== 'win32') {
    throw containmentError('Windows Job Object supervision is unavailable on this platform', {
      kind: 'unsupported_platform'
    });
  }
  assertString(command, 'Windows provider command');
  try {
    assertAbsoluteWindowsExecutablePath(command);
  } catch (error) {
    throw containmentError('Windows provider command must be a local drive-qualified .exe or .com path', {
      kind: 'invalid_arguments', stage: 'arguments', cause: error
    });
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw containmentError('Windows provider arguments must be an array of strings without NUL bytes', {
      kind: 'invalid_arguments', stage: 'arguments'
    });
  }
  buildWindowsCommandLine(command, args);

  const {
    cwd,
    env = process.env,
    input,
    timeoutMs = 30_000,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    acceptedExitCodes = [0],
    encoding = 'utf8',
    signal,
    helperManifestFile = DEFAULT_HELPER_MANIFEST,
    helperRoot = DEFAULT_HELPER_ROOT
  } = options;
  assertAbortSignal(signal);
  if (signal?.aborted) throw cancellationError(command);
  checkedTimeout(timeoutMs);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw containmentError('Windows maximum output bytes must be a positive safe integer', {
      kind: 'invalid_arguments', stage: 'arguments'
    });
  }
  if (!Array.isArray(acceptedExitCodes)
      || acceptedExitCodes.some((code) => !Number.isSafeInteger(code) || code < 0 || code > 0xffff_ffff)) {
    throw containmentError('Windows accepted exit codes must be unsigned 32-bit integers', {
      kind: 'invalid_arguments', stage: 'arguments'
    });
  }

  const helper = await resolveVerifiedWindowsJobHelper({
    manifestFile: helperManifestFile,
    helperRoot
  });
  if (signal?.aborted) throw cancellationError(command);
  const { token, pipeName } = createWindowsJobControlCredentials();
  const server = net.createServer({ allowHalfOpen: false });
  server.maxConnections = 1;
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(containmentError('Windows helper control pipe could not be created', {
      kind: 'containment_unavailable', stage: 'connect_control', cause: error
    }));
    server.once('error', onError);
    server.listen(pipeName, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let child;
    let control = null;
    let controlBuffer = Buffer.alloc(0);
    let controlState = 'awaiting_hello';
    let controlClosed = false;
    let terminalRecord = null;
    let childClosed = false;
    let childExitCode = null;
    let childSignal = null;
    let settled = false;
    let forcedError = null;
    let forcedReason = null;
    let timedOut = false;
    let deadline;
    let escalation;

    const closeResources = () => {
      if (deadline) clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      signal?.removeEventListener('abort', onAbort);
      control?.destroy();
      server.close();
    };

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      closeResources();
      if (error) reject(error);
      else resolve(result);
    };

    const killHelper = () => {
      if (!child || childClosed) return;
      try { child.kill('SIGKILL'); } catch {}
    };

    const sendControl = (record) => {
      if (!control || control.destroyed || !control.writable) return false;
      return control.write(`CBJ ${WINDOWS_JOB_PROTOCOL_VERSION} ${record}\n`);
    };

    const cancel = (error, reason) => {
      forcedError ??= error;
      forcedReason ??= reason;
      if (!escalation) {
        sendControl(`CANCEL ${reason}`);
        escalation = setTimeout(killHelper, HELPER_ESCALATION_MS);
        escalation.unref();
      }
    };

    const cancelForSignal = (signal) => cancel(
      containmentError(`${command} cancelled by ${signal}`, { kind: 'cancelled' }),
      'signal'
    );
    const onSigint = () => cancelForSignal('SIGINT');
    const onSigterm = () => cancelForSignal('SIGTERM');
    const onAbort = () => cancel(cancellationError(command), 'caller');

    const maybeFinish = () => {
      if (!childClosed) return;
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const result = {
        code: terminalRecord?.type === 'exit' ? terminalRecord.code : null,
        signal: null,
        timedOut,
        stdout: encoding === null ? stdoutBuffer : stdoutBuffer.toString(encoding),
        stderr: encoding === null ? stderrBuffer : stderrBuffer.toString(encoding)
      };
      if (forcedError) return finish(forcedError);
      if (!terminalRecord) {
        return finish(containmentError('Windows Job Object helper exited without a terminal control record', {
          kind: 'control_protocol', stage: 'control_protocol'
        }));
      }
      try {
        validateWindowsJobHelperClose(terminalRecord, childExitCode, childSignal);
      } catch (error) {
        return finish(error);
      }
      if (terminalRecord.type === 'error') return finish(helperFailure(command, terminalRecord));
      if (terminalRecord.type === 'terminated') {
        if (terminalRecord.reason === 'timeout') {
          return finish(containmentError(`${command} exceeded its ${timeoutMs} ms deadline`, {
            kind: 'deadline_exceeded'
          }));
        }
        return finish(containmentError(`Windows Job Object helper terminated the provider after ${terminalRecord.reason}`, {
          kind: 'containment_terminated', stage: 'wait_process'
        }));
      }
      if (terminalRecord.type !== 'exit') {
        return finish(containmentError('Windows Job Object helper returned an invalid terminal state', {
          kind: 'control_protocol', stage: 'control_protocol'
        }));
      }
      if (!acceptedExitCodes.includes(result.code)) {
        const stderrText = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
        const stdoutText = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : result.stdout;
        const detail = stderrText.trim() || stdoutText.trim() || 'no diagnostic output';
        return finish(containmentError(`${command} exited with code ${result.code}: ${detail.slice(0, 1200)}`, {
          kind: 'transport_exit'
        }));
      }
      return finish(null, result);
    };

    const handleControlRecord = (record) => {
      if (controlState === 'awaiting_hello') {
        if (record.type !== 'hello') throw containmentError('Windows helper did not begin with HELLO', {
          kind: 'control_protocol', stage: 'control_protocol'
        });
        controlState = 'awaiting_ready';
        sendControl(forcedError ? `CANCEL ${forcedReason ?? 'caller'}` : 'START');
        return;
      }
      if (controlState === 'awaiting_ready') {
        if (record.type === 'error') {
          terminalRecord = record;
          controlState = 'terminal';
          if (childClosed) maybeFinish();
          return;
        }
        if (record.type !== 'ready') throw containmentError('Windows helper did not assign the provider before READY', {
          kind: 'control_protocol', stage: 'control_protocol'
        });
        controlState = 'running';
        return;
      }
      if (controlState === 'running') {
        if (!['exit', 'error', 'terminated'].includes(record.type)) {
          throw containmentError('Windows helper emitted a non-terminal record after READY', {
            kind: 'control_protocol', stage: 'control_protocol'
          });
        }
        terminalRecord = record;
        controlState = 'terminal';
        if (childClosed) maybeFinish();
        return;
      }
      throw containmentError('Windows helper emitted a record after its terminal state', {
        kind: 'control_protocol', stage: 'control_protocol'
      });
    };

    server.on('connection', (socket) => {
      if (control) {
        socket.destroy();
        cancel(containmentError('Windows helper control pipe received multiple clients', {
          kind: 'control_protocol', stage: 'control_protocol'
        }), 'protocol');
        return;
      }
      control = socket;
      socket.on('data', (chunk) => {
        try {
          controlBuffer = Buffer.concat([controlBuffer, chunk]);
          if (controlBuffer.length > MAX_CONTROL_LINE_BYTES * 4) {
            throw containmentError('Windows helper exceeded its bounded control buffer', {
              kind: 'control_protocol', stage: 'control_protocol'
            });
          }
          while (true) {
            const newline = controlBuffer.indexOf(0x0a);
            if (newline === -1) break;
            if (newline > MAX_CONTROL_LINE_BYTES) {
              throw containmentError('Windows helper exceeded its bounded control record', {
                kind: 'control_protocol', stage: 'control_protocol'
              });
            }
            const line = controlBuffer.subarray(0, newline);
            controlBuffer = controlBuffer.subarray(newline + 1);
            const record = parseWindowsJobControlBytes(
              line,
              controlState === 'awaiting_hello' ? token : null
            );
            handleControlRecord(record);
          }
        } catch (error) {
          cancel(error, 'protocol');
        }
      });
      socket.on('error', (error) => {
        cancel(containmentError('Windows helper control pipe failed', {
          kind: 'control_protocol', stage: 'control_protocol', cause: error
        }), 'protocol');
      });
      socket.on('close', () => {
        controlClosed = true;
        if (controlBuffer.length !== 0 && !forcedError) {
          forcedError = containmentError('Windows helper closed with an incomplete control record', {
            kind: 'control_protocol', stage: 'control_protocol'
          });
        }
        if (!settled && !childClosed && controlState !== 'terminal') {
          cancel(containmentError('Windows helper control pipe closed before a terminal record', {
            kind: 'control_protocol', stage: 'control_protocol'
          }), 'protocol');
        }
        if (childClosed) maybeFinish();
      });
    });

    server.on('error', (error) => {
      cancel(containmentError('Windows helper control server failed', {
        kind: 'control_protocol', stage: 'connect_control', cause: error
      }), 'protocol');
    });

    try {
      child = spawn(helper.path, [
        '--protocol', WINDOWS_JOB_PROTOCOL_VERSION,
        '--control', pipeName,
        '--token', token,
        '--timeout-ms', String(timeoutMs),
        '--', command, ...args
      ], {
        cwd,
        env,
        detached: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      });
    } catch (error) {
      finish(containmentError('Verified Windows Job Object helper could not be spawned', {
        kind: 'containment_unavailable', stage: 'create_process', cause: error
      }));
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes = appendBounded(stdout, chunk, stdoutBytes, maxOutputBytes, 'stdout', cancel);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = appendBounded(stderr, chunk, stderrBytes, maxOutputBytes, 'stderr', cancel);
    });
    child.stdin.on('error', (error) => {
      if (!['EPIPE', 'EOF'].includes(error.code)) cancel(error, 'caller');
    });
    child.on('error', (error) => finish(containmentError('Verified Windows Job Object helper failed to launch', {
      kind: 'containment_unavailable', stage: 'create_process', cause: error
    })));
    child.on('close', (code, signal) => {
      childClosed = true;
      childExitCode = code;
      childSignal = signal;
      if (!control || controlClosed || controlState === 'terminal') maybeFinish();
    });

    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    deadline = setTimeout(() => {
      timedOut = true;
      cancel(containmentError(`${command} exceeded its ${timeoutMs} ms deadline`, {
        kind: 'deadline_exceeded'
      }), 'timeout');
    }, timeoutMs);
    deadline.unref();

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
