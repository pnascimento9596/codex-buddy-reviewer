import { rm } from 'node:fs/promises';

import { runProcess } from '../process.mjs';
import {
  ProviderFailure,
  processFailureCode,
  providerFailure,
  providerResult
} from '../provider-contract.mjs';
import { cleanupProviderTempRun, createProviderTempRun } from './temp-state.mjs';

const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SUPPORTED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SYSTEM_PROMPT = 'You are an independent read-only code reviewer. Analyze only the user-provided review packet. Do not request, infer, or disclose local machine, account, filesystem, repository, or environment information. Return only the structured response required by the supplied JSON schema.';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseStructuredOutput(value) {
  if (plainObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Claude transport did not contain structured output');
  }
  const parsed = JSON.parse(value.trim());
  if (!plainObject(parsed)) throw new Error('Claude structured output must be one JSON object');
  return parsed;
}

function normalizeClaudeUsage(value) {
  if (!plainObject(value)) return null;
  const directInput = boundedInteger(value.input_tokens);
  const cacheCreation = boundedInteger(value.cache_creation_input_tokens);
  const cachedInput = boundedInteger(value.cache_read_input_tokens);
  const output = boundedInteger(value.output_tokens);
  const reasoning = boundedInteger(value.reasoning_tokens);
  const reportedTotal = boundedInteger(value.total_tokens);

  const input = directInput === null
    ? cacheCreation
    : directInput + (cacheCreation ?? 0);
  const derivedTotal = [directInput, cacheCreation, cachedInput, output].every((item) => item !== null)
    ? directInput + cacheCreation + cachedInput + output
    : null;
  const usage = {
    input_tokens: input,
    cached_input_tokens: cachedInput,
    output_tokens: output,
    reasoning_tokens: reasoning,
    total_tokens: reportedTotal ?? derivedTotal
  };
  return Object.values(usage).some((item) => item !== null) ? Object.freeze(usage) : null;
}

export function parseClaudeTransport(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) {
    throw new Error('Claude transport did not contain a JSON envelope');
  }
  const decoded = JSON.parse(stdout.trim());
  let envelope = decoded;
  if (Array.isArray(decoded)) {
    if (decoded.length === 0 || decoded.some((item) => !plainObject(item))) {
      throw new Error('Claude transport event array is malformed');
    }
    const resultEvents = decoded.filter((item) => item.type === 'result');
    if (resultEvents.length !== 1 || decoded.at(-1) !== resultEvents[0]) {
      throw new Error('Claude transport event array must end with exactly one result');
    }
    envelope = resultEvents[0];
  }
  if (!plainObject(envelope)) throw new Error('Claude transport must be one JSON object');
  if (envelope.type !== 'result'
      || envelope.subtype !== 'success'
      || envelope.is_error !== false) {
    throw new Error('Claude did not return a successful result envelope');
  }
  if (!Object.hasOwn(envelope, 'structured_output')) {
    throw new Error('Claude transport omitted structured output');
  }

  const usage = normalizeClaudeUsage(envelope.usage);
  return {
    reviewPayload: parseStructuredOutput(envelope.structured_output),
    usage,
    usageComplete: usage ? envelope.usage_is_incomplete !== true : null
  };
}

export function buildClaudeProviderEnvironment(ambient = process.env, platform = process.platform) {
  const windows = platform === 'win32';
  const systemRoot = ambient.SystemRoot ?? ambient.SYSTEMROOT ?? ambient.WINDIR;
  return Object.fromEntries(Object.entries({
    PATH: ambient.PATH ?? ambient.Path,
    HOME: ambient.HOME,
    USER: ambient.USER,
    LOGNAME: ambient.LOGNAME,
    TMPDIR: ambient.TMPDIR,
    LANG: ambient.LANG,
    LC_ALL: ambient.LC_ALL,
    SSL_CERT_FILE: ambient.SSL_CERT_FILE,
    SSL_CERT_DIR: ambient.SSL_CERT_DIR,
    NODE_EXTRA_CA_CERTS: ambient.NODE_EXTRA_CA_CERTS,
    HTTPS_PROXY: ambient.HTTPS_PROXY,
    HTTP_PROXY: ambient.HTTP_PROXY,
    ALL_PROXY: ambient.ALL_PROXY,
    NO_PROXY: ambient.NO_PROXY,
    CLAUDE_CODE_OAUTH_TOKEN: ambient.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_API_KEY: ambient.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: ambient.ANTHROPIC_AUTH_TOKEN,
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
    CLAUDE_CODE_SAFE_MODE: '1',
    NO_COLOR: '1',
    TERM: 'dumb'
  }).filter(([, value]) => value !== undefined));
}

export async function reviewWithClaude({
  root,
  prompt,
  model = DEFAULT_MODEL,
  effort = 'high',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  claudeBin = 'claude',
  responseSchema,
  ambientEnvironment = process.env,
  platform = process.platform,
  runProcessImpl = runProcess,
  cleanupImpl = rm,
  monotonicNow = () => performance.now(),
  signal
}) {
  if (!plainObject(responseSchema)) {
    throw new TypeError('Claude review requires an explicit response schema');
  }
  if (typeof prompt !== 'string') throw new TypeError('Claude review prompt must be text');
  if (typeof model !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(model)) {
    throw new TypeError('Claude model must be printable non-empty text');
  }
  if (!SUPPORTED_EFFORTS.has(effort)) {
    throw new TypeError('Claude effort must be low, medium, high, xhigh, or max');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Claude timeout must be a positive integer');
  }
  if (typeof claudeBin !== 'string' || !claudeBin) {
    throw new TypeError('Claude executable must be non-empty text');
  }
  if (typeof runProcessImpl !== 'function') throw new TypeError('Claude process runner must be callable');
  if (typeof cleanupImpl !== 'function') throw new TypeError('Claude cleanup must be callable');

  // `root` is used only to derive the non-reversible workspace attribution in
  // the private run marker. It is never used as the process cwd. Buddy supplies
  // only its bounded packet on stdin and replaces Claude Code's dynamic
  // default system prompt with a static reviewer contract. Authentication and
  // administrator-managed policy remain external Claude Code boundaries.
  const started = monotonicNow();
  const elapsed = () => Math.max(0, monotonicNow() - started);
  let tempRun;
  let outcome;
  let failure;

  try {
    try {
      tempRun = await createProviderTempRun({ root, provider: 'claude' });
    } catch (error) {
      throw providerFailure({
        provider: 'claude', model, stage: 'preflight',
        failureCode: 'isolation_failed', durationMs: elapsed(), cause: error
      });
    }

    const remaining = Math.floor(timeoutMs - elapsed());
    if (!Number.isFinite(remaining) || remaining < 1) {
      throw providerFailure({
        provider: 'claude', model, stage: 'preflight',
        failureCode: 'deadline_exceeded', durationMs: elapsed()
      });
    }
    const args = [
      '--print',
      '--safe-mode',
      '--system-prompt', SYSTEM_PROMPT,
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands',
      '--no-chrome',
      '--no-session-persistence',
      '--tools', '',
      '--permission-mode', 'plan',
      '--input-format', 'text',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(responseSchema),
      '--model', model,
      '--effort', effort
    ];

    let result;
    try {
      result = await runProcessImpl(claudeBin, args, {
        cwd: tempRun.directory,
        env: buildClaudeProviderEnvironment(ambientEnvironment, platform),
        input: prompt,
        protectFromParentDeath: true,
        timeoutMs: remaining,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        signal
      });
    } catch (error) {
      throw providerFailure({
        provider: 'claude', model, stage: 'inference',
        failureCode: error?.kind === 'cancelled' ? 'cancelled' : processFailureCode(error),
        durationMs: elapsed(), cause: error,
        safeMessage: error?.kind === 'cancelled' ? 'The provider review was cancelled.' : undefined
      });
    }

    let transport;
    try {
      transport = parseClaudeTransport(result.stdout);
    } catch (error) {
      throw providerFailure({
        provider: 'claude', model, stage: 'transport',
        failureCode: 'invalid_transport_envelope', durationMs: elapsed(), cause: error
      });
    }

    const stdout = JSON.stringify(transport.reviewPayload);
    outcome = providerResult({
      provider: 'claude', model, stdout, stderr: result.stderr,
      reviewPayload: transport.reviewPayload,
      durationMs: elapsed(),
      usage: transport.usage,
      usageComplete: transport.usageComplete
    });
  } catch (error) {
    failure = error instanceof ProviderFailure
      ? error
      : providerFailure({
          provider: 'claude', model, stage: 'inference',
          failureCode: 'transport_exit', durationMs: elapsed(), cause: error
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
      provider: 'claude', model, stage: 'cleanup',
      failureCode: 'isolation_failed', durationMs: elapsed()
    });
  }
  if (!cleanupFailed) return outcome;
  return {
    ...outcome,
    run: Object.freeze({ ...outcome.run, cleanup_status: 'failed' })
  };
}
