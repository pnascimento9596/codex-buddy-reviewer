import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveExternalExecutable } from './executable.mjs';
import { runWindowsJobProcess } from './windows-job-supervisor.mjs';

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SUPERVISOR_FILE = fileURLToPath(new URL('./process-supervisor.mjs', import.meta.url));
const SUPERVISOR_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const PROCESS_GROUP_CLEANUP_MS = 2_000;

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function authenticatedToken(value, expected) {
  if (!SUPERVISOR_TOKEN_PATTERN.test(value) || !SUPERVISOR_TOKEN_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'));
}

function validSpawnErrorMessage(message, token) {
  return exactKeys(message, ['schema_version', 'type', 'token', 'code'])
    && message.schema_version === '1'
    && message.type === 'spawn_error'
    && authenticatedToken(message.token, token)
    && (message.code === null || typeof message.code === 'string');
}

function validSupervisorResultMessage(message, token) {
  if (!exactKeys(message, ['schema_version', 'type', 'token', 'code', 'signal', 'leader_exited'])
      || message.schema_version !== '1'
      || message.type !== 'result'
      || !authenticatedToken(message.token, token)
      || message.leader_exited !== true) {
    return false;
  }
  const exited = Number.isInteger(message.code) && message.signal === null;
  const signaled = message.code === null
    && typeof message.signal === 'string'
    && /^SIG[A-Z0-9]+$/.test(message.signal);
  return exited || signaled;
}

function forceKill(child) {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function terminate(child, onEscalation) {
  if (!child.pid) return null;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }

  const timer = setTimeout(() => {
    onEscalation();
    forceKill(child);
  }, 2_000);
  return timer;
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function forceKillAndWaitForProcessGroup(child, { force = true } = {}) {
  if (force) forceKill(child);
  if (process.platform === 'win32' || !child.pid) return;
  const deadline = Date.now() + PROCESS_GROUP_CLEANUP_MS;
  while (processGroupExists(child.pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`process group ${child.pid} remained alive after forced containment cleanup`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function runProcess(command, args, options = {}) {
  if (process.platform === 'win32') {
    return resolveExternalExecutable(command, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env
    }).then((resolvedCommand) => runResolvedProcess(resolvedCommand, args, options));
  }
  return runResolvedProcess(command, args, options);
}

function runResolvedProcess(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    input,
    timeoutMs = 30_000,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    acceptedExitCodes = [0],
    encoding = 'utf8',
    protectFromParentDeath = process.platform !== 'win32'
  } = options;

  if (process.platform === 'win32' && protectFromParentDeath) {
    return runWindowsJobProcess(command, args, {
      cwd,
      env,
      input,
      timeoutMs,
      maxOutputBytes,
      acceptedExitCodes,
      encoding,
      helperManifestFile: options.windowsHelperManifestFile
        ?? process.env.CODEX_BUDDY_WINDOWS_HELPER_MANIFEST,
      helperRoot: options.windowsHelperRoot
        ?? process.env.CODEX_BUDDY_WINDOWS_HELPER_ROOT
    });
  }

  return new Promise((resolve, reject) => {
    const supervised = protectFromParentDeath && process.platform !== 'win32';
    const supervisorToken = supervised ? randomBytes(32).toString('hex') : null;
    const child = spawn(supervised ? process.execPath : command, supervised ? [SUPERVISOR_FILE] : args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: supervised ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
      shell: false
    });

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let timeout;
    let escalationTimer;
    let escalationFired = false;
    let forcedError;
    let supervisorResult = null;
    let spawnErrorReceived = false;
    let groupKillIssued = false;

    const forceKillOnce = () => {
      if (groupKillIssued) return;
      groupKillIssued = true;
      forceKill(child);
    };

    if (supervised) {
      child.on('message', (message) => {
        if (message?.type === 'spawn_error' && validSpawnErrorMessage(message, supervisorToken)) {
          if (spawnErrorReceived || supervisorResult) {
            forcedError = new Error('Buddy process supervisor sent a duplicate or out-of-order spawn error');
            forceKillOnce();
            return;
          }
          spawnErrorReceived = true;
          const error = new Error(`${command} could not be spawned by the Buddy process supervisor`);
          if (typeof message.code === 'string') error.code = message.code;
          forcedError = error;
          forceKillOnce();
          return;
        }
        if (message?.type === 'result'
            && validSupervisorResultMessage(message, supervisorToken)) {
          if (supervisorResult) {
            forcedError = new Error('Buddy process supervisor sent a duplicate provider result');
            forceKillOnce();
            return;
          }
          supervisorResult = { code: message.code, signal: message.signal };
          // The authenticated provider leader has exited, but this detached
          // supervisor is still the live process-group leader. Kill the group
          // now, before waiting for inherited stdout/stderr descriptors to
          // reach EOF and before the numeric group id can be recycled.
          forceKillOnce();
          return;
        }
        forcedError = new Error('Buddy process supervisor sent an invalid or unauthenticated IPC result');
        forceKillOnce();
      });
      child.send({ schema_version: '1', type: 'start', token: supervisorToken, command, args }, (error) => {
        if (!error) return;
        forcedError = error;
        stopChild();
      });
    }

    const stopChild = () => {
      // Once the parent has killed a supervised group, later output, signal,
      // or deadline bookkeeping must not target the same numeric group id.
      if (supervised && groupKillIssued) return;
      if (!escalationTimer) {
        escalationTimer = terminate(child, () => {
          escalationFired = true;
          groupKillIssued = true;
        });
      }
    };

    const cancelForSignal = (signal) => {
      forcedError = new Error(`${command} cancelled by ${signal}`);
      stopChild();
    };
    const onSigint = () => cancelForSignal('SIGINT');
    const onSigterm = () => cancelForSignal('SIGTERM');

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (escalationTimer && !escalationFired) {
        clearTimeout(escalationTimer);
        if (!supervised && (timedOut || forcedError)) {
          // Supervised execution performs and verifies group cleanup in its
          // async close handler. Preserve the immediate fallback here only for
          // the direct-spawn path, whose leader may close before escalation.
          escalationFired = true;
          forceKill(child);
        }
      }
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      if (error) reject(error);
      else resolve(result);
    };

    const append = (target, chunk, currentBytes, label) => {
      const nextBytes = currentBytes + chunk.length;
      if (nextBytes > maxOutputBytes) {
        forcedError = new Error(`${label} exceeded ${maxOutputBytes} bytes`);
        stopChild();
        return currentBytes;
      }
      target.push(chunk);
      return nextBytes;
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes, 'stdout');
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = append(stderr, chunk, stderrBytes, 'stderr');
    });
    child.stdin.on('error', (error) => {
      // A process may intentionally stop reading before a large prompt is fully
      // written. Its exit status remains the authoritative result in that case.
      if (!['EPIPE', 'EOF'].includes(error.code)) {
        forcedError = error;
        stopChild();
      }
    });

    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    child.on('error', (error) => finish(error));
    child.on('exit', () => {
      if (!supervised || supervisorResult || forcedError || timedOut) return;
      // `close` waits for every inherited copy of the supervisor's output
      // descriptors. If the supervisor itself dies before authenticating the
      // provider leader result, kill its group immediately so an ordinary
      // descendant cannot hold those descriptors open until the deadline.
      forcedError = new Error('Buddy process supervisor closed without an authenticated provider result');
      forceKillOnce();
    });
    child.on('close', async (supervisorCode, supervisorSignal) => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (supervised && !supervisorResult && !forcedError && !timedOut) {
        forcedError = new Error('Buddy process supervisor closed without an authenticated provider result');
      }
      if (supervised) {
        try {
          // Authenticated normal completion already triggered the one allowed
          // parent-owned group kill while the supervisor leader was live.
          // `close` proves its inherited pipes reached EOF, so do not signal or
          // probe that numeric group id again after the leader has closed.
          if (!supervisorResult) {
            await forceKillAndWaitForProcessGroup(child, {
              force: !groupKillIssued
            });
          }
        } catch (error) {
          forcedError = error;
        }
      }
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const code = supervised && supervisorResult ? supervisorResult.code : supervisorCode;
      const signal = supervised && supervisorResult ? supervisorResult.signal : supervisorSignal;
      const result = {
        code,
        signal,
        timedOut,
        stdout: encoding === null ? stdoutBuffer : stdoutBuffer.toString(encoding),
        stderr: encoding === null ? stderrBuffer : stderrBuffer.toString(encoding)
      };
      if (forcedError) {
        finish(forcedError);
      } else if (timedOut) {
        finish(new Error(`${command} exceeded its ${timeoutMs} ms deadline`));
      } else if (!acceptedExitCodes.includes(code)) {
        const stderrText = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
        const stdoutText = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : result.stdout;
        const detail = stderrText.trim() || stdoutText.trim() || `signal ${signal ?? 'none'}`;
        finish(new Error(`${command} exited with code ${code}: ${detail.slice(0, 1200)}`));
      } else {
        finish(null, result);
      }
    });

    timeout = setTimeout(() => {
      timedOut = true;
      if (supervised && supervisorResult) {
        // Group cleanup has already been issued. If a descriptor outside that
        // group still prevents `close`, cap the drain at the command deadline
        // without sending another signal to a potentially recycled group id.
        child.stdout.destroy();
        child.stderr.destroy();
        return;
      }
      stopChild();
    }, timeoutMs);
    timeout.unref();

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
