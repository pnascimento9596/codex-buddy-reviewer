import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_EXECUTABLE_EXTENSIONS = Object.freeze(['.com', '.exe']);

export class ExecutableResolutionError extends Error {
  constructor(message, { code = 'EINVAL', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ExecutableResolutionError';
    this.code = code;
  }
}

function resolutionError(message, options = {}) {
  return new ExecutableResolutionError(message, options);
}

function commandText(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw resolutionError('Executable command must be non-empty text without NUL bytes');
  }
  if (value.startsWith('-')) {
    throw resolutionError('Executable command must not begin with an option prefix');
  }
  return value;
}

function windowsPathEnvironment(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw resolutionError('Windows executable resolution requires an environment object');
  }
  const matches = Object.entries(env).filter(([key]) => key.toUpperCase() === 'PATH');
  if (matches.length !== 1 || typeof matches[0][1] !== 'string' || matches[0][1].length === 0) {
    throw resolutionError('Windows executable resolution requires exactly one non-empty PATH value');
  }
  return matches[0][1];
}

function unquotePathEntry(value) {
  if (value.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) {
    return value.slice(1, -1);
  }
  if (value.startsWith('"') || value.startsWith("'") || value.endsWith('"') || value.endsWith("'")) {
    return null;
  }
  return value;
}

function windowsExecutableNames(command, pathApi) {
  const extension = pathApi.extname(command).toLowerCase();
  if (extension) {
    if (!WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension)) {
      throw resolutionError('Windows executable commands must use an .exe or .com extension');
    }
    return [command];
  }
  return WINDOWS_EXECUTABLE_EXTENSIONS.map((candidate) => `${command}${candidate}`);
}

function isLocalDriveQualifiedWindowsPath(value, pathApi, { allowRoot = false } = {}) {
  if (!pathApi.isAbsolute(value)) return false;
  const normalized = value.replaceAll('/', '\\');
  const driveRoot = /^[A-Za-z]:\\/u.exec(normalized)?.[0]
    ?? /^\\\\\?\\[A-Za-z]:\\/u.exec(normalized)?.[0];
  return Boolean(driveRoot && (allowRoot || normalized.length > driveRoot.length));
}

export function assertAbsoluteWindowsExecutablePath(command, { pathApi = path.win32 } = {}) {
  const value = commandText(command);
  if (!isLocalDriveQualifiedWindowsPath(value, pathApi)) {
    throw resolutionError('Windows executable commands must resolve to a local drive-qualified path');
  }
  const extension = pathApi.extname(value).toLowerCase();
  if (!WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension)) {
    throw resolutionError('Windows executable paths must use an .exe or .com extension');
  }
  return value;
}

export function windowsExecutableCandidatePaths(command, {
  env = process.env,
  pathApi = path.win32
} = {}) {
  const value = commandText(command);
  if (pathApi.isAbsolute(value)) {
    return Object.freeze([assertAbsoluteWindowsExecutablePath(value, { pathApi })]);
  }
  if (value.includes('\\') || value.includes('/') || value.includes(':')) {
    throw resolutionError('Relative Windows executable paths are not allowed');
  }

  const names = windowsExecutableNames(value, pathApi);
  const candidates = [];
  const seen = new Set();
  for (const rawEntry of windowsPathEnvironment(env).split(';')) {
    if (!rawEntry) continue;
    const entry = unquotePathEntry(rawEntry);
    if (!entry || !isLocalDriveQualifiedWindowsPath(entry, pathApi, { allowRoot: true })) continue;
    for (const name of names) {
      const candidate = pathApi.join(entry, name);
      const identity = candidate.toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      candidates.push(candidate);
    }
  }
  return Object.freeze(candidates);
}

export function windowsPathIsInside(root, candidate, { pathApi = path.win32 } = {}) {
  const comparable = (value) => {
    const normalized = pathApi.normalize(value);
    if (/^\\\\\?\\UNC\\/iu.test(normalized)) {
      return pathApi.resolve(`\\\\${normalized.slice(8)}`).toLowerCase();
    }
    if (/^\\\\\?\\/u.test(normalized)) {
      return pathApi.resolve(normalized.slice(4)).toLowerCase();
    }
    return pathApi.resolve(normalized).toLowerCase();
  };
  const canonicalRoot = comparable(root);
  const canonicalCandidate = comparable(candidate);
  const relative = pathApi.relative(canonicalRoot, canonicalCandidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relative)
  );
}

export async function resolveExternalExecutable(command, {
  platform = process.platform,
  cwd = process.cwd(),
  env = process.env,
  pathApi = path.win32,
  lstatImpl = lstat,
  realpathImpl = realpath
} = {}) {
  if (platform !== 'win32') return command;
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) {
    throw resolutionError('Windows executable resolution requires a non-empty working directory');
  }

  let canonicalCwd;
  try {
    canonicalCwd = await realpathImpl(cwd);
    const cwdDetails = await lstatImpl(canonicalCwd);
    if (!cwdDetails.isDirectory()) {
      throw resolutionError('Windows executable working directory must be a directory');
    }
  } catch (error) {
    if (error instanceof ExecutableResolutionError) throw error;
    throw resolutionError('Windows executable working directory could not be resolved', { cause: error });
  }

  const explicit = pathApi.isAbsolute(commandText(command));
  const candidates = windowsExecutableCandidatePaths(command, { env, pathApi });
  for (const candidate of candidates) {
    try {
      const canonical = await realpathImpl(candidate);
      const details = await lstatImpl(canonical);
      if (!details.isFile()) continue;
      assertAbsoluteWindowsExecutablePath(canonical, { pathApi });
      if (windowsPathIsInside(canonicalCwd, canonical, { pathApi })) {
        if (explicit) {
          throw resolutionError('Explicit Windows executable path must be outside the working directory');
        }
        continue;
      }
      return canonical;
    } catch (error) {
      if (error instanceof ExecutableResolutionError) {
        if (explicit) throw error;
        continue;
      }
      if (explicit) {
        throw resolutionError('Explicit Windows executable path could not be resolved', {
          code: error?.code === 'ENOENT' ? 'ENOENT' : 'EINVAL',
          cause: error
        });
      }
    }
  }

  throw resolutionError('Windows executable was not found in a local drive-qualified PATH directory outside the working directory', {
    code: 'ENOENT'
  });
}
