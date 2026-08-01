import { reviewWithClaude } from './providers/claude.mjs';
import { reviewWithGrok } from './providers/grok.mjs';
import { reviewWithOllama } from './providers/ollama.mjs';
import { reviewWithOpenCode } from './providers/opencode.mjs';
import { createApprovedProviderRequestAuthority } from './approved-provider-request.mjs';
import { assertProviderEgressPlatformAllowed } from './provider-egress-platform.mjs';
import { assessProviderModelIdentifier } from './secret-scan.mjs';

const PROVIDER_IDS = Object.freeze(['claude', 'grok', 'ollama', 'opencode']);
const EXTENDED_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const OLLAMA_EFFORTS = Object.freeze(['low', 'medium', 'high']);
const APPROVAL_AUTHORITY = createApprovedProviderRequestAuthority();

const DEFINITIONS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    defaultModel: 'claude-opus-4-8',
    defaultEffort: 'high',
    supportedEfforts: EXTENDED_EFFORTS
  }),
  grok: Object.freeze({
    id: 'grok',
    defaultModel: 'grok-4.5',
    defaultEffort: 'high',
    supportedEfforts: EXTENDED_EFFORTS
  }),
  ollama: Object.freeze({
    id: 'ollama',
    defaultModel: 'glm-5.2:cloud',
    defaultEffort: 'high',
    supportedEfforts: OLLAMA_EFFORTS
  }),
  opencode: Object.freeze({
    id: 'opencode',
    defaultModel: 'openai/gpt-5.6',
    defaultEffort: 'high',
    supportedEfforts: EXTENDED_EFFORTS
  })
});

function providerEntry(provider) {
  switch (provider) {
    case 'claude':
      return { definition: DEFINITIONS.claude, review: reviewWithClaude };
    case 'grok':
      return { definition: DEFINITIONS.grok, review: reviewWithGrok };
    case 'ollama':
      return { definition: DEFINITIONS.ollama, review: reviewWithOllama };
    case 'opencode':
      return { definition: DEFINITIONS.opencode, review: reviewWithOpenCode };
    default:
      throw new RangeError('Unsupported review provider');
  }
}

function normalizeOptions(definition, options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Provider review options must be an object');
  }
  const effort = options.effort ?? definition.defaultEffort;
  validateProviderEffort(definition.id, effort);
  const model = options.model ?? definition.defaultModel;
  if (!assessProviderModelIdentifier(model).allowed) {
    throw new TypeError('Provider review model is invalid or contains credential material');
  }
  return {
    root: options.root,
    prompt: options.prompt,
    model,
    effort,
    timeoutMs: options.timeoutMs,
    responseSchema: options.responseSchema
  };
}

export function supportedProviderIds() {
  return PROVIDER_IDS;
}

export function getProviderDefinition(provider) {
  return providerEntry(provider).definition;
}

export function validateProviderEffort(provider, effort) {
  const definition = providerEntry(provider).definition;
  if (typeof effort !== 'string' || !definition.supportedEfforts.includes(effort)) {
    throw new RangeError(
      `${provider} review effort must be one of: ${definition.supportedEfforts.join(', ')}`
    );
  }
  return effort;
}

export function approveProviderReviewRequest(provider, options, approval = {}) {
  const entry = providerEntry(provider);
  if (options && typeof options === 'object' && Object.hasOwn(options, 'signal')) {
    throw new TypeError('Provider cancellation signal is dispatch-only and cannot be approved');
  }
  const normalized = normalizeOptions(entry.definition, options);
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
    throw new TypeError('Provider request approval options must be an object');
  }
  const approvalKeys = Object.keys(approval);
  if (approvalKeys.some((key) => !['purpose', 'summaryGuardPacket'].includes(key))) {
    throw new TypeError('Provider request approval options contain unsupported fields');
  }
  const purpose = approval.purpose ?? 'technical_review';
  const summaryGuardPacket = approval.summaryGuardPacket ?? null;
  return APPROVAL_AUTHORITY.approve({
    purpose,
    ...normalized,
    provider,
    summaryGuardPacket
  });
}

export function inspectApprovedProviderReviewRequest(approvedRequest) {
  return APPROVAL_AUTHORITY.inspect(approvedRequest);
}

export function dispatchProviderReview(approvedRequest, options = {}) {
  const approved = APPROVAL_AUTHORITY.unwrap(approvedRequest);
  assertProviderEgressPlatformAllowed(options.platform ?? process.platform);
  const entry = providerEntry(approved.provider);
  const normalized = normalizeOptions(entry.definition, approved);
  if (approved.provider === 'ollama') {
    const { effort, ...ollamaOptions } = normalized;
    return entry.review({ ...ollamaOptions, think: effort, signal: options.signal });
  }
  return entry.review({ ...normalized, signal: options.signal });
}
