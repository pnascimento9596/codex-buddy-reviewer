import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from '../process.mjs';
import {
  ProviderFailure,
  processFailureCode,
  providerFailure,
  providerResult
} from '../provider-contract.mjs';
import { cleanupProviderTempRun, createProviderTempRun } from './temp-state.mjs';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_AUTH_BYTES = 1024 * 1024;
const DENIED_TOOLS = Object.freeze([
  'bash',
  'edit',
  'glob',
  'grep',
  'lsp',
  'question',
  'read',
  'skill',
  'task',
  'todoread',
  'todowrite',
  'webfetch',
  'websearch',
  'write'
]);
const KNOWN_EVENT_TYPES = new Set(['step_start', 'step_finish', 'text', 'tool_use', 'error']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function printableToken(value, label, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
      || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty printable ASCII token`);
  }
  return value;
}

function parsedAuthContent(value) {
  if (typeof value !== 'string' || !value.trim()
      || Buffer.byteLength(value, 'utf8') > MAX_AUTH_BYTES) {
    throw new TypeError('OpenCode auth content must be bounded non-empty text');
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TypeError('OpenCode auth content must be valid JSON', { cause: error });
  }
  if (!plainObject(parsed)) throw new TypeError('OpenCode auth content must be one JSON object');
  return parsed;
}

function projectedAuthContent(value, providerId) {
  const parsed = parsedAuthContent(value);
  if (!Object.hasOwn(parsed, providerId)) return undefined;
  return JSON.stringify({ [providerId]: parsed[providerId] });
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function awaitPreflightBoundary(promise, checkRemaining) {
  let value;
  try {
    value = await promise;
  } catch (error) {
    checkRemaining();
    throw error;
  }
  checkRemaining();
  return value;
}

async function readAuthFileNoFollow(file, checkRemaining) {
  let before;
  try {
    before = await awaitPreflightBoundary(lstat(file, { bigint: true }), checkRemaining);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1n
      || before.size > BigInt(MAX_AUTH_BYTES)) {
    throw new Error('OpenCode auth store must be a bounded regular non-symlink file');
  }
  let handle;
  try {
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      checkRemaining();
      throw error;
    }
    checkRemaining();
    const opened = await awaitPreflightBoundary(handle.stat({ bigint: true }), checkRemaining);
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      throw new Error('OpenCode auth store changed while it was being opened');
    }
    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await awaitPreflightBoundary(
        handle.read(buffer, offset, buffer.length - offset, offset),
        checkRemaining
      );
      if (bytesRead === 0) throw new Error('OpenCode auth store changed while it was being read');
      offset += bytesRead;
    }
    const after = await awaitPreflightBoundary(handle.stat({ bigint: true }), checkRemaining);
    if (!sameFileSnapshot(opened, after)) {
      throw new Error('OpenCode auth store changed while it was being read');
    }
    return buffer.toString('utf8');
  } finally {
    if (handle) {
      await awaitPreflightBoundary(handle.close().catch(() => {}), checkRemaining);
    }
  }
}

function openCodeConfiguration(agentName) {
  const denyAll = {
    '*': 'deny',
    ...Object.fromEntries(DENIED_TOOLS.map((tool) => [tool, 'deny']))
  };
  const disabledTools = Object.fromEntries(DENIED_TOOLS.map((tool) => [tool, false]));
  return {
    autoupdate: false,
    share: 'disabled',
    instructions: [],
    plugin: [],
    mcp: {},
    permission: denyAll,
    agent: {
      [agentName]: {
        description: 'Ephemeral independent code reviewer with no tool access',
        mode: 'primary',
        prompt: 'Review only the supplied evidence. Do not use tools, files, external context, plugins, memory, or subagents. Return only the requested JSON.',
        tools: disabledTools,
        permission: denyAll
      }
    }
  };
}

export function buildOpenCodeProviderEnvironment({
  ambient = process.env,
  configDir,
  workDir,
  dataDir,
  cacheDir,
  stateDir,
  tempDir,
  authContent,
  agentName
}) {
  if (!plainObject(ambient)) throw new TypeError('OpenCode ambient environment must be an object');
  if (typeof configDir !== 'string' || !configDir) {
    throw new TypeError('OpenCode config directory must be non-empty text');
  }
  if (typeof workDir !== 'string' || !workDir) {
    throw new TypeError('OpenCode work directory must be non-empty text');
  }
  for (const [label, value] of Object.entries({ dataDir, cacheDir, stateDir, tempDir })) {
    if (typeof value !== 'string' || !value) {
      throw new TypeError(`OpenCode ${label} must be non-empty text`);
    }
  }
  if (authContent !== undefined) parsedAuthContent(authContent);
  printableToken(agentName, 'OpenCode reviewer agent name', 100);
  const denyAll = JSON.stringify({
    '*': 'deny',
    ...Object.fromEntries(DENIED_TOOLS.map((tool) => [tool, 'deny']))
  });
  const config = JSON.stringify(openCodeConfiguration(agentName));
  const windows = process.platform === 'win32';
  const systemRoot = ambient.SystemRoot ?? ambient.SYSTEMROOT ?? ambient.WINDIR;
  return Object.fromEntries(Object.entries({
    PATH: ambient.PATH ?? ambient.Path,
    HOME: workDir,
    LANG: ambient.LANG,
    LC_ALL: ambient.LC_ALL,
    SSL_CERT_FILE: ambient.SSL_CERT_FILE,
    SSL_CERT_DIR: ambient.SSL_CERT_DIR,
    NODE_EXTRA_CA_CERTS: ambient.NODE_EXTRA_CA_CERTS,
    HTTPS_PROXY: ambient.HTTPS_PROXY,
    HTTP_PROXY: ambient.HTTP_PROXY,
    ALL_PROXY: ambient.ALL_PROXY,
    NO_PROXY: ambient.NO_PROXY,
    ...(windows ? {
      USERPROFILE: workDir,
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATHEXT: ambient.PATHEXT,
      ComSpec: ambient.ComSpec ?? ambient.COMSPEC
    } : {}),
    // OpenCode resolves its local project root from PWD before process.cwd().
    // Bind both views to the same empty private directory.
    PWD: workDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_STATE_HOME: stateDir,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    OPENCODE_CONFIG: undefined,
    OPENCODE_TUI_CONFIG: undefined,
    OPENCODE_DB: undefined,
    OPENCODE_TEST_HOME: undefined,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: undefined,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_CONTENT: config,
    OPENCODE_AUTH_CONTENT: authContent,
    OPENCODE_PERMISSION: denyAll,
    OPENCODE_PURE: 'true',
    OPENCODE_AUTO_SHARE: 'false',
    OPENCODE_DISABLE_SHARE: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    // Do not set OPENCODE_DISABLE_DEFAULT_PLUGINS. OpenCode 1.18+ registers
    // first-party providers (xai, anthropic, openai, ...) through default
    // plugins. Disabling them yields ProviderModelNotFoundError for valid
    // provider/model IDs under isolation, which Buddy surfaces as
    // transport_exit. --pure / OPENCODE_PURE already exclude external plugins.
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_ENABLE_EXA: 'false',
    OPENCODE_EXPERIMENTAL_EXA: 'false',
    OPENCODE_EXPERIMENTAL_LSP_TOOL: 'false',
    OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'false',
    OPENCODE_EXPERIMENTAL_PARALLEL: 'false',
    OPENCODE_ENABLE_PARALLEL: 'false',
    NO_COLOR: '1',
    TERM: 'dumb'
  }).filter(([, value]) => value !== undefined));
}

async function inheritedOpenCodeAuthContent(ambient, providerId, checkRemaining) {
  if (typeof ambient.OPENCODE_AUTH_CONTENT === 'string' && ambient.OPENCODE_AUTH_CONTENT.trim()) {
    return projectedAuthContent(ambient.OPENCODE_AUTH_CONTENT, providerId);
  }
  const home = typeof ambient.HOME === 'string' && ambient.HOME
    ? ambient.HOME
    : os.homedir();
  const dataHome = typeof ambient.XDG_DATA_HOME === 'string' && ambient.XDG_DATA_HOME
    ? ambient.XDG_DATA_HOME
    : process.platform === 'win32' && typeof ambient.LOCALAPPDATA === 'string' && ambient.LOCALAPPDATA
      ? ambient.LOCALAPPDATA
      : path.join(home, '.local', 'share');
  const content = await readAuthFileNoFollow(
    path.join(dataHome, 'opencode', 'auth.json'),
    checkRemaining
  );
  return content === undefined ? undefined : projectedAuthContent(content, providerId);
}

export function parseOpenCodeTransport(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) {
    throw new Error('OpenCode transport did not contain JSON events');
  }

  let completedText = null;
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error('OpenCode transport contained an invalid JSON event', { cause: error });
    }
    if (!plainObject(event) || typeof event.type !== 'string' || !KNOWN_EVENT_TYPES.has(event.type)) {
      throw new Error('OpenCode transport contained an unknown event');
    }
    if (event.type === 'tool_use') {
      throw new Error('OpenCode attempted to use a denied tool');
    }
    if (event.type === 'error') {
      throw new Error('OpenCode returned an error event');
    }
    if (event.type !== 'text') continue;
    if (!plainObject(event.part) || event.part.type !== 'text'
        || !plainObject(event.part.time) || !Number.isFinite(event.part.time.end)) {
      continue;
    }
    if (typeof event.part.text !== 'string' || !event.part.text.trim()) continue;
    completedText = event.part.text;
  }

  if (completedText === null) {
    throw new Error('OpenCode transport contained no completed text result');
  }
  let reviewPayload;
  try {
    reviewPayload = JSON.parse(completedText.trim());
  } catch (error) {
    throw new Error('OpenCode completed text was not valid review JSON', { cause: error });
  }
  if (!plainObject(reviewPayload)) {
    throw new Error('OpenCode review JSON must be one object');
  }
  return { reviewPayload };
}

export async function reviewWithOpenCode({
  root,
  prompt,
  model,
  effort = 'high',
  timeoutMs = 30_000,
  opencodeBin = 'opencode',
  responseSchema,
  run = runProcess,
  cleanupImpl = rm,
  ambient = process.env,
  monotonicNow = () => performance.now(),
  signal
}) {
  if (!responseSchema || typeof responseSchema !== 'object' || Array.isArray(responseSchema)) {
    throw new TypeError('OpenCode review requires an explicit response schema');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new TypeError('OpenCode review prompt must be non-empty text');
  }
  const resolvedModel = printableToken(model, 'OpenCode model', 200);
  if (!resolvedModel.includes('/') || resolvedModel.startsWith('/') || resolvedModel.endsWith('/')) {
    throw new TypeError('OpenCode model must use provider/model form');
  }
  const resolvedEffort = printableToken(effort, 'OpenCode variant', 64);
  if (typeof opencodeBin !== 'string' || !opencodeBin) {
    throw new TypeError('OpenCode executable must be non-empty text');
  }
  if (typeof run !== 'function') throw new TypeError('OpenCode process runner must be a function');
  if (typeof cleanupImpl !== 'function') throw new TypeError('OpenCode cleanup must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('OpenCode timeout must be a positive number');
  }

  const started = monotonicNow();
  const elapsed = () => Math.max(0, monotonicNow() - started);
  const remainingTimeout = (stage) => {
    const durationMs = elapsed();
    const remaining = Math.floor(timeoutMs - durationMs);
    if (!Number.isFinite(remaining) || remaining < 1) {
      throw providerFailure({
        provider: 'opencode', model: resolvedModel, stage,
        failureCode: 'deadline_exceeded', durationMs
      });
    }
    return remaining;
  };
  const checkPreflightRemaining = () => remainingTimeout('preflight');
  let tempRun;
  let tempRoot;
  let outcome;
  let authoritativeError = null;
  try {
    try {
      try {
        tempRun = await createProviderTempRun({ root, provider: 'opencode' });
        tempRoot = tempRun.directory;
        checkPreflightRemaining();
      } catch (error) {
        checkPreflightRemaining();
        throw error;
      }
      checkPreflightRemaining();
      const workDir = path.join(tempRoot, 'work');
      const configDir = path.join(tempRoot, 'config');
      const dataDir = path.join(tempRoot, 'data');
      const cacheDir = path.join(tempRoot, 'cache');
      const stateDir = path.join(tempRoot, 'state');
      const tempDir = path.join(tempRoot, 'tmp');
      await awaitPreflightBoundary(
        Promise.all([
          mkdir(workDir, { mode: 0o700 }),
          mkdir(configDir, { mode: 0o700 }),
          mkdir(dataDir, { mode: 0o700 }),
          mkdir(cacheDir, { mode: 0o700 }),
          mkdir(stateDir, { mode: 0o700 }),
          mkdir(tempDir, { mode: 0o700 })
        ]),
        checkPreflightRemaining
      );
      const agentName = `buddy-review-${randomBytes(24).toString('hex')}`;
      const authContent = await awaitPreflightBoundary(
        inheritedOpenCodeAuthContent(
          ambient,
          resolvedModel.split('/', 1)[0],
          checkPreflightRemaining
        ),
        checkPreflightRemaining
      );
      const env = buildOpenCodeProviderEnvironment({
        ambient,
        configDir,
        workDir,
        dataDir,
        cacheDir,
        stateDir,
        tempDir,
        authContent,
        agentName
      });
      const args = [
        'run',
        '--pure',
        '--agent', agentName,
        '--model', resolvedModel,
        '--variant', resolvedEffort,
        '--format', 'json'
      ];

      let result;
      try {
        const inferenceTimeoutMs = remainingTimeout('preflight');
        result = await run(opencodeBin, args, {
          cwd: workDir,
          env,
          input: prompt,
          protectFromParentDeath: true,
          timeoutMs: inferenceTimeoutMs,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          signal
        });
      } catch (error) {
        if (error instanceof ProviderFailure) throw error;
        throw providerFailure({
          provider: 'opencode', model: resolvedModel, stage: 'inference',
          failureCode: error?.kind === 'cancelled' ? 'cancelled' : processFailureCode(error),
          durationMs: elapsed(), cause: error,
          safeMessage: error?.kind === 'cancelled' ? 'The provider review was cancelled.' : undefined
        });
      }

      let transport;
      try {
        transport = parseOpenCodeTransport(result.stdout);
      } catch (error) {
        throw providerFailure({
          provider: 'opencode', model: resolvedModel, stage: 'transport',
          failureCode: 'invalid_transport_envelope', durationMs: elapsed(), cause: error
        });
      }
      const stdout = JSON.stringify(transport.reviewPayload);
      outcome = providerResult({
        provider: 'opencode',
        model: resolvedModel,
        stdout,
        stderr: result.stderr,
        reviewPayload: transport.reviewPayload,
        durationMs: elapsed()
      });
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw providerFailure({
        provider: 'opencode', model: resolvedModel, stage: 'preflight',
        failureCode: 'isolation_failed', durationMs: elapsed(), cause: error
      });
    }
  } catch (error) {
    authoritativeError = error;
  }

  let cleanupFailed = false;
  if (tempRun) {
    try {
      await cleanupProviderTempRun(tempRun, { cleanupImpl });
    } catch {
      cleanupFailed = true;
    }
  }
  void root;

  if (authoritativeError) throw authoritativeError;
  if (!outcome) {
    throw providerFailure({
      provider: 'opencode', model: resolvedModel, stage: 'cleanup',
      failureCode: 'isolation_failed', durationMs: elapsed()
    });
  }
  if (cleanupFailed) {
    return {
      ...outcome,
      run: Object.freeze({ ...outcome.run, cleanup_status: 'failed' })
    };
  }
  return outcome;
}
