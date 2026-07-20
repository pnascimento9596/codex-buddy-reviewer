import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function resolveDataDir(explicit) {
  return explicit
    ?? process.env.CODEX_BUDDY_DATA_DIR
    ?? path.join(os.homedir(), '.codex', 'codex-buddy-reviewer');
}

export function resolveRuntimeDataDir(explicit) {
  return explicit ?? process.env.PLUGIN_DATA ?? resolveDataDir();
}

export function workspaceKey(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

export function opaqueKey(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`Buddy private-state path must be a non-symlink directory: ${directory}`);
  }
  await chmod(directory, 0o700);
  return directory;
}

export async function ensurePrivateStatePath(root, directory = root) {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Buddy private-state path escapes its configured root');
  }
  await ensurePrivateDirectory(resolvedRoot);
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const details = await lstat(current);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`Buddy private-state path must be a non-symlink directory: ${current}`);
    }
    await chmod(current, 0o700);
  }
  return resolvedDirectory;
}

export async function readPrivateJson(file) {
  const maximumIdentityAttempts = 3;
  for (let attempt = 1; attempt <= maximumIdentityAttempts; attempt += 1) {
    let handle;
    try {
      const details = await lstat(file);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new Error(`Buddy private-state file must be a regular non-symlink file: ${file}`);
      }
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== details.dev || opened.ino !== details.ino) {
        if (attempt < maximumIdentityAttempts) continue;
        throw new Error(`Buddy private-state file changed while it was being opened: ${file}`);
      }
      return JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  throw new Error(`Buddy private-state file identity could not be verified: ${file}`);
}

async function syncParentDirectory(file) {
  if (process.platform === 'win32') return;
  const handle = await open(path.dirname(file), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writePrivateJsonAtomic(file, value) {
  await ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    await chmod(file, 0o600);
    await syncParentDirectory(file);
    return file;
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writePrivateJsonExclusive(file, value) {
  await ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporary, file);
    await chmod(file, 0o600);
    await syncParentDirectory(file);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function removeDeadStaleClaims(directory, staleMs) {
  const now = Date.now();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^(?:choosing|claim)-.+\.json$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const details = await stat(file).catch(() => null);
    if (!details || now - details.mtimeMs <= staleMs) continue;
    const owner = await readPrivateJson(file).catch(() => null);
    if (!processIsAlive(owner?.pid)) await rm(file, { force: true }).catch(() => {});
  }
}

function claimTicket(name) {
  const match = name.match(/^claim-(\d+)-/);
  return match ? Number(match[1]) : null;
}

export async function acquireFileLease(target, options = {}) {
  const directory = `${target}.lock`;
  const token = randomUUID();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 60_000;
  const wait = options.wait ?? true;
  const started = Date.now();
  await ensurePrivateDirectory(directory);
  await removeDeadStaleClaims(directory, staleMs);

  const choosing = path.join(directory, `choosing-${token}.json`);
  const choosingCreated = await writePrivateJsonExclusive(choosing, {
    token,
    pid: process.pid,
    choosing_at: new Date().toISOString()
  });
  if (!choosingCreated) throw new Error('could not create unique Buddy lock claim');

  let claim;
  try {
    const names = await readdir(directory);
    const maximum = names.reduce((value, name) => Math.max(value, claimTicket(name) ?? 0), 0);
    const ticket = maximum + 1;
    claim = path.join(directory, `claim-${String(ticket).padStart(12, '0')}-${token}.json`);
    const claimed = await writePrivateJsonExclusive(claim, {
      ticket,
      token,
      pid: process.pid,
      acquired_at: new Date().toISOString()
    });
    if (!claimed) throw new Error('could not create unique Buddy lock ticket');
  } finally {
    await rm(choosing, { force: true }).catch(() => {});
  }

  while (true) {
    await removeDeadStaleClaims(directory, staleMs);
    const names = await readdir(directory);
    const choosingPresent = names.some((name) => name.startsWith('choosing-'));
    const claims = names.filter((name) => claimTicket(name) !== null).sort((left, right) => {
      const ticketDifference = claimTicket(left) - claimTicket(right);
      return ticketDifference || left.localeCompare(right);
    });
    if (!choosingPresent && claims[0] === path.basename(claim)) {
      return { file: claim, token, directory };
    }
    if (!wait) {
      await rm(claim, { force: true }).catch(() => {});
      return null;
    }
    if (Date.now() - started >= timeoutMs) {
      await rm(claim, { force: true }).catch(() => {});
      throw new Error(`timed out acquiring Buddy state lock for ${path.basename(target)}`);
    }
    await pause(25);
  }
}

export async function releaseFileLease(lease) {
  if (!lease) return;
  const owner = await readPrivateJson(lease.file).catch(() => null);
  if (owner?.token === lease.token) await rm(lease.file, { force: true });
}

export async function withFileLock(target, callback, options = {}) {
  const lease = await acquireFileLease(target, options);
  try {
    return await callback();
  } finally {
    await releaseFileLease(lease);
  }
}
