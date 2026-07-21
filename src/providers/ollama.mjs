import { rm } from 'node:fs/promises';

import { runProcess } from '../process.mjs';
import {
  ProviderFailure,
  processFailureCode,
  providerFailure,
  providerResult
} from '../provider-contract.mjs';
import { cleanupProviderTempRun, createProviderTempRun } from './temp-state.mjs';

const DEFAULT_MODEL = 'glm-5.2:cloud';
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function buildOllamaProviderEnvironment(ambient = process.env, platform = process.platform) {
  const windows = platform === 'win32';
  const systemRoot = ambient.SystemRoot ?? ambient.SYSTEMROOT ?? ambient.WINDIR;
  return Object.fromEntries(Object.entries({
    PATH: ambient.PATH ?? ambient.Path,
    HOME: ambient.HOME,
    TMPDIR: ambient.TMPDIR,
    LANG: ambient.LANG,
    LC_ALL: ambient.LC_ALL,
    SSL_CERT_FILE: ambient.SSL_CERT_FILE,
    SSL_CERT_DIR: ambient.SSL_CERT_DIR,
    HTTPS_PROXY: ambient.HTTPS_PROXY,
    HTTP_PROXY: ambient.HTTP_PROXY,
    ALL_PROXY: ambient.ALL_PROXY,
    NO_PROXY: ambient.NO_PROXY,
    ...(windows ? {
      USERPROFILE: ambient.USERPROFILE,
      HOMEDRIVE: ambient.HOMEDRIVE,
      HOMEPATH: ambient.HOMEPATH,
      APPDATA: ambient.APPDATA,
      LOCALAPPDATA: ambient.LOCALAPPDATA,
      TEMP: ambient.TEMP,
      TMP: ambient.TMP,
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATHEXT: ambient.PATHEXT
    } : {}),
    OLLAMA_HOST: ambient.OLLAMA_HOST,
    OLLAMA_NOHISTORY: '1',
    NO_COLOR: '1',
    TERM: 'dumb'
  }).filter(([, value]) => value !== undefined));
}

export function ollamaFormatForModel(model, responseSchema) {
  return model.endsWith(':cloud') ? 'json' : JSON.stringify(responseSchema);
}

export async function reviewWithOllama(options = {}) {
  const optionRecord = options !== null && typeof options === 'object' && !Array.isArray(options);
  const model = optionRecord ? options.model : undefined;
  const resolvedModel = model ?? DEFAULT_MODEL;
  const monotonicNow = optionRecord && typeof options.monotonicNow === 'function'
    ? options.monotonicNow
    : () => performance.now();
  const started = monotonicNow();
  const elapsed = () => Math.max(0, monotonicNow() - started);
  if (!optionRecord) {
    throw providerFailure({
      provider: 'ollama', model: resolvedModel, stage: 'preflight',
      failureCode: 'isolation_failed', durationMs: elapsed(),
      safeMessage: 'Ollama review options must be an object.'
    });
  }
  const {
    root,
    prompt,
    timeoutMs,
    ollamaBin,
    think = 'high',
    responseSchema,
    ambientEnvironment = process.env,
    platform = process.platform,
    runProcessImpl = runProcess,
    cleanupImpl = rm,
    signal
  } = options;
  if (!responseSchema || typeof responseSchema !== 'object' || Array.isArray(responseSchema)) {
    throw providerFailure({
      provider: 'ollama', model: resolvedModel, stage: 'preflight',
      failureCode: 'isolation_failed', durationMs: elapsed(),
      safeMessage: 'Ollama review requires an explicit response schema.'
    });
  }
  if (!['false', 'true', 'low', 'medium', 'high'].includes(String(think))) {
    throw providerFailure({
      provider: 'ollama', model: resolvedModel, stage: 'preflight',
      failureCode: 'isolation_failed', durationMs: elapsed(),
      safeMessage: 'Ollama think setting must be false, true, low, medium, or high.'
    });
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw providerFailure({
      provider: 'ollama', model: resolvedModel, stage: 'preflight',
      failureCode: 'isolation_failed', durationMs: elapsed(),
      safeMessage: 'Ollama timeout must be a positive integer.'
    });
  }
  if (typeof runProcessImpl !== 'function' || typeof cleanupImpl !== 'function') {
    throw providerFailure({
      provider: 'ollama', model: resolvedModel, stage: 'preflight',
      failureCode: 'isolation_failed', durationMs: elapsed(),
      safeMessage: 'Ollama process and cleanup operations must be callable.'
    });
  }

  // `root` is used only for the non-reversible workspace attribution in the
  // private run marker. Ollama keeps the existing authenticated HOME or
  // USERPROFILE environment, but it cannot discover repository configuration
  // through its cwd because the reviewed repository is never the process cwd.
  let tempRun;
  let outcome;
  let failure;
  try {
    try {
      tempRun = await createProviderTempRun({ root, provider: 'ollama' });
    } catch (error) {
      throw providerFailure({
        provider: 'ollama', model: resolvedModel, stage: 'preflight',
        failureCode: 'isolation_failed', durationMs: elapsed(), cause: error
      });
    }

    const remaining = Math.floor(timeoutMs - elapsed());
    if (!Number.isFinite(remaining) || remaining < 1) {
      throw providerFailure({
        provider: 'ollama', model: resolvedModel, stage: 'preflight',
        failureCode: 'deadline_exceeded', durationMs: elapsed()
      });
    }

    let result;
    try {
      result = await runProcessImpl(ollamaBin ?? 'ollama', [
        'run', resolvedModel,
        '--format', ollamaFormatForModel(resolvedModel, responseSchema),
        '--think', String(think),
        '--hidethinking',
        '--nowordwrap'
      ], {
        cwd: tempRun.directory,
        input: prompt,
        protectFromParentDeath: true,
        timeoutMs: remaining,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        env: buildOllamaProviderEnvironment(ambientEnvironment, platform),
        signal
      });
    } catch (error) {
      throw providerFailure({
        provider: 'ollama', model: resolvedModel, stage: 'inference',
        failureCode: error?.kind === 'cancelled' ? 'cancelled' : processFailureCode(error),
        durationMs: elapsed(), cause: error,
        safeMessage: error?.kind === 'cancelled' ? 'The provider review was cancelled.' : undefined
      });
    }

    outcome = providerResult({
      provider: 'ollama', model: resolvedModel,
      stdout: result.stdout, stderr: result.stderr,
      reviewPayload: null, durationMs: elapsed()
    });
  } catch (error) {
    failure = error instanceof ProviderFailure
      ? error
      : providerFailure({
          provider: 'ollama', model: resolvedModel, stage: 'inference',
          failureCode: processFailureCode(error), durationMs: elapsed(), cause: error
        });
  }

  let cleanupFailed = false;
  if (tempRun) {
    try {
      await cleanupProviderTempRun(tempRun, { cleanupImpl });
    } catch {
      cleanupFailed = true;
    }
  }
  if (failure) throw failure;
  if (!outcome) {
    throw providerFailure({
      provider: 'ollama', model: resolvedModel, stage: 'cleanup',
      failureCode: 'isolation_failed', durationMs: elapsed()
    });
  }
  if (!cleanupFailed) return outcome;
  return {
    ...outcome,
    run: Object.freeze({ ...outcome.run, cleanup_status: 'failed' })
  };
}
