import { createHash } from 'node:crypto';
import path from 'node:path';

import { assessProviderModelIdentifier, scanSecretMaterial } from './secret-scan.mjs';
import { hasUnsafeTerminalControls } from './policy.mjs';
import { canonicalJson } from './state.mjs';

export const PROVIDER_CONTENT_POLICY_VERSION = '1';

const PURPOSES = new Set(['technical_review', 'health_check']);
const PROVIDERS = new Set(['claude', 'grok', 'ollama', 'opencode']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_SCHEMA_BYTES = 512 * 1024;
const MAX_SUMMARY_PACKET_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;
const SUMMARY_PACKET_KEYS = Object.freeze([
  'schema_version',
  'purpose',
  'policy_version',
  'consent_revision',
  'review_key',
  'offset_unit',
  'summary',
  'summary_sha256',
  'summary_truncated'
]);

function fail(message) {
  throw new Error(`Buddy provider request approval: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain data object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) fail(`${label} contains symbol fields`);
  if (keys.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    fail(`${label} contains accessors or hidden fields`);
  }
  const actual = [...keys].sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function cloneJson(value, label, depth = 0) {
  if (depth > MAX_JSON_DEPTH) fail(`${label} exceeds the maximum JSON depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
    if (keys.some((key) => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key))
        || keys.length !== value.length) {
      fail(`${label} contains a sparse array or unsupported array fields`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const clone = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail(`${label} contains unsupported array accessors`);
      }
      clone.push(cloneJson(descriptor.value, label, depth + 1));
    }
    return Object.freeze(clone);
  }
  if (!value || typeof value !== 'object') fail(`${label} contains non-JSON data`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} contains a non-plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) fail(`${label} contains symbol fields`);
  const clone = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(`${label} contains accessors or hidden fields`);
    }
    Object.defineProperty(clone, key, {
      value: cloneJson(descriptor.value, label, depth + 1),
      enumerable: true,
      writable: false,
      configurable: false
    });
  }
  return Object.freeze(clone);
}

function immutableJson(value, label, maximumBytes) {
  const clone = cloneJson(value, label);
  const serialized = canonicalJson(clone);
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) fail(`${label} exceeds its byte limit`);
  return Object.freeze({ clone, serialized, sha256: sha256(serialized) });
}

function scanProviderBoundText(text, label) {
  if (hasUnsafeTerminalControls(text)) fail(`${label} contains unsafe control characters`);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.toString('utf8') !== text) fail(`${label} is not lossless UTF-8 text`);
  const scan = scanSecretMaterial(bytes);
  if (!scan.complete) fail(`${label} credential scan is incomplete`);
  if (scan.detected) fail(`${label} contains credential material`);
}

function channelInventory(purpose, summaryGuardPacket) {
  if (purpose === 'health_check') return Object.freeze(['static_health_prompt']);
  return summaryGuardPacket === null
    ? Object.freeze(['technical_evidence'])
    : Object.freeze(['technical_evidence', 'worker_summary']);
}

function buildState(candidate, options = {}) {
  exactKeys(candidate, [
    'purpose',
    'root',
    'provider',
    'prompt',
    'model',
    'effort',
    'timeoutMs',
    'responseSchema',
    'summaryGuardPacket'
  ], 'provider request candidate');
  if (!PURPOSES.has(candidate.purpose)) fail('request purpose is unsupported');
  if (typeof candidate.root !== 'string' || !path.isAbsolute(candidate.root)) {
    fail('workspace root must be an absolute path');
  }
  if (!PROVIDERS.has(candidate.provider)) fail('provider is unsupported');
  if (typeof candidate.prompt !== 'string' || !candidate.prompt) fail('prompt must be non-empty text');
  const promptBytes = Buffer.byteLength(candidate.prompt, 'utf8');
  if (promptBytes > MAX_PROMPT_BYTES) fail('prompt exceeds its byte limit');
  const modelAssessment = assessProviderModelIdentifier(candidate.model);
  if (!modelAssessment.allowed) {
    fail(modelAssessment.reason === 'credential_material'
      ? 'model contains credential material'
      : 'model is invalid');
  }
  if (!EFFORTS.has(candidate.effort)) fail('effort is invalid');
  if (!Number.isSafeInteger(candidate.timeoutMs)
      || candidate.timeoutMs < 1_000 || candidate.timeoutMs > 480_000) {
    fail('timeout is invalid');
  }
  if (candidate.responseSchema !== undefined
      && (!candidate.responseSchema || typeof candidate.responseSchema !== 'object'
        || Array.isArray(candidate.responseSchema))) {
    fail('response schema must be an object or undefined');
  }
  if (candidate.summaryGuardPacket !== null
      && (!candidate.summaryGuardPacket || typeof candidate.summaryGuardPacket !== 'object'
        || Array.isArray(candidate.summaryGuardPacket))) {
    fail('summary packet must be an object or null');
  }
  if (candidate.purpose === 'health_check' && candidate.summaryGuardPacket !== null) {
    fail('health-check requests cannot include a worker summary');
  }

  const responseSchema = candidate.responseSchema === undefined
    ? Object.freeze({ clone: undefined, serialized: canonicalJson(null), sha256: sha256(canonicalJson(null)) })
    : immutableJson(candidate.responseSchema, 'response schema', MAX_RESPONSE_SCHEMA_BYTES);
  const summaryPacket = candidate.summaryGuardPacket === null
    ? Object.freeze({ clone: null, serialized: null, sha256: null })
    : immutableJson(candidate.summaryGuardPacket, 'summary packet', MAX_SUMMARY_PACKET_BYTES);
  if (summaryPacket.clone !== null) {
    exactKeys(summaryPacket.clone, SUMMARY_PACKET_KEYS, 'summary packet');
    if (summaryPacket.clone.schema_version !== '1'
        || summaryPacket.clone.purpose !== 'worker_summary_claim_advisory'
        || summaryPacket.clone.policy_version !== '1'
        || !Number.isSafeInteger(summaryPacket.clone.consent_revision)
        || summaryPacket.clone.consent_revision < 1
        || (summaryPacket.clone.review_key !== null
          && (typeof summaryPacket.clone.review_key !== 'string'
            || !SHA256_PATTERN.test(summaryPacket.clone.review_key)))
        || summaryPacket.clone.offset_unit !== 'utf16_code_unit'
        || typeof summaryPacket.clone.summary !== 'string'
        || !summaryPacket.clone.summary
        || typeof summaryPacket.clone.summary_sha256 !== 'string'
        || !SHA256_PATTERN.test(summaryPacket.clone.summary_sha256)
        || summaryPacket.clone.summary_sha256 !== sha256(summaryPacket.clone.summary)
        || typeof summaryPacket.clone.summary_truncated !== 'boolean') {
      fail('summary packet does not expose valid consent and summary bindings');
    }
  }

  if (options.scan !== false) {
    scanProviderBoundText(candidate.prompt, 'prompt');
    scanProviderBoundText(responseSchema.serialized, 'response schema');
    if (summaryPacket.serialized !== null) scanProviderBoundText(summaryPacket.serialized, 'summary packet');
  }

  const root = path.resolve(candidate.root);
  const channels = channelInventory(candidate.purpose, summaryPacket.clone);
  const channelInventorySha256 = sha256(canonicalJson(channels));
  const binding = Object.freeze({
    policy_version: PROVIDER_CONTENT_POLICY_VERSION,
    purpose: candidate.purpose,
    root_sha256: sha256(root),
    provider: candidate.provider,
    model: candidate.model,
    effort: candidate.effort,
    timeout_ms: candidate.timeoutMs,
    prompt_sha256: sha256(candidate.prompt),
    prompt_bytes: promptBytes,
    response_schema_sha256: responseSchema.sha256,
    summary_packet_sha256: summaryPacket.sha256,
    channel_inventory_sha256: channelInventorySha256
  });
  const approvalSha256 = sha256(canonicalJson(binding));
  const request = Object.freeze({
    purpose: candidate.purpose,
    root,
    provider: candidate.provider,
    prompt: candidate.prompt,
    model: candidate.model,
    effort: candidate.effort,
    timeoutMs: candidate.timeoutMs,
    responseSchema: responseSchema.clone,
    summaryGuardPacket: summaryPacket.clone
  });
  const metadata = Object.freeze({
    policyVersion: PROVIDER_CONTENT_POLICY_VERSION,
    purpose: candidate.purpose,
    rootSha256: binding.root_sha256,
    provider: candidate.provider,
    model: candidate.model,
    effort: candidate.effort,
    timeoutMs: candidate.timeoutMs,
    promptSha256: binding.prompt_sha256,
    promptBytes,
    responseSchemaSha256: responseSchema.sha256,
    summaryConsentRevision: summaryPacket.clone?.consent_revision ?? null,
    summaryReviewKey: summaryPacket.clone?.review_key ?? null,
    summarySha256: summaryPacket.clone?.summary_sha256 ?? null,
    summaryPacketSha256: summaryPacket.sha256,
    channelInventory: channels,
    channelInventorySha256,
    approvalSha256
  });
  return Object.freeze({ request, metadata });
}

function stateMatchesMetadata(state) {
  const rebuilt = buildState(state.request, { scan: false });
  return canonicalJson(rebuilt.metadata) === canonicalJson(state.metadata);
}

export function createApprovedProviderRequestAuthority() {
  const privateRequests = new WeakMap();

  function stateFor(handle) {
    const state = privateRequests.get(handle);
    if (!state) fail('request is not an approved local handle');
    if (state.metadata.policyVersion !== PROVIDER_CONTENT_POLICY_VERSION || !stateMatchesMetadata(state)) {
      fail('request approval binding is invalid or stale');
    }
    return state;
  }

  return Object.freeze({
    approve(candidate) {
      const state = buildState(candidate);
      const handle = Object.freeze(Object.create(null));
      privateRequests.set(handle, state);
      return handle;
    },
    inspect(handle) {
      return stateFor(handle).metadata;
    },
    unwrap(handle) {
      return stateFor(handle).request;
    }
  });
}
