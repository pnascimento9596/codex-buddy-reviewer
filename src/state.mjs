import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensurePrivateFile } from './windows-private-state.mjs';

export const BUDDY_PLUGIN_PACKAGE_NAME = 'codex-buddy-reviewer';

export function resolveDataDir(explicit, env = process.env, home = os.homedir()) {
  return explicit
    ?? env.CODEX_BUDDY_DATA_DIR
    ?? path.join(home, '.codex', BUDDY_PLUGIN_PACKAGE_NAME);
}

export function resolveRuntimeDataDir(explicit, env = process.env, home = os.homedir()) {
  return explicit ?? env.PLUGIN_DATA ?? resolveDataDir(undefined, env, home);
}

export function resolveBuddyCodexHome(explicit, env = process.env, home = os.homedir()) {
  return path.resolve(explicit ?? env.CODEX_HOME ?? path.join(home, '.codex'));
}

export function isBuddyPluginDataDirName(name, pluginName = BUDDY_PLUGIN_PACKAGE_NAME) {
  return typeof name === 'string'
    && (name === pluginName || name.startsWith(`${pluginName}-`));
}

/**
 * Every runtime root this plugin identity may have written on the host.
 *
 * Order is stable and intentional:
 * 1. explicit --runtime-data-dir / caller override
 * 2. host-exported PLUGIN_DATA / CLAUDE_PLUGIN_DATA
 * 3. discovered buddy-owned directories under <CODEX_HOME>/plugins/data/
 * 4. the durable data-dir fallback (legacy home path)
 *
 * Status and purge must account for all of these. Write paths (hooks) still use
 * a single active root via resolveRuntimeDataDir / host-runtime.
 */
export async function enumerateRuntimeDataDirs({
  dataDir,
  runtimeDataDir,
  codexHome,
  env = process.env,
  home = os.homedir(),
  pluginName = BUDDY_PLUGIN_PACKAGE_NAME,
  platform = process.platform,
  readdirImpl = readdir,
  lstatImpl = lstat
} = {}) {
  const roots = [];
  const seen = new Set();
  const add = (candidate, origin) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    const resolved = path.resolve(candidate.trim());
    const identity = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(identity)) return;
    seen.add(identity);
    roots.push(Object.freeze({ path: resolved, origin }));
  };

  add(runtimeDataDir, 'runtime_data_dir');
  for (const key of ['PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) add(value, key);
  }

  const pluginsDataRoot = path.join(resolveBuddyCodexHome(codexHome, env, home), 'plugins', 'data');
  try {
    const entries = await readdirImpl(pluginsDataRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!isBuddyPluginDataDirName(entry.name, pluginName)) continue;
      const candidate = path.join(pluginsDataRoot, entry.name);
      let details;
      try {
        details = await lstatImpl(candidate);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      // Discovery never follows a swapped root. Symlinked plugin-data entries are
      // ignored so status/purge cannot be pointed at an arbitrary filesystem tree.
      if (details.isSymbolicLink() || !details.isDirectory()) continue;
      add(candidate, 'discovered_plugin_data_sibling');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  add(resolveDataDir(dataDir, env, home), 'legacy_fallback');
  return Object.freeze([...roots]);
}

async function resolvePhysicalCandidate(candidate) {
  let current = path.resolve(candidate);
  const unresolved = [];
  while (true) {
    try {
      return path.resolve(await realpath(current), ...unresolved);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      unresolved.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function assertStateOutsideRepository(repositoryRoot, stateRoot, label = 'private state') {
  const [resolvedRepository, resolvedState] = await Promise.all([
    resolvePhysicalCandidate(repositoryRoot),
    resolvePhysicalCandidate(stateRoot)
  ]);
  const relative = path.relative(resolvedRepository, resolvedState);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative))) {
    throw new Error(`Buddy ${label} directory must be outside the reviewed repository`);
  }
  return resolvedState;
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

const WINDOWS_ATOMIC_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WINDOWS_ATOMIC_RENAME_RETRY_DELAYS_MS = Object.freeze([10, 20, 40, 80, 160]);

async function renamePrivateJsonAtomic(source, destination, {
  platform,
  renameImpl,
  pauseImpl
}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameImpl(source, destination);
      return;
    } catch (error) {
      const retryable = platform === 'win32'
        && WINDOWS_ATOMIC_RENAME_RETRY_CODES.has(error?.code)
        && attempt < WINDOWS_ATOMIC_RENAME_RETRY_DELAYS_MS.length;
      if (!retryable) throw error;
      await pauseImpl(WINDOWS_ATOMIC_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function ensureWindowsPrivateFinalFile(file, {
  platform,
  arch = process.arch,
  env = process.env,
  ensurePrivateFileImpl = ensurePrivateFile,
  windowsHelperManifestFile,
  windowsHelperRoot,
  requireWindowsPrivateFileDacl = false
}) {
  if (platform !== 'win32') return;
  // Per-write DACL ensure is opt-in for verified-leaf paths (rejected-response,
  // explicit secure writes). The live-egress gate depends on root ensure/verify
  // plus inheritance, not a helper round-trip on every hot-path file write.
  if (!requireWindowsPrivateFileDacl) return;
  if (typeof ensurePrivateFileImpl !== 'function') {
    throw new TypeError('Windows private file DACL ensure must be callable');
  }
  const helperManifestFile = windowsHelperManifestFile
    ?? env.CODEX_BUDDY_WINDOWS_HELPER_MANIFEST;
  const helperRoot = windowsHelperRoot
    ?? env.CODEX_BUDDY_WINDOWS_HELPER_ROOT;
  const result = await ensurePrivateFileImpl(file, {
    platform,
    arch,
    ...(helperManifestFile ? { helperManifestFile } : {}),
    ...(helperRoot ? { helperRoot } : {})
  });
  if (!result?.ok) {
    const error = new Error(
      `Buddy private-state final file failed Windows DACL ensure (${result?.code ?? 'unknown'})`
    );
    error.failureCode = result?.code === 'protocol_mismatch'
      ? 'windows_private_state_helper_protocol_mismatch'
      : result?.code === 'filesystem_acl_unavailable'
        ? 'windows_private_state_filesystem_acl_unavailable'
        : typeof result?.code === 'string'
          ? `windows_private_state_${result.code}`
          : 'windows_private_state_acl_unavailable';
    throw error;
  }
}

export async function writePrivateJsonAtomic(file, value, {
  platform = process.platform,
  renameImpl = rename,
  pauseImpl = pause,
  arch = process.arch,
  env = process.env,
  ensurePrivateFileImpl = ensurePrivateFile,
  windowsHelperManifestFile,
  windowsHelperRoot,
  requireWindowsPrivateFileDacl = false
} = {}) {
  await ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    // Mode the temp inode before rename so concurrent cleanup cannot race a
    // post-rename chmod against a destination that has already disappeared.
    await chmod(temporary, 0o600);
    await ensureWindowsPrivateFinalFile(temporary, {
      platform,
      arch,
      env,
      ensurePrivateFileImpl,
      windowsHelperManifestFile,
      windowsHelperRoot,
      requireWindowsPrivateFileDacl
    });
    await renamePrivateJsonAtomic(temporary, file, { platform, renameImpl, pauseImpl });
    await ensureWindowsPrivateFinalFile(file, {
      platform,
      arch,
      env,
      ensurePrivateFileImpl,
      windowsHelperManifestFile,
      windowsHelperRoot,
      requireWindowsPrivateFileDacl
    });
    await syncParentDirectory(file);
    return file;
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writePrivateJsonExclusive(file, value, {
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  ensurePrivateFileImpl = ensurePrivateFile,
  windowsHelperManifestFile,
  windowsHelperRoot,
  requireWindowsPrivateFileDacl = false
} = {}) {
  await ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await ensureWindowsPrivateFinalFile(temporary, {
      platform,
      arch,
      env,
      ensurePrivateFileImpl,
      windowsHelperManifestFile,
      windowsHelperRoot,
      requireWindowsPrivateFileDacl
    });
    await link(temporary, file);
    await ensureWindowsPrivateFinalFile(file, {
      platform,
      arch,
      env,
      ensurePrivateFileImpl,
      windowsHelperManifestFile,
      windowsHelperRoot,
      requireWindowsPrivateFileDacl
    });
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
