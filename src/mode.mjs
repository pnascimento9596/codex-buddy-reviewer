import path from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  drainEgressCapabilities,
  snapshotActiveEgressCapabilities
} from './egress-capability.mjs';
import { runProcess } from './process.mjs';
import {
  ensurePrivateStatePath,
  readPrivateJson,
  resolveDataDir,
  withFileLock,
  workspaceKey,
  writePrivateJsonAtomic
} from './state.mjs';
import {
  getProviderDefinition,
  supportedProviderIds,
  validateProviderEffort
} from './provider-registry.mjs';
import { assessProviderModelIdentifier } from './secret-scan.mjs';

const MODE_SCHEMA_VERSION = '1';
export const MODE_POLICY_VERSION = '2';
const VALID_ACTIONS = new Set(['enable', 'disable', 'toggle', 'status']);
const VALID_PROVIDERS = new Set(supportedProviderIds());
const MODE_LOCK_TIMEOUT_MS = 30_000;
const MODE_DRAIN_TIMEOUT_MS = 570_000;

export function providerDefaultModel(provider) {
  if (!VALID_PROVIDERS.has(provider)) throw new Error('Invalid Buddy mode provider');
  return getProviderDefinition(provider).defaultModel;
}

export function providerDefaultEffort(provider) {
  if (!VALID_PROVIDERS.has(provider)) throw new Error('Invalid Buddy mode provider');
  return getProviderDefinition(provider).defaultEffort;
}

function validateReviewerDescriptor(configuration, label = 'Buddy mode') {
  if (!VALID_PROVIDERS.has(configuration.provider)) throw new Error(`Invalid ${label} provider`);
  if (!assessProviderModelIdentifier(configuration.model).allowed) {
    throw new Error(`Invalid ${label} model`);
  }
  try {
    validateProviderEffort(configuration.provider, configuration.effort);
  } catch {
    throw new Error(label === 'Buddy mode'
      ? `Invalid Buddy reasoning effort for ${configuration.provider}`
      : `Invalid ${label} reasoning effort for ${configuration.provider}`);
  }
  return configuration;
}

export function validateReviewerConfiguration(configuration, options = {}) {
  const maximumTimeout = options.allowLegacyTimeout ? 540_000 : 480_000;
  validateReviewerDescriptor(configuration);
  if (!Number.isFinite(configuration.min_confidence)
      || configuration.min_confidence < 0 || configuration.min_confidence > 1) {
    throw new Error('Invalid Buddy confidence threshold');
  }
  if (!Number.isInteger(configuration.max_patch_bytes) || configuration.max_patch_bytes < 4096) {
    throw new Error('Invalid Buddy patch budget');
  }
  if (!Number.isFinite(configuration.timeout_ms)
      || configuration.timeout_ms < 1_000 || configuration.timeout_ms > maximumTimeout) {
    throw new Error('Invalid Buddy timeout');
  }
  return configuration;
}

function defaultMode(root) {
  return {
    schema_version: MODE_SCHEMA_VERSION,
    policy_version: MODE_POLICY_VERSION,
    config_revision: 0,
    workspace_root: root,
    enabled: false,
    scope: 'workspace',
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    effort: 'high',
    secondary_provider: null,
    secondary_model: null,
    secondary_effort: null,
    min_confidence: 0.75,
    max_patch_bytes: 256 * 1024,
    timeout_ms: 480_000,
    consented_at: null,
    updated_at: null
  };
}

function normalizeAndValidateSecondaryReviewer(mode) {
  const fields = [mode.secondary_provider, mode.secondary_model, mode.secondary_effort];
  const legacyMissing = fields.every((value) => value === undefined);
  const normalized = legacyMissing
    ? { ...mode, secondary_provider: null, secondary_model: null, secondary_effort: null }
    : mode;
  const normalizedFields = [
    normalized.secondary_provider,
    normalized.secondary_model,
    normalized.secondary_effort
  ];
  if (normalizedFields.every((value) => value === null)) return normalized;
  if (normalizedFields.some((value) => value === null || value === undefined)) {
    throw new Error('Invalid Buddy secondary reviewer configuration');
  }
  validateReviewerDescriptor({
    provider: normalized.secondary_provider,
    model: normalized.secondary_model,
    effort: normalized.secondary_effort
  }, 'Buddy secondary reviewer');
  if (normalized.provider === normalized.secondary_provider && normalized.model === normalized.secondary_model) {
    throw new Error('Buddy reviewers must use distinct provider/model connections');
  }
  return normalized;
}

export function reviewersForMode(mode) {
  validateReviewerDescriptor(mode);
  const normalized = normalizeAndValidateSecondaryReviewer(mode);
  const reviewers = [Object.freeze({
    provider: normalized.provider,
    model: normalized.model,
    effort: normalized.effort
  })];
  if (normalized.secondary_provider !== null) {
    reviewers.push(Object.freeze({
      provider: normalized.secondary_provider,
      model: normalized.secondary_model,
      effort: normalized.secondary_effort
    }));
  }
  return Object.freeze(reviewers);
}

function validateMode(mode, root, options = {}) {
  if (!mode || typeof mode !== 'object' || Array.isArray(mode)) throw new Error('Buddy mode state must be an object');
  if (mode.schema_version !== MODE_SCHEMA_VERSION) throw new Error('Unsupported Buddy mode state version');
  if (mode.policy_version !== MODE_POLICY_VERSION) throw new Error('Unsupported Buddy mode policy version');
  if (!Number.isInteger(mode.config_revision) || mode.config_revision < 0) throw new Error('Invalid Buddy mode revision');
  if (mode.workspace_root !== root) throw new Error('Buddy mode state belongs to another workspace');
  if (typeof mode.enabled !== 'boolean' || mode.scope !== 'workspace') throw new Error('Invalid Buddy mode state');
  validateReviewerConfiguration(mode, options);
  const normalized = normalizeAndValidateSecondaryReviewer(mode);
  if (normalized.pet_id !== undefined
    && (typeof normalized.pet_id !== 'string' || !/^(?:native:selected|[a-z0-9][a-z0-9_-]{0,63})$/.test(normalized.pet_id))) {
    throw new Error('Invalid Buddy pet identifier');
  }
  if (normalized.consented_at !== null && typeof normalized.consented_at !== 'string') {
    throw new Error('Invalid Buddy consent timestamp');
  }
  return normalized;
}

export async function resolveRepositoryRoot(cwd = process.cwd()) {
  const result = await runProcess('git', ['rev-parse', '--show-toplevel'], { cwd, timeoutMs: 30_000 });
  return realpath(result.stdout.trim());
}

export function modeFile(root, dataDir) {
  return path.join(resolveDataDir(dataDir), 'mode', `${workspaceKey(root)}.json`);
}

async function ensureModeDirectory(dataDir) {
  const dataRoot = resolveDataDir(dataDir);
  await ensurePrivateStatePath(dataRoot, path.join(dataRoot, 'mode'));
}

export async function readMode({ root, dataDir }) {
  await ensureModeDirectory(dataDir);
  const stored = await readPrivateJson(modeFile(root, dataDir));
  const validated = validateMode(stored ?? defaultMode(root), root, { allowLegacyTimeout: true });
  return validated.timeout_ms > 480_000 ? { ...validated, timeout_ms: 480_000 } : validated;
}

export async function withModeLock({ root, dataDir }, callback) {
  await ensureModeDirectory(dataDir);
  const file = modeFile(root, dataDir);
  return withFileLock(
    file,
    async () => callback(await readMode({ root, dataDir })),
    { timeoutMs: MODE_LOCK_TIMEOUT_MS, staleMs: MODE_LOCK_TIMEOUT_MS }
  );
}

export async function changeMode({ root, action = 'toggle', dataDir, ...overrides }) {
  if (!VALID_ACTIONS.has(action)) throw new Error(`Unknown Buddy mode action: ${action}`);
  const file = modeFile(root, dataDir);
  if (action === 'status') return readMode({ root, dataDir });
  await ensureModeDirectory(dataDir);

  const mutation = await withFileLock(file, async () => {
    const current = await readMode({ root, dataDir });
    if (overrides.expectedRevision !== undefined) {
      if (!Number.isInteger(overrides.expectedRevision) || overrides.expectedRevision < 0) {
        throw new Error('Buddy mode expected revision must be a non-negative integer');
      }
      if (current.config_revision !== overrides.expectedRevision) {
        throw new Error(
          `Buddy mode revision changed: expected ${overrides.expectedRevision}, found ${current.config_revision}`
        );
      }
    }
    const { pet_id: _legacyPetId, ...currentReviewMode } = current;
    const provider = overrides.provider ?? current.provider;
    const providerChanged = overrides.provider && overrides.provider !== current.provider;
    const secondaryOverrides = [
      overrides.secondaryProvider,
      overrides.secondaryModel,
      overrides.secondaryEffort
    ];
    if (secondaryOverrides.some((value) => value === null)) {
      throw new Error('Use singleReviewer to clear the secondary reviewer connection');
    }
    if (overrides.singleReviewer === true
      && secondaryOverrides.some((value) => value !== undefined)) {
      throw new Error('Cannot configure and clear the secondary reviewer in one mode change');
    }
    let secondaryProvider = current.secondary_provider;
    let secondaryModel = current.secondary_model;
    let secondaryEffort = current.secondary_effort;
    if (overrides.singleReviewer === true) {
      secondaryProvider = null;
      secondaryModel = null;
      secondaryEffort = null;
    } else {
      const secondaryProviderChanged = overrides.secondaryProvider !== undefined
        && overrides.secondaryProvider !== current.secondary_provider;
      secondaryProvider = overrides.secondaryProvider ?? current.secondary_provider;
      secondaryModel = overrides.secondaryModel
        ?? (secondaryProviderChanged ? providerDefaultModel(secondaryProvider) : current.secondary_model);
      secondaryEffort = overrides.secondaryEffort
        ?? (secondaryProviderChanged ? providerDefaultEffort(secondaryProvider) : current.secondary_effort);
    }
    const enabled = action === 'enable' ? true : action === 'disable' ? false : !current.enabled;
    const now = new Date().toISOString();
    const next = validateMode({
      ...currentReviewMode,
      enabled,
      provider,
      model: overrides.model ?? (providerChanged ? providerDefaultModel(provider) : current.model),
      effort: overrides.effort ?? current.effort,
      secondary_provider: secondaryProvider,
      secondary_model: secondaryModel,
      secondary_effort: secondaryEffort,
      min_confidence: overrides.minConfidence ?? current.min_confidence,
      max_patch_bytes: overrides.maxPatchBytes ?? current.max_patch_bytes,
      timeout_ms: overrides.timeoutMs ?? current.timeout_ms,
      consented_at: enabled ? current.consented_at ?? now : current.consented_at,
      config_revision: current.config_revision + 1,
      updated_at: now
    }, root);
    await writePrivateJsonAtomic(file, next);
    const drainCapabilityIds = await snapshotActiveEgressCapabilities({
      root,
      dataDir,
      modeRevision: current.config_revision
    });
    return { next, drainCapabilityIds };
  }, { timeoutMs: MODE_LOCK_TIMEOUT_MS, staleMs: MODE_LOCK_TIMEOUT_MS });
  await drainEgressCapabilities({
    root,
    dataDir,
    capabilityIds: mutation.drainCapabilityIds,
    timeoutMs: MODE_DRAIN_TIMEOUT_MS
  });
  return mutation.next;
}
