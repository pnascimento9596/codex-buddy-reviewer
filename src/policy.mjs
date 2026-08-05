import path from 'node:path';

const DENY_SEGMENTS = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.azure',
  '.secrets',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage'
]);

const DENY_BASENAME_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^(?:credentials?|secrets?)(?:\..+)?$/i,
  /^(?:service[-_]?account|application[-_]?default[-_]?credentials)(?:[-_.].+)?\.json$/i,
  /\.tfstate(?:\.backup)?$/i,
  /(?:^|[-_.])private[-_.]?key(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i
];

export const SENSITIVE_IGNORED_PATHSPECS = [
  ':(icase,glob)**/.env', ':(icase,glob)**/.env/**',
  ':(icase,glob)**/.env.*', ':(icase,glob)**/.env.*/**', ':(icase,glob)**/.npmrc',
  ':(icase,glob)**/.pypirc', ':(icase,glob)**/.netrc',
  ':(icase,glob)**/credential', ':(icase,glob)**/credential.*',
  ':(icase,glob)**/credential/**',
  ':(icase,glob)**/credentials', ':(icase,glob)**/credentials.*',
  ':(icase,glob)**/credentials/**',
  ':(icase,glob)**/secret', ':(icase,glob)**/secret.*',
  ':(icase,glob)**/secret/**',
  ':(icase,glob)**/secrets', ':(icase,glob)**/secrets.*',
  ':(icase,glob)**/secrets/**',
  ':(icase,glob)**/service-account*.json', ':(icase,glob)**/service_account*.json',
  ':(icase,glob)**/serviceaccount*.json',
  ':(icase,glob)**/application-default-credentials*.json',
  ':(icase,glob)**/application_default_credentials*.json',
  ':(icase,glob)**/applicationdefaultcredentials*.json',
  ':(icase,glob)**/*.tfstate', ':(icase,glob)**/*.tfstate.backup',
  ':(icase,glob)**/*private-key*', ':(icase,glob)**/*private_key*',
  ':(icase,glob)**/*privatekey*',
  ':(icase,glob)**/*.pem', ':(icase,glob)**/*.key', ':(icase,glob)**/*.p12',
  ':(icase,glob)**/*.pfx', ':(icase,glob)**/*.jks', ':(icase,glob)**/*.keystore',
  ':(icase,glob)**/id_rsa', ':(icase,glob)**/id_rsa.pub',
  ':(icase,glob)**/id_dsa', ':(icase,glob)**/id_dsa.pub',
  ':(icase,glob)**/id_ecdsa', ':(icase,glob)**/id_ecdsa.pub',
  ':(icase,glob)**/id_ed25519', ':(icase,glob)**/id_ed25519.pub',
  ':(icase,glob)**/.ssh', ':(icase,glob)**/.ssh/**',
  ':(icase,glob)**/.aws', ':(icase,glob)**/.aws/**',
  ':(icase,glob)**/.gnupg', ':(icase,glob)**/.gnupg/**',
  ':(icase,glob)**/.kube', ':(icase,glob)**/.kube/**',
  ':(icase,glob)**/.azure', ':(icase,glob)**/.azure/**',
  ':(icase,glob)**/.secrets', ':(icase,glob)**/.secrets/**'
];

export function normalizeRepoPath(value) {
  const platformNormalized = process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
  return platformNormalized.replace(/^\.\//, '');
}

export function pathPolicy(repoPath) {
  const normalized = normalizeRepoPath(repoPath);
  const parts = normalized.split('/').filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const basename = path.posix.basename(normalized);

  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:[\\/]/.test(normalized) || parts.includes('..')) {
    return { allowed: false, reason: 'path escapes repository' };
  }
  if (/[\u0000-\u001F\u007F-\u009F\u2028-\u202E\u2066-\u2069]/u.test(normalized)) {
    return { allowed: false, reason: 'unsafe filename' };
  }
  if (lowerParts.some((part) => DENY_SEGMENTS.has(part) || /^\.env(?:\..+)?$/i.test(part))) {
    return { allowed: false, reason: 'denied directory' };
  }
  if (DENY_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))) {
    return { allowed: false, reason: 'potential secret material' };
  }
  return { allowed: true, reason: null };
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return false;
  let controls = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return sample.length === 0 || controls / sample.length < 0.02;
}

const UNSAFE_TERMINAL_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028-\u202E\u2066-\u2069]/u;
const UNSAFE_TERMINAL_CONTROLS_GLOBAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028-\u202E\u2066-\u2069]/gu;

export function hasUnsafeTerminalControls(value) {
  return UNSAFE_TERMINAL_CONTROLS.test(value);
}

export function escapeTerminalControls(value) {
  return String(value).replace(
    UNSAFE_TERMINAL_CONTROLS_GLOBAL,
    (character) => `\\u{${character.codePointAt(0).toString(16).padStart(4, '0')}}`
  );
}

export function escapeDiagnosticLine(value, maximum = 2_000) {
  const safe = escapeTerminalControls(value)
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t');
  return safe.length <= maximum ? safe : `${safe.slice(0, Math.max(0, maximum - 1))}…`;
}
