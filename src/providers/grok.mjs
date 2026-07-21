import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { runProcess } from '../process.mjs';
import {
  ProviderFailure,
  parseGrokTransport,
  processFailureCode,
  providerFailure,
  providerResult
} from '../provider-contract.mjs';
import { cleanupProviderTempRun, createProviderTempRun } from './temp-state.mjs';

const GROK_INERT_BUILTIN_AGENTS = Object.freeze([
  'explore',
  'general-purpose',
  'plan'
]);
const GROK_POSIX_BRIDGE_BINARIES = Object.freeze([
  '/bin/sh',
  '/bin/cat',
  '/usr/bin/mkfifo',
  '/bin/rm'
]);
const GROK_POSIX_PROMPT_FIFO = '.grok-prompt.pipe';
const GROK_POSIX_BRIDGE_SCRIPT = `fifo=$1
mkfifo_bin=$2
cat_bin=$3
rm_bin=$4
shift 4
"$mkfifo_bin" "$fifo" || exit 125
exec 3<&0
"$cat_bin" <&3 > "$fifo" &
producer=$!
exec 3<&-
"$@" < /dev/null
consumer_status=$?
if [ "$consumer_status" -ne 0 ]; then
  "$rm_bin" -f "$fifo"
  exit "$consumer_status"
fi
wait "$producer"
producer_status=$?
"$rm_bin" -f "$fifo"
cleanup_status=$?
if [ "$producer_status" -ne 0 ]; then exit "$producer_status"; fi
if [ "$cleanup_status" -ne 0 ]; then exit "$cleanup_status"; fi
exit "$consumer_status"`;

function isExactInertBuiltinAgentInventory(value) {
  if (!Array.isArray(value)) return false;
  if (value.length !== GROK_INERT_BUILTIN_AGENTS.length) return false;

  const names = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (!Object.keys(item).every((key) => ['description', 'name', 'source'].includes(key))) return false;
    if (typeof item.name !== 'string' || typeof item.description !== 'string') return false;
    if (!item.source || typeof item.source !== 'object' || Array.isArray(item.source)) return false;
    if (Object.keys(item.source).length !== 1 || item.source.type !== 'builtin') return false;
    names.push(item.name);
  }

  return names.sort().every((name, index) => name === GROK_INERT_BUILTIN_AGENTS[index]);
}

async function resolveGrokBin(explicit) {
  if (explicit) return explicit;
  const homeBin = path.join(
    os.homedir(),
    '.grok',
    'bin',
    process.platform === 'win32' ? 'grok.exe' : 'grok'
  );
  try {
    await access(homeBin, constants.X_OK);
    return homeBin;
  } catch {
    return 'grok';
  }
}

export function buildGrokInferenceProcess(binary, args, {
  platform = process.platform,
  fifoPath,
  shellBinary = GROK_POSIX_BRIDGE_BINARIES[0],
  catBinary = GROK_POSIX_BRIDGE_BINARIES[1],
  mkfifoBinary = GROK_POSIX_BRIDGE_BINARIES[2],
  rmBinary = GROK_POSIX_BRIDGE_BINARIES[3]
} = {}) {
  if (typeof binary !== 'string' || binary.length === 0) {
    throw new TypeError('Grok binary must be non-empty text');
  }
  if (!Array.isArray(args) || !args.every((argument) => typeof argument === 'string')) {
    throw new TypeError('Grok arguments must be an array of text');
  }
  if (platform === 'win32') {
    return Object.freeze({ command: binary, args: Object.freeze([...args]) });
  }
  if (typeof fifoPath !== 'string' || !path.isAbsolute(fifoPath)) {
    throw new TypeError('Grok POSIX bridge FIFO must be an absolute path');
  }
  return Object.freeze({
    command: shellBinary,
    args: Object.freeze([
      '-c',
      GROK_POSIX_BRIDGE_SCRIPT,
      'buddy-grok-stdin-bridge',
      fifoPath,
      mkfifoBinary,
      catBinary,
      rmBinary,
      binary,
      ...args
    ])
  });
}

export function buildGrokProviderEnvironment({
  ambient = process.env,
  isolatedHome,
  grokHome,
  authPath,
  platform = process.platform
}) {
  for (const [label, value] of Object.entries({ isolatedHome, grokHome, authPath })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be non-empty text`);
  }
  const windows = platform === 'win32';
  const windowsPath = ambient.PATH ?? ambient.Path;
  const localAppData = windows ? path.win32.join(isolatedHome, 'AppData', 'Local') : null;
  const parsedHome = windows ? path.win32.parse(isolatedHome) : null;
  const homeDrive = parsedHome?.root ? parsedHome.root.replace(/[\\/]$/u, '') : undefined;
  const homePath = windows && homeDrive ? isolatedHome.slice(homeDrive.length) || '\\' : undefined;
  const systemRoot = ambient.SystemRoot ?? ambient.SYSTEMROOT ?? ambient.WINDIR;
  const env = {
    PATH: windowsPath,
    HOME: isolatedHome,
    TMPDIR: windows ? path.win32.join(localAppData, 'Temp') : ambient.TMPDIR,
    LANG: ambient.LANG,
    LC_ALL: ambient.LC_ALL,
    SSL_CERT_FILE: ambient.SSL_CERT_FILE,
    SSL_CERT_DIR: ambient.SSL_CERT_DIR,
    HTTPS_PROXY: ambient.HTTPS_PROXY,
    HTTP_PROXY: ambient.HTTP_PROXY,
    ALL_PROXY: ambient.ALL_PROXY,
    NO_PROXY: ambient.NO_PROXY,
    ...(windows ? {
      USERPROFILE: isolatedHome,
      HOMEDRIVE: homeDrive,
      HOMEPATH: homePath,
      APPDATA: path.win32.join(isolatedHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: localAppData,
      TEMP: path.win32.join(localAppData, 'Temp'),
      TMP: path.win32.join(localAppData, 'Temp'),
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATHEXT: ambient.PATHEXT
    } : {}),
    GROK_HOME: grokHome,
    GROK_AUTH_PATH: authPath,
    GROK_CURSOR_SKILLS_ENABLED: 'false',
    GROK_CURSOR_RULES_ENABLED: 'false',
    GROK_CURSOR_AGENTS_ENABLED: 'false',
    GROK_CURSOR_MCPS_ENABLED: 'false',
    GROK_CURSOR_HOOKS_ENABLED: 'false',
    GROK_CURSOR_SESSIONS_ENABLED: 'false',
    GROK_CLAUDE_SKILLS_ENABLED: 'false',
    GROK_CLAUDE_RULES_ENABLED: 'false',
    GROK_CLAUDE_AGENTS_ENABLED: 'false',
    GROK_CLAUDE_MCPS_ENABLED: 'false',
    GROK_CLAUDE_HOOKS_ENABLED: 'false',
    GROK_CLAUDE_SESSIONS_ENABLED: 'false',
    GROK_CODEX_SESSIONS_ENABLED: 'false'
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

export async function reviewWithGrok({
  root,
  prompt,
  model,
  effort,
  timeoutMs = 30_000,
  grokBin,
  grokAuthPath,
  responseSchema,
  cleanupImpl = rm,
  monotonicNow = () => performance.now(),
  runProcessImpl = runProcess,
  signal
}) {
  if (!responseSchema || typeof responseSchema !== 'object' || Array.isArray(responseSchema)) {
    throw new TypeError('Grok review requires an explicit response schema');
  }
  if (typeof cleanupImpl !== 'function') throw new TypeError('Grok cleanup must be callable');
  if (typeof runProcessImpl !== 'function') throw new TypeError('Grok process runner must be callable');
  const resolvedModel = model ?? 'grok-4.5';
  const started = monotonicNow();
  const elapsed = () => Math.max(0, monotonicNow() - started);
  const remainingTimeout = (stage) => {
    const remaining = Math.floor(timeoutMs - elapsed());
    if (!Number.isFinite(remaining) || remaining < 1) {
      throw providerFailure({
        provider: 'grok', model: resolvedModel, stage,
        failureCode: 'deadline_exceeded', durationMs: elapsed()
      });
    }
    return remaining;
  };
  let tempRun;
  let tempDir;
  let outcome;
  let failure;
  try {
    tempRun = await createProviderTempRun({ root, provider: 'grok' });
    tempDir = tempRun.directory;
    // Grok requires --prompt-file. POSIX uses a private relative FIFO so the
    // provider opens exactly one reader while the supervised producer supplies
    // stdin without materializing prompt bytes. Windows has no portable
    // equivalent, so it retains the private temporary file and relies on the
    // adapter's bounded cleanup path.
    const promptFile = process.platform === 'win32'
      ? path.join(tempDir, 'review-prompt.txt')
      : GROK_POSIX_PROMPT_FIFO;
    const isolatedHome = path.join(tempDir, 'home');
    const grokHome = path.join(tempDir, 'grok-home');
    const authPath = grokAuthPath ?? path.join(os.homedir(), '.grok', 'auth.json');
    await mkdir(isolatedHome, { mode: 0o700 });
    remainingTimeout('preflight');
    if (process.platform === 'win32') {
      await Promise.all([
        mkdir(path.win32.join(isolatedHome, 'AppData', 'Roaming'), { recursive: true, mode: 0o700 }),
        mkdir(path.win32.join(isolatedHome, 'AppData', 'Local', 'Temp'), { recursive: true, mode: 0o700 })
      ]);
      remainingTimeout('preflight');
    }
    await mkdir(grokHome, { mode: 0o700 });
    remainingTimeout('preflight');
    const configFile = path.join(grokHome, 'config.toml');
    const compatibilityConfig = `[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.codex]
sessions = false
`;
    await writeFile(configFile, compatibilityConfig, { mode: 0o600 });
    remainingTimeout('preflight');
    if (process.platform === 'win32') {
      await writeFile(promptFile, prompt, { mode: 0o600 });
      remainingTimeout('preflight');
    }
    const binary = await resolveGrokBin(grokBin);
    remainingTimeout('preflight');
    try {
      await access(authPath, constants.R_OK);
    } catch (error) {
      remainingTimeout('preflight');
      throw providerFailure({
        provider: 'grok', model: resolvedModel, stage: 'preflight',
        failureCode: 'auth_unavailable', durationMs: elapsed(), cause: error
      });
    }
    remainingTimeout('preflight');
    const env = buildGrokProviderEnvironment({ isolatedHome, grokHome, authPath });

    if (process.platform !== 'win32') {
      try {
        await Promise.all(GROK_POSIX_BRIDGE_BINARIES.map((file) => access(file, constants.X_OK)));
      } catch (error) {
        throw providerFailure({
          provider: 'grok', model: resolvedModel, stage: 'preflight',
          failureCode: 'isolation_failed', durationMs: elapsed(),
          safeMessage: 'POSIX Grok prompt bridge is unavailable', cause: error
        });
      }
      remainingTimeout('preflight');
    }

    const inspections = [];
    const inspect = async () => {
      try {
        const result = await runProcessImpl(binary, ['inspect', '--json'], {
          cwd: tempDir,
          env,
          protectFromParentDeath: true,
          timeoutMs: Math.min(remainingTimeout('preflight'), 30_000),
          maxOutputBytes: 2 * 1024 * 1024,
          signal
        });
        inspections.push(result);
        return JSON.parse(result.stdout);
      } catch (error) {
        if (error instanceof ProviderFailure) throw error;
        throw providerFailure({
          provider: 'grok', model: resolvedModel, stage: 'preflight',
          failureCode: error instanceof SyntaxError
            ? 'isolation_failed'
            : error?.kind === 'cancelled' ? 'cancelled' : processFailureCode(error),
          durationMs: elapsed(),
          safeMessage: error?.kind === 'cancelled' ? 'The provider review was cancelled.' : undefined,
          cause: error
        });
      }
    };

    const inventory = await inspect();
    remainingTimeout('preflight');
    if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
      throw providerFailure({
        provider: 'grok', model: resolvedModel, stage: 'preflight',
        failureCode: 'isolation_failed', durationMs: elapsed()
      });
    }

    const requiredFields = ['projectInstructions', 'hooks', 'plugins', 'mcpServers', 'agents'];
    const optionalExternalFields = ['skills', 'lspServers'];
    for (const field of requiredFields) {
      if (!Array.isArray(inventory[field])) {
        throw providerFailure({
          provider: 'grok', model: resolvedModel, stage: 'preflight',
          failureCode: 'isolation_failed', durationMs: elapsed(),
          safeMessage: `isolated Grok preflight returned no ${field} inventory`
        });
      }
    }
    for (const field of [...requiredFields, ...optionalExternalFields]) {
      if (inventory[field] === undefined) continue;
      if (!Array.isArray(inventory[field])) {
        throw providerFailure({
          provider: 'grok', model: resolvedModel, stage: 'preflight',
          failureCode: 'isolation_failed', durationMs: elapsed(),
          safeMessage: `isolated Grok preflight returned invalid ${field} inventory`
        });
      }
      // Grok 0.2.103 always reports its three built-in agent
      // definitions even when subagent spawning is disabled. They are inert
      // under --no-subagents and the explicit Agent tool denial below. Keep
      // this compatibility exception exact so any custom or future inventory
      // still fails closed until it is reviewed.
      if (field === 'agents') {
        if (isExactInertBuiltinAgentInventory(inventory[field])) continue;
        throw providerFailure({
          provider: 'grok', model: resolvedModel, stage: 'preflight',
          failureCode: 'isolation_failed', durationMs: elapsed(),
          safeMessage: 'isolated Grok preflight returned an unexpected agents inventory'
        });
      }
      const active = inventory[field].filter(
        (item) => item?.enabled !== false && item?.disabled !== true && item?.compatibilityStatus !== 'disabled'
      );
      if (active.length !== 0) {
        throw providerFailure({
          provider: 'grok', model: resolvedModel, stage: 'preflight',
          failureCode: 'isolation_failed', durationMs: elapsed(),
          safeMessage: `isolated Grok preflight found unexpected active ${field}`
        });
      }
    }

    const args = [
      '--cwd', tempDir,
      '--model', resolvedModel,
      '--reasoning-effort', effort ?? 'high',
      '--prompt-file', promptFile,
      '--verbatim',
      '--no-memory',
      '--no-subagents',
      '--disable-web-search',
      '--max-turns', '1',
      '--permission-mode', 'plan',
      '--tools', '',
      '--deny', '*',
      '--disallowed-tools', 'Bash,Edit,Write,Read,Glob,Grep,WebSearch,WebFetch,Agent',
      '--system-prompt-override', 'Review only the supplied evidence. Do not use tools, external context, memory, plugins, or subagents. Return only the required JSON.',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(responseSchema)
    ];
    let result;
    try {
      const inferenceTimeoutMs = remainingTimeout('inference');
      const inference = buildGrokInferenceProcess(binary, args, {
        fifoPath: path.join(tempDir, GROK_POSIX_PROMPT_FIFO)
      });
      result = await runProcessImpl(inference.command, inference.args, {
        cwd: tempDir,
        env,
        input: process.platform === 'win32' ? undefined : prompt,
        protectFromParentDeath: true,
        timeoutMs: inferenceTimeoutMs,
        maxOutputBytes: 4 * 1024 * 1024,
        signal
      });
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw providerFailure({
        provider: 'grok', model: resolvedModel, stage: 'inference',
        failureCode: error?.kind === 'cancelled' ? 'cancelled' : processFailureCode(error),
        durationMs: elapsed(), cause: error,
        safeMessage: error?.kind === 'cancelled' ? 'The provider review was cancelled.' : undefined
      });
    }
    let transport;
    try {
      transport = parseGrokTransport(result.stdout);
    } catch (error) {
      throw providerFailure({
        provider: 'grok', model: resolvedModel, stage: 'transport',
        failureCode: 'invalid_transport_envelope', durationMs: elapsed(), cause: error
      });
    }
    const stdout = JSON.stringify(transport.reviewPayload);
    const stderr = [...inspections.map((item) => item.stderr), result.stderr].filter(Boolean).join('\n');
    outcome = providerResult({
      provider: 'grok', model: resolvedModel, stdout, stderr,
      reviewPayload: transport.reviewPayload,
      durationMs: elapsed(),
      usage: transport.usage,
      usageComplete: transport.usageComplete,
      costUsdTicks: transport.costUsdTicks
    });
  } catch (error) {
    failure = error instanceof ProviderFailure
      ? error
      : providerFailure({
          provider: 'grok', model: resolvedModel, stage: 'preflight',
          failureCode: 'isolation_failed', durationMs: elapsed(), cause: error
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
      provider: 'grok', model: resolvedModel, stage: 'cleanup',
      failureCode: 'isolation_failed', durationMs: elapsed()
    });
  }
  if (!cleanupFailed) return outcome;
  return {
    ...outcome,
    run: Object.freeze({ ...outcome.run, cleanup_status: 'failed' })
  };
}
