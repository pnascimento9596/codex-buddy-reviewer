import { isProbablyText } from './policy.mjs';

export const MAX_SECRET_SCAN_BYTES = 2 * 1024 * 1024;

const PROVIDER_MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/u;

const HIGH_CONFIDENCE_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/u,
  /\bglpat-[0-9A-Za-z_-]{20,255}\b/u,
  /\bxox[baprs]-[0-9A-Za-z-]{20,255}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bsk-[0-9A-Za-z_-]{20,255}\b/u,
  /\b(?:gsk_|hf_|npm_|pplx-)[0-9A-Za-z_-]{20,255}\b/u,
  /\bxai-[0-9A-Za-z_-]{20,255}\b/u,
  /\beyJ[0-9A-Za-z_-]{5,}\.[0-9A-Za-z_-]{5,}\.[0-9A-Za-z_-]{8,}\b/u
]);

const OPAQUE_MODEL_CREDENTIAL_PATTERN = /^[0-9A-Za-z_-]{32,200}$/u;

const CREDENTIAL_PLACEHOLDER_LABEL = '(?:api[-_.]?key|access[-_.]?token|refresh[-_.]?token|auth[-_.]?token|oauth[-_.]?token|session[-_.]?token|id[-_.]?token|secret(?:[-_.]?(?:key|token))?|secret[-_.]?access[-_.]?key|client[-_.]?secret|password|passwd|private[-_.]?key)';
const CREDENTIAL_ARGUMENT_NAME = `(?:[0-9A-Za-z]+[-_.]+)*${CREDENTIAL_PLACEHOLDER_LABEL}`;
const CREDENTIAL_FIELD_NAME = `[-_.]*${CREDENTIAL_ARGUMENT_NAME}`;
const CREDENTIAL_ASSIGNMENT = '(?:\\s*\\]?\\s*)(?::\\s*[0-9A-Za-z_$.:<>&|?\\[\\], ]{1,80}\\s*=|:=|[:=])\\s*';
const QUOTED_CREDENTIAL_VALUE = String.raw`(["'\x60])((?:\\[\s\S]|(?!\1)[^\\\r\n]){1,512})\1`;
const QUOTED_CONTEXTUAL_SECRET = new RegExp(
  `(?:^|[^0-9A-Za-z_.-])["'\\x60]?${CREDENTIAL_FIELD_NAME}["'\\x60]?${CREDENTIAL_ASSIGNMENT}${QUOTED_CREDENTIAL_VALUE}`,
  'gimu'
);
const UNQUOTED_CONTEXTUAL_SECRET = new RegExp(
  `(?:^|[^0-9A-Za-z_.-])["']?${CREDENTIAL_FIELD_NAME}["']?${CREDENTIAL_ASSIGNMENT}([^\\s"'\\x60,;}{\\]\\[]{1,512})`,
  'gimu'
);
const QUOTED_COMMAND_CREDENTIAL = new RegExp(
  `(?:^|\\s)(?:--?${CREDENTIAL_ARGUMENT_NAME}|setx\\s+${CREDENTIAL_ARGUMENT_NAME})\\s*(?:=\\s*)?${QUOTED_CREDENTIAL_VALUE}`,
  'gimu'
);
const UNQUOTED_COMMAND_CREDENTIAL = new RegExp(
  `(?:^|\\s)(?:--?${CREDENTIAL_ARGUMENT_NAME}|setx\\s+${CREDENTIAL_ARGUMENT_NAME})\\s*(?:=\\s*)?([^\\s"'\\x60,;}{\\]\\[]{1,512})`,
  'gimu'
);
const AUTHORIZATION_CREDENTIAL = /(?:^|[^0-9A-Za-z_.-])["'\x60]?[-_.]*(?:[0-9A-Za-z]+[-_.]+)*(?:proxy[-_.]+)?authorization["'\x60]?\s*\]?\s*[:=]\s*["'\x60]?(bearer|basic|token|api[-_.]?key)\s+["'\x60]?([^\s"'\x60,;}{\]\[]{8,2048})/gimu;
const CONNECTION_CREDENTIAL = /\b[a-z][a-z0-9+.-]{1,31}:\/\/([^\s/:@]*):([^\s/@]{1,512})@[^\s/]+/giu;
const CLOSED_AUTHORIZATION_CREDENTIALS = new Set([
  // Public RFC-style documentation sample for "Aladdin:open sesame".
  'QWxhZGRpbjpvcGVuIHNlc2FtZQ=='
]);
const CLOSED_PLACEHOLDER_PATTERNS = Object.freeze([
  /^(?:x{20,}|0{20,})$/iu,
  new RegExp(`^replace[-_.]me[-_.]with[-_.](?:your[-_.])?${CREDENTIAL_PLACEHOLDER_LABEL}$`, 'iu'),
  new RegExp(
    `^(?:example|placeholder|dummy|sample|fake|not[-_.]?real)[-_.](?:[0-9A-Za-z]+[-_.]+)*${CREDENTIAL_PLACEHOLDER_LABEL}`
      + '(?:[-_.]for[-_.]local[-_.]fixture)?$',
    'iu'
  ),
  new RegExp(
    `^test[-_.]${CREDENTIAL_PLACEHOLDER_LABEL}[-_.]for[-_.]local[-_.]fixture$`,
    'iu'
  ),
  /^(?:example|placeholder|dummy|sample|fake|not[-_.]?real)[-_.](?:value|credential)(?:[-_.]for[-_.]local[-_.]fixture)?$/iu,
  new RegExp(`^your[-_.]?${CREDENTIAL_PLACEHOLDER_LABEL}$`, 'iu'),
  /^base64[-_.]?credentials?$/iu,
  /^(?:selected|provided|configured)[ ]by[ ](?:the[ ])?(?:user|operator)$/iu
]);

function isClosedPlaceholder(value) {
  return CLOSED_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function characterClasses(value) {
  return [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^0-9A-Za-z]/u]
    .reduce((count, pattern) => count + Number(pattern.test(value)), 0);
}

function isCredentialCandidate(value, minimumEntropy = 3.5) {
  const candidate = value.trim();
  return candidate.length >= 12
    && !isClosedPlaceholder(candidate)
    && characterClasses(candidate) >= 2
    && entropy(candidate) >= minimumEntropy;
}

function isClosedCredentialReference(value) {
  const candidate = value.trim();
  return /^[A-Za-z_$][A-Za-z_$]*$/u.test(candidate)
    || /^\$\{?[A-Za-z_][0-9A-Za-z_]*\}?$/u.test(candidate)
    || /^[a-z_$][A-Za-z_$]*(?:\([^\r\n]{0,128}\))?(?:\??\.[A-Za-z_$][0-9A-Za-z_$]*(?:\([^\r\n]{0,128}\))?)+$/u.test(candidate)
    || /^[a-z_$][A-Za-z_$]*\([^\r\n]{0,256}\)$/u.test(candidate);
}

function isEnvironmentReference(value) {
  return /^\$\{?[A-Za-z_][0-9A-Za-z_]*\}?$/u.test(value.trim());
}

function isClosedAuthorizationCredential(value) {
  return isClosedPlaceholder(value)
    || isEnvironmentReference(value)
    || CLOSED_AUTHORIZATION_CREDENTIALS.has(value);
}

function isClosedConnectionPassword(value) {
  return isClosedPlaceholder(value)
    || isEnvironmentReference(value)
    || /^<(?:password|passwd|secret|token|credential)>$/iu.test(value)
    || /^(?:pass(?:word)?|secret|token|changeme|change-me|example|placeholder|dummy|sample|fake|not-real)$/iu.test(value);
}

function scanConnectionCredentials(text) {
  CONNECTION_CREDENTIAL.lastIndex = 0;
  for (const match of text.matchAll(CONNECTION_CREDENTIAL)) {
    let password;
    try {
      password = decodeURIComponent(match[2]);
    } catch {
      return { complete: false, detected: false };
    }
    if (!isClosedConnectionPassword(password)) return { complete: true, detected: true };
  }
  return { complete: true, detected: false };
}

export function scanSecretMaterial(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('secret scan input must be a Buffer');
  if (bytes.length > MAX_SECRET_SCAN_BYTES) {
    return Object.freeze({ complete: false, detected: false });
  }
  if (!isProbablyText(bytes)) return Object.freeze({ complete: true, detected: false });
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    return Object.freeze({ complete: false, detected: false });
  }
  if (HIGH_CONFIDENCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return Object.freeze({ complete: true, detected: true });
  }
  AUTHORIZATION_CREDENTIAL.lastIndex = 0;
  for (const match of text.matchAll(AUTHORIZATION_CREDENTIAL)) {
    if (!isClosedAuthorizationCredential(match[2])) {
      return Object.freeze({ complete: true, detected: true });
    }
  }
  QUOTED_CONTEXTUAL_SECRET.lastIndex = 0;
  for (const match of text.matchAll(QUOTED_CONTEXTUAL_SECRET)) {
    const candidate = match[2];
    if (!isEnvironmentReference(candidate) && isCredentialCandidate(candidate, 3.0)) {
      return Object.freeze({ complete: true, detected: true });
    }
  }
  UNQUOTED_CONTEXTUAL_SECRET.lastIndex = 0;
  for (const match of text.matchAll(UNQUOTED_CONTEXTUAL_SECRET)) {
    const candidate = match[1];
    if (!isClosedCredentialReference(candidate) && isCredentialCandidate(candidate)) {
      return Object.freeze({ complete: true, detected: true });
    }
  }
  QUOTED_COMMAND_CREDENTIAL.lastIndex = 0;
  for (const match of text.matchAll(QUOTED_COMMAND_CREDENTIAL)) {
    if (!isEnvironmentReference(match[2]) && isCredentialCandidate(match[2], 3.0)) {
      return Object.freeze({ complete: true, detected: true });
    }
  }
  UNQUOTED_COMMAND_CREDENTIAL.lastIndex = 0;
  for (const match of text.matchAll(UNQUOTED_COMMAND_CREDENTIAL)) {
    if (!isClosedCredentialReference(match[1]) && isCredentialCandidate(match[1])) {
      return Object.freeze({ complete: true, detected: true });
    }
  }
  const connection = scanConnectionCredentials(text);
  if (!connection.complete || connection.detected) return Object.freeze(connection);
  return Object.freeze({ complete: true, detected: false });
}

export function assessProviderModelIdentifier(value) {
  if (typeof value !== 'string' || !PROVIDER_MODEL_IDENTIFIER_PATTERN.test(value)) {
    return Object.freeze({ allowed: false, reason: 'invalid_format' });
  }
  const scan = scanSecretMaterial(Buffer.from(value, 'utf8'));
  if (!scan.complete) return Object.freeze({ allowed: false, reason: 'scan_incomplete' });
  if (scan.detected) return Object.freeze({ allowed: false, reason: 'credential_material' });
  if (OPAQUE_MODEL_CREDENTIAL_PATTERN.test(value)
      && characterClasses(value) >= 3 && entropy(value) >= 4.75) {
    return Object.freeze({ allowed: false, reason: 'credential_material' });
  }
  return Object.freeze({ allowed: true, reason: null });
}
