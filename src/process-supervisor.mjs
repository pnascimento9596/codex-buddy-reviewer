import { spawn } from 'node:child_process';

let provider = null;
let providerComplete = false;
let started = false;
let terminationSignal = null;
let authenticationToken = null;
let resultSent = false;

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function requestProviderTermination(signal) {
  terminationSignal ??= signal;
  if (!provider || providerComplete) return;
  try { provider.kill(terminationSignal); } catch {}
}

function terminateGroupImmediately() {
  if (process.platform !== 'win32') {
    try {
      process.kill(-process.pid, 'SIGKILL');
      return;
    } catch {}
  }
  try { provider?.kill('SIGKILL'); } catch {}
  process.exit(137);
}

function validStartMessage(message) {
  return exactKeys(message, ['schema_version', 'type', 'token', 'command', 'args'])
    && message.schema_version === '1'
    && message.type === 'start'
    && TOKEN_PATTERN.test(message.token)
    && typeof message.command === 'string'
    && message.command.length > 0
    && Array.isArray(message.args)
    && message.args.every((value) => typeof value === 'string');
}

function failClosed(message) {
  try { process.stderr.write(`${message}\n`); } catch {}
  terminateGroupImmediately();
}

function sendProviderResult(code, signal) {
  if (!process.connected || resultSent) {
    failClosed('Buddy process supervisor could not authenticate a unique provider result.');
    return;
  }
  resultSent = true;
  process.send({
    schema_version: '1',
    type: 'result',
    token: authenticationToken,
    code,
    signal,
    leader_exited: true
  }, (error) => {
    if (error) failClosed('Buddy process supervisor could not deliver the provider result.');
  });
}

// The IPC channel is a parent-liveness capability. A non-catchable death of
// the caller closes it in the kernel; this supervisor then kills its detached
// process group, which also contains the non-detached provider and descendants.
process.once('disconnect', terminateGroupImmediately);

// The runProcess parent terminates the whole detached group, so this leader
// receives the graceful signal alongside the provider. Keep the group leader
// alive until the parent's fixed SIGKILL escalation fires. Otherwise a provider
// that exits promptly could leave a signal-resistant descendant behind and the
// now-empty process-group id could be recycled before the delayed group kill.
// A normal provider completion instead reports its authenticated result and
// remains alive until the outer parent kills this still-known complete group.
process.on('SIGTERM', () => requestProviderTermination('SIGTERM'));
process.on('SIGINT', () => requestProviderTermination('SIGINT'));

process.on('message', (message) => {
  if (!started) {
    if (!validStartMessage(message)) {
      failClosed('Buddy process supervisor received an invalid start message.');
      return;
    }
    started = true;
    authenticationToken = message.token;
    provider = spawn(message.command, message.args, {
      cwd: process.cwd(),
      env: process.env,
      detached: false,
      // Send provider output directly to the outer parent's pipes. Ordinary
      // descendants may inherit these descriptors without delaying the
      // provider leader's `exit` event. The outer parent still drains the
      // complete pipes before its supervisor `close` event can fire.
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: false
    });
    if (terminationSignal) requestProviderTermination(terminationSignal);
    process.stdin.pipe(provider.stdin);
    provider.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        process.stderr.write('Buddy process supervisor could not forward provider input.\n');
        try { provider.kill('SIGKILL'); } catch {}
      }
    });
    provider.once('error', (error) => {
      if (process.connected) {
        process.send({
          schema_version: '1',
          type: 'spawn_error',
          token: authenticationToken,
          code: typeof error.code === 'string' ? error.code : null
        }, (sendError) => {
          if (sendError) terminateGroupImmediately();
        });
      }
    });
    provider.once('exit', (code, signal) => {
      providerComplete = true;
      process.stdin.unpipe(provider.stdin);
      if (terminationSignal) {
        // Do not disconnect or drain the event loop. Remaining descendants share
        // this supervisor's group and the parent will consume its already-armed
        // escalation by killing the still-live leader and the complete group.
        setInterval(() => {}, 60_000).unref();
        process.stdin.resume();
        return;
      }
      sendProviderResult(code, signal);
    });
    return;
  }

  failClosed('Buddy process supervisor received an invalid or duplicate message.');
});
