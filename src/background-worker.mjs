import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_FILE = fileURLToPath(new URL('../scripts/buddy-pre-review-worker.mjs', import.meta.url));
const MAX_WORKER_PAYLOAD_BYTES = 64 * 1024;

function workerEnvironment(ambient) {
  const env = { ...ambient, CODEX_BUDDY_SUPPRESS_HOOKS: '1' };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_HISTORY', 'NODE_INSPECT_RESUME_ON_START']) {
    delete env[key];
  }
  return env;
}

export async function launchPreReviewWorker(payload, options = {}) {
  const executable = options.executable ?? process.execPath;
  const workerFile = options.workerFile ?? WORKER_FILE;
  if (!path.isAbsolute(executable) || !path.isAbsolute(workerFile)) {
    throw new Error('Buddy background worker requires absolute executable and entrypoint paths');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Buddy background worker payload must be one object');
  }
  const serializedPayload = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(serializedPayload) > MAX_WORKER_PAYLOAD_BYTES) {
    throw new Error('Buddy background worker payload exceeds its private IPC limit');
  }
  const details = await (options.lstatImpl ?? lstat)(workerFile);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error('Buddy background worker entrypoint must be a regular non-symlink file');
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(executable, [workerFile], {
    cwd: path.dirname(workerFile),
    env: workerEnvironment(options.ambientEnvironment ?? process.env),
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'ignore', 'ignore']
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    child.once('error', onError);
    child.once('spawn', () => {
      child.removeListener('error', onError);
      resolve();
    });
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdin.end(serializedPayload, (error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    child.stdin.destroy?.();
    child.kill?.();
    throw error;
  }
  child.unref();
  return { pid: child.pid ?? null };
}
