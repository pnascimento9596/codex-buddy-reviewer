const RUN_SCHEMA_VERSION = '1';

const FAILURE_MESSAGE = Object.freeze({
  binary_missing: 'The configured provider executable is unavailable.',
  auth_unavailable: 'The configured provider authentication is unavailable.',
  deadline_exceeded: 'The provider exceeded its configured deadline.',
  output_limit_exceeded: 'The provider exceeded its configured output limit.',
  isolation_failed: 'The provider isolation preflight failed closed.',
  invalid_transport_envelope: 'The provider returned an invalid transport envelope.',
  invalid_review_json: 'The provider response was not valid review JSON.',
  invalid_review_schema: 'The provider response did not satisfy the review schema.',
  grounding_rejected: 'The provider response failed local evidence grounding.',
  persistence_failed: 'The validated review could not be persisted safely.',
  transport_exit: 'The provider process did not complete successfully.'
});

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function duration(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function byteLength(value) {
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) return null;
  return Buffer.byteLength(value);
}

function metadataLabel(value, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) return null;
  return /^[\x21-\x7e]+$/.test(value) ? value : null;
}

function safeFailureMessage(value, fallback) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240) return fallback;
  return /^[\x20-\x7e]+$/.test(value) ? value : fallback;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(value) {
  if (plainObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('transport response did not contain a JSON object');
  }
  const parsed = JSON.parse(value.trim());
  if (!plainObject(parsed)) throw new Error('transport response must be one JSON object');
  return parsed;
}

function reviewPayloadFromEnvelope(envelope) {
  if (typeof envelope.schema_version === 'string' && typeof envelope.status === 'string') return envelope;
  for (const field of ['structured_output', 'result', 'content', 'text']) {
    if (envelope[field] !== undefined) return parseJsonObject(envelope[field]);
  }
  throw new Error('transport envelope did not contain a structured review result');
}

function normalizeUsage(envelope) {
  if (!plainObject(envelope.usage)) return null;
  const usage = {
    input_tokens: boundedInteger(envelope.usage.input_tokens),
    cached_input_tokens: boundedInteger(envelope.usage.cache_read_input_tokens),
    output_tokens: boundedInteger(envelope.usage.output_tokens),
    reasoning_tokens: boundedInteger(envelope.usage.reasoning_tokens),
    total_tokens: boundedInteger(envelope.usage.total_tokens)
  };
  return Object.values(usage).some((value) => value !== null) ? Object.freeze(usage) : null;
}

function safeUsage(value) {
  if (!plainObject(value)) return null;
  const usage = Object.freeze({
    input_tokens: boundedInteger(value.input_tokens),
    cached_input_tokens: boundedInteger(value.cached_input_tokens),
    output_tokens: boundedInteger(value.output_tokens),
    reasoning_tokens: boundedInteger(value.reasoning_tokens),
    total_tokens: boundedInteger(value.total_tokens)
  });
  return Object.values(usage).some((item) => item !== null) ? usage : null;
}

export class ProviderFailure extends Error {
  constructor({ provider, model, stage, failureCode, durationMs, cause, safeMessage }) {
    const fallback = FAILURE_MESSAGE[failureCode] ?? 'The provider failed closed.';
    super(safeFailureMessage(safeMessage, fallback), cause ? { cause } : undefined);
    this.name = 'ProviderFailure';
    this.provider = metadataLabel(provider, 32);
    this.model = metadataLabel(model, 200);
    this.stage = stage;
    this.failureCode = failureCode;
    this.run = Object.freeze({
      schema_version: RUN_SCHEMA_VERSION,
      ok: false,
      provider: this.provider,
      model: this.model,
      stage,
      failure_code: failureCode,
      duration_ms: duration(durationMs),
      stdout_bytes: null,
      stderr_bytes: null,
      stderr_present: null,
      usage: null,
      usage_complete: null,
      cost_usd_ticks: null
    });
  }
}

export function processFailureCode(error) {
  if (error?.code === 'ENOENT') return 'binary_missing';
  if (error?.kind === 'deadline_exceeded') return 'deadline_exceeded';
  if (error?.kind === 'output_limit') return 'output_limit_exceeded';
  if (new Set([
    'containment_unavailable',
    'helper_unavailable',
    'integrity_mismatch',
    'architecture_mismatch',
    'control_protocol',
    'unsupported_architecture'
  ]).has(error?.kind)) return 'isolation_failed';
  const message = String(error?.message ?? '');
  if (/ exceeded its \d+ ms deadline$/.test(message)) return 'deadline_exceeded';
  if (/^(?:stdout|stderr) exceeded \d+ bytes$/.test(message)) return 'output_limit_exceeded';
  return 'transport_exit';
}

export function providerFailure(options) {
  return new ProviderFailure(options);
}

export function providerResult({
  provider,
  model,
  stdout,
  stderr,
  reviewPayload,
  durationMs,
  usage = null,
  usageComplete = null,
  costUsdTicks = null
}) {
  const safeProvider = metadataLabel(provider, 32);
  const safeModel = metadataLabel(model, 200);
  return {
    provider,
    model,
    stdout,
    stderr,
    reviewPayload,
    run: Object.freeze({
      schema_version: RUN_SCHEMA_VERSION,
      ok: true,
      provider: safeProvider,
      model: safeModel,
      stage: 'complete',
      failure_code: null,
      duration_ms: duration(durationMs),
      stdout_bytes: byteLength(stdout),
      stderr_bytes: byteLength(stderr),
      stderr_present: Boolean(stderr?.trim?.()),
      usage: safeUsage(usage),
      usage_complete: typeof usageComplete === 'boolean' ? usageComplete : null,
      cost_usd_ticks: boundedInteger(costUsdTicks)
    })
  };
}

export function parseGrokTransport(stdout) {
  const envelope = parseJsonObject(stdout);
  if (envelope.type === 'error') throw new Error('Grok returned an error envelope');
  if (envelope.stopReason !== undefined && envelope.stopReason !== 'EndTurn') {
    throw new Error('Grok did not terminate with EndTurn');
  }
  if (envelope.num_turns !== undefined
    && (!Number.isSafeInteger(envelope.num_turns) || envelope.num_turns < 1 || envelope.num_turns > 1)) {
    throw new Error('Grok violated the one-turn reviewer contract');
  }

  const reviewPayload = reviewPayloadFromEnvelope(envelope);
  const usage = normalizeUsage(envelope);
  const usageIncomplete = envelope.usage_is_incomplete === true;
  const costPartial = envelope.cost_is_partial === true;
  const costUsdTicks = usageIncomplete || costPartial
    ? null
    : boundedInteger(envelope.total_cost_usd_ticks);
  return {
    reviewPayload,
    usage,
    usageComplete: usage ? !usageIncomplete : null,
    costUsdTicks
  };
}
