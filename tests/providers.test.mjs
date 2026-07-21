import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, chmod, mkdir as fsMkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareReviewRequest } from '../src/cli.mjs';
import {
  egressConfigurationHash,
  issueEgressCapability,
  readEgressRegistry,
  spendEgressCapability
} from '../src/egress-capability.mjs';
import {
  ProviderFailure,
  parseGrokTransport,
  processFailureCode,
  providerResult
} from '../src/provider-contract.mjs';
import { approveProviderReviewRequest, dispatchProviderReview } from '../src/provider-registry.mjs';
import {
  buildGrokInferenceProcess,
  buildGrokProviderEnvironment,
  reviewWithGrok
} from '../src/providers/grok.mjs';
import { buildOllamaProviderEnvironment, reviewWithOllama } from '../src/providers/ollama.mjs';
import { REVIEW_RESULT_SCHEMA } from '../src/review-schema.mjs';
import { canonicalJson } from '../src/state.mjs';
import { runProcess } from '../src/process.mjs';

const temporaryPaths = [];

const GROK_BUILTIN_AGENTS = Object.freeze([
  {
    name: 'general-purpose',
    description: 'General purpose agent for multi-step tasks.',
    source: { type: 'builtin' }
  },
  {
    name: 'explore',
    description: 'Fast, read-only agent specialized for codebase exploration.',
    source: { type: 'builtin' }
  },
  {
    name: 'plan',
    description: 'Software architect for planning implementation strategies.',
    source: { type: 'builtin' }
  }
]);

function grokInventory(overrides = {}) {
  return {
    projectInstructions: [],
    hooks: [],
    plugins: [],
    mcpServers: [],
    skills: [],
    agents: GROK_BUILTIN_AGENTS,
    lspServers: [],
    ...overrides
  };
}

test('Grok inference bridge keeps fixed shell source and provider argv separate', () => {
  const binary = '/tmp/Grok reviewer; literal/grok';
  const args = ['--prompt-file', 'prompt.pipe', '--model', 'model with spaces'];
  const fifoPath = '/tmp/Grok reviewer; literal/prompt.pipe';
  assert.deepEqual(buildGrokInferenceProcess(binary, args, { platform: 'linux', fifoPath }), {
    command: '/bin/sh',
    args: [
      '-c',
      `fifo=$1
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
exit "$consumer_status"`,
      'buddy-grok-stdin-bridge',
      fifoPath,
      '/usr/bin/mkfifo',
      '/bin/cat',
      '/bin/rm',
      binary,
      ...args
    ]
  });
  assert.deepEqual(buildGrokInferenceProcess(binary, args, { platform: 'win32' }), {
    command: binary,
    args
  });
});

test('Grok inference bridge rejects a failed prompt producer even when the consumer succeeds', {
  skip: process.platform === 'win32'
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-producer-failure-');
  const consumer = path.join(fixture, 'valid-empty-consumer.sh');
  await writeFile(consumer, '#!/bin/sh\n/bin/cat prompt.pipe >/dev/null\nprintf success\\n\n', { mode: 0o700 });
  const inference = buildGrokInferenceProcess(consumer, [], {
    platform: process.platform,
    fifoPath: path.join(fixture, 'prompt.pipe'),
    catBinary: '/usr/bin/false'
  });
  await assert.rejects(
    runProcess(inference.command, inference.args, {
      cwd: fixture,
      input: 'bounded packet',
      timeoutMs: 5_000
    }),
    /exited with code 1/
  );
});

test('Grok inference bridge terminates a blocked prompt producer after consumer failure', {
  skip: process.platform === 'win32',
  timeout: 5_000
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-consumer-failure-');
  const consumer = path.join(fixture, 'failing-consumer.sh');
  await writeFile(consumer, '#!/bin/sh\nexit 7\n', { mode: 0o700 });
  const inference = buildGrokInferenceProcess(consumer, [], {
    platform: process.platform,
    fifoPath: path.join(fixture, 'prompt.pipe')
  });
  await assert.rejects(
    runProcess(inference.command, inference.args, {
      cwd: fixture,
      input: 'bounded packet',
      timeoutMs: 2_000
    }),
    /exited with code 7/
  );
});

test('Grok inference bridge returns consumer failure after the prompt producer completes', {
  skip: process.platform === 'win32',
  timeout: 5_000
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-drained-failure-');
  const consumer = path.join(fixture, 'drained-failing-consumer.mjs');
  await writeFile(consumer, `import { readFileSync, writeFileSync } from 'node:fs';
readFileSync('prompt.pipe');
writeFileSync('prompt-drained.txt', 'drained');
setTimeout(() => process.exit(7), 100);
`);
  const inference = buildGrokInferenceProcess(process.execPath, [consumer], {
    platform: process.platform,
    fifoPath: path.join(fixture, 'prompt.pipe')
  });
  await assert.rejects(
    runProcess(inference.command, inference.args, {
      cwd: fixture,
      input: 'bounded packet',
      timeoutMs: 2_000
    }),
    /exited with code 7/
  );
  assert.equal(await readFile(path.join(fixture, 'prompt-drained.txt'), 'utf8'), 'drained');
});

test('Grok inference bridge rejects consumer success without opening the prompt FIFO', {
  skip: process.platform === 'win32',
  timeout: 10_000
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-unread-prompt-');
  const consumer = path.join(fixture, 'unread-success-consumer.sh');
  await writeFile(consumer, '#!/bin/sh\nprintf success\\n\n', { mode: 0o700 });
  const inference = buildGrokInferenceProcess(consumer, [], {
    platform: process.platform,
    fifoPath: path.join(fixture, 'prompt.pipe')
  });
  await assert.rejects(
    runProcess(inference.command, inference.args, {
      cwd: fixture,
      input: 'bounded packet',
      timeoutMs: 250
    }),
    /exceeded its 250 ms deadline/
  );
});

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function fakeExecutable(directory, name, source) {
  const file = path.join(directory, name);
  await writeFile(file, source);
  await chmod(file, 0o755);
  return file;
}

async function syntheticGrokAuth(directory) {
  const file = path.join(directory, 'synthetic-grok-auth.json');
  await writeFile(file, '{}\n', { mode: 0o600 });
  return file;
}

async function removeThenFailCleanup(target, options) {
  await rm(target, options);
  throw new Error('SECRET CLEANUP DIAGNOSTIC');
}

function reviewResult() {
  return {
    schema_version: '1',
    status: 'no_findings',
    summary: 'No validated defect.',
    findings: [],
    comments: []
  };
}

function technicalEvidence() {
  const patch = 'diff --git a/a.js b/a.js\n@@ -0,0 +1 @@\n+export const value = 1;\n';
  return {
    schema_version: '1',
    review_id: 'provider-schema-fixture',
    captured_at: new Date(0).toISOString(),
    repository_root: '/tmp/provider-schema-fixture',
    head: 'a'.repeat(40),
    scope: 'turn',
    base: 'b'.repeat(40),
    changed_paths: ['a.js'],
    excluded_paths: [],
    sensitive_change_count: 0,
    ignored_change_count: 0,
    path_evidence: [{
      path: 'a.js',
      disposition: 'complete',
      patch_bytes: Buffer.byteLength(patch),
      transmitted: true,
      hunk_ranges: [{ start: 1, end: 1 }]
    }],
    incomplete_paths: [],
    hunk_ranges: { 'a.js': [{ start: 1, end: 1 }] },
    status: 'provider schema fixture',
    patch_hash: createHash('sha256').update(patch).digest('hex'),
    patch_bytes: Buffer.byteLength(patch),
    truncated: false,
    patch,
    content_hashes: { 'a.js': 'c'.repeat(64) },
    line_counts: { 'a.js': 1 },
    old_line_counts: { 'a.js': null }
  };
}

test('Grok transport parser accepts only known envelopes and preserves complete spend metadata', () => {
  const expected = reviewResult();
  assert.deepEqual(parseGrokTransport(JSON.stringify(expected)).reviewPayload, expected);
  assert.deepEqual(
    parseGrokTransport(JSON.stringify({ structured_output: expected })).reviewPayload,
    expected
  );

  const parsed = parseGrokTransport(JSON.stringify({
    text: JSON.stringify(expected),
    stopReason: 'EndTurn',
    num_turns: 1,
    usage: {
      input_tokens: 120,
      cache_read_input_tokens: 40,
      output_tokens: 30,
      reasoning_tokens: 10,
      total_tokens: 190
    },
    total_cost_usd_ticks: 12345
  }));
  assert.deepEqual(parsed.reviewPayload, expected);
  assert.deepEqual(parsed.usage, {
    input_tokens: 120,
    cached_input_tokens: 40,
    output_tokens: 30,
    reasoning_tokens: 10,
    total_tokens: 190
  });
  assert.equal(parsed.usageComplete, true);
  assert.equal(parsed.costUsdTicks, 12345);

  assert.throws(
    () => parseGrokTransport(`\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``),
    /Unexpected token|not valid JSON/
  );
  assert.throws(
    () => parseGrokTransport(JSON.stringify({ text: JSON.stringify(expected), num_turns: 2 })),
    /one-turn/
  );
  assert.throws(
    () => parseGrokTransport(JSON.stringify({ type: 'error', message: 'private diagnostic' })),
    /error envelope/
  );
});

test('partial or incomplete Grok usage never becomes an exact cost claim', () => {
  const expected = reviewResult();
  for (const marker of ['cost_is_partial', 'usage_is_incomplete']) {
    const parsed = parseGrokTransport(JSON.stringify({
      text: JSON.stringify(expected),
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      total_cost_usd_ticks: 999,
      [marker]: true
    }));
    assert.equal(parsed.costUsdTicks, null);
    if (marker === 'usage_is_incomplete') assert.equal(parsed.usageComplete, false);
  }
});

test('provider result metadata is bounded to operational fields and omits provider content', () => {
  const output = providerResult({
    provider: 'fixture',
    model: 'fixture-model',
    stdout: 'private stdout',
    stderr: 'private stderr',
    reviewPayload: reviewResult(),
    durationMs: 12.6
  });
  assert.equal(output.run.duration_ms, 13);
  assert.equal(output.run.stdout_bytes, Buffer.byteLength('private stdout'));
  assert.equal(output.run.stderr_present, true);
  assert.doesNotMatch(JSON.stringify(output.run), /private stdout|private stderr|No validated defect/);
});

test('technical requests immutably bind the exact default response-schema digest', async () => {
  const fixture = await temporaryDirectory('codex-buddy-provider-schema-');
  const request = prepareReviewRequest(technicalEvidence(), { summaryGuardPacket: null });
  assert.notEqual(request.responseSchema, REVIEW_RESULT_SCHEMA);
  assert.deepEqual(request.responseSchema, REVIEW_RESULT_SCHEMA);
  assert.equal(Object.isFrozen(request.responseSchema), true);
  assert.equal(Object.isFrozen(request.responseSchema.properties), true);

  const configuration = {
    provider: 'ollama',
    model: 'schema-fixture',
    effort: 'high',
    timeout_ms: 2_000,
    min_confidence: 0.75,
    max_patch_bytes: 4_096
  };
  const dataDir = path.join(fixture, 'state');
  const approvedRequest = approveProviderReviewRequest(configuration.provider, {
    root: fixture,
    prompt: request.prompt,
    model: configuration.model,
    effort: configuration.effort,
    timeoutMs: configuration.timeout_ms,
    responseSchema: request.responseSchema
  }, {
    purpose: 'technical_review',
    summaryGuardPacket: request.summaryGuardPacket
  });
  const capability = await issueEgressCapability({
    root: fixture,
    dataDir,
    binding: {
      sessionKey: 'a'.repeat(24),
      turnKey: 'b'.repeat(24),
      reviewKey: 'c'.repeat(64),
      modeRevision: 1,
      provider: configuration.provider,
      model: configuration.model,
      effort: configuration.effort,
      timeoutMs: configuration.timeout_ms,
      configurationSha256: egressConfigurationHash(configuration),
      summaryConsentRevision: null,
      summarySha256: null
    },
    approvedRequest
  });
  const spent = await spendEgressCapability({ root: fixture, dataDir, capability }, async (boundRequest) => {
    assert.equal(boundRequest, approvedRequest);
    return 'bound';
  });
  const expectedDigest = createHash('sha256')
    .update(canonicalJson(REVIEW_RESULT_SCHEMA))
    .digest('hex');
  assert.equal(spent.audit.response_schema_sha256, expectedDigest);
});

test('dispatch cancellation remains outside approval binding and egress settles exactly once', async () => {
  const fixture = await temporaryDirectory('codex-buddy-provider-cancel-egress-');
  const configuration = {
    provider: 'ollama', model: 'cancel-fixture', effort: 'high', timeout_ms: 2_000,
    min_confidence: 0.75, max_patch_bytes: 4_096
  };
  const dataDir = path.join(fixture, 'state');
  const approvedRequest = approveProviderReviewRequest('ollama', {
    root: fixture,
    prompt: 'PRIVATE_PROVIDER_PROMPT',
    model: configuration.model,
    effort: configuration.effort,
    timeoutMs: configuration.timeout_ms,
    responseSchema: REVIEW_RESULT_SCHEMA
  });
  const capability = await issueEgressCapability({
    root: fixture,
    dataDir,
    binding: {
      sessionKey: 'd'.repeat(24), turnKey: 'e'.repeat(24), reviewKey: 'f'.repeat(64),
      modeRevision: 1, provider: configuration.provider, model: configuration.model,
      effort: configuration.effort, timeoutMs: configuration.timeout_ms,
      configurationSha256: egressConfigurationHash(configuration),
      summaryConsentRevision: null, summarySha256: null
    },
    approvedRequest
  });
  const controller = new AbortController();
  controller.abort('PRIVATE_ABORT_REASON');
  await assert.rejects(
    spendEgressCapability({ root: fixture, dataDir, capability }, (boundRequest) => {
      assert.equal(boundRequest, approvedRequest);
      return dispatchProviderReview(boundRequest, { platform: 'linux', signal: controller.signal });
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'cancelled');
      assert.equal(error.egressCapabilityStage, 'executor');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_ABORT_REASON|PRIVATE_PROVIDER_PROMPT/);
      return true;
    }
  );
  assert.equal((await readEgressRegistry({ root: fixture, dataDir })).active.length, 0);
  await assert.rejects(
    spendEgressCapability({ root: fixture, dataDir, capability }, async () => 'must not run'),
    /unknown or non-local capability/
  );
});

test('Grok forwards one dispatch signal through preflight and inference then cleans temporary state', async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-cancel-');
  const authPath = await syntheticGrokAuth(fixture);
  const fakeGrok = await fakeExecutable(fixture, 'grok', '#!/bin/sh\nexit 99\n');
  const controller = new AbortController();
  let calls = 0;
  let isolatedCwd;
  await assert.rejects(
    reviewWithGrok({
      root: fixture,
      prompt: 'packet',
      timeoutMs: 5_000,
      grokBin: fakeGrok,
      grokAuthPath: authPath,
      responseSchema: REVIEW_RESULT_SCHEMA,
      signal: controller.signal,
      runProcessImpl: async (_command, _args, options) => {
        calls += 1;
        isolatedCwd = options.cwd;
        assert.equal(options.signal, controller.signal);
        if (calls === 1) return { stdout: JSON.stringify(grokInventory()), stderr: '' };
        const error = new Error('PRIVATE cancellation diagnostic');
        error.kind = 'cancelled';
        error.code = 'ABORT_ERR';
        throw error;
      }
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'cancelled');
      assert.equal(error.stage, 'inference');
      assert.equal(error.message, 'The provider review was cancelled.');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
      return true;
    }
  );
  assert.equal(calls, 2);
  await assert.rejects(access(isolatedCwd));
});

test('provider adapters reject an omitted response schema before launching a process', async () => {
  await assert.rejects(
    reviewWithGrok({ root: process.cwd(), prompt: 'packet' }),
    /explicit response schema/
  );
  await assert.rejects(
    reviewWithOllama({ root: process.cwd(), prompt: 'packet', timeoutMs: 1_000 }),
    /explicit response schema/
  );
});

test('process containment failures map to stable provider failure categories', () => {
  assert.equal(processFailureCode({ kind: 'containment_failure' }), 'isolation_failed');
  assert.equal(processFailureCode({ kind: 'helper_unavailable' }), 'isolation_failed');
  assert.equal(processFailureCode({ kind: 'integrity_mismatch' }), 'isolation_failed');
  assert.equal(processFailureCode({ kind: 'control_protocol' }), 'isolation_failed');
  assert.equal(processFailureCode({ kind: 'deadline_exceeded' }), 'deadline_exceeded');
  assert.equal(processFailureCode({ kind: 'output_limit' }), 'output_limit_exceeded');
  assert.equal(processFailureCode({ kind: 'spawn_error', code: 'ENOENT' }), 'binary_missing');
});

test('Windows provider environments explicitly isolate Grok and preserve only intended Ollama profile inputs', () => {
  const ambient = {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\ambient-profile',
    APPDATA: 'C:\\ambient-profile\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\ambient-profile\\AppData\\Local',
    TEMP: 'C:\\ambient-temp',
    TMP: 'C:\\ambient-tmp',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    XAI_API_KEY: 'must-not-pass',
    OLLAMA_HOST: 'http://127.0.0.1:11434'
  };
  const grok = buildGrokProviderEnvironment({
    ambient,
    platform: 'win32',
    isolatedHome: 'D:\\Buddy\\profile',
    grokHome: 'D:\\Buddy\\grok',
    authPath: 'D:\\Buddy\\auth.json'
  });
  assert.equal(grok.USERPROFILE, 'D:\\Buddy\\profile');
  assert.equal(grok.APPDATA, 'D:\\Buddy\\profile\\AppData\\Roaming');
  assert.equal(grok.LOCALAPPDATA, 'D:\\Buddy\\profile\\AppData\\Local');
  assert.equal(grok.TEMP, 'D:\\Buddy\\profile\\AppData\\Local\\Temp');
  assert.equal(grok.TMP, grok.TEMP);
  assert.equal(grok.HOMEDRIVE, 'D:');
  assert.equal(grok.HOMEPATH, '\\Buddy\\profile');
  assert.equal(grok.SystemRoot, 'C:\\Windows');
  assert.equal(grok.XAI_API_KEY, undefined);

  const ollama = buildOllamaProviderEnvironment(ambient, 'win32');
  assert.equal(ollama.USERPROFILE, ambient.USERPROFILE);
  assert.equal(ollama.APPDATA, ambient.APPDATA);
  assert.equal(ollama.OLLAMA_HOST, ambient.OLLAMA_HOST);
  assert.equal(ollama.XAI_API_KEY, undefined);
});

test('Grok uses synthetic HOME and GROK_HOME with only the explicit auth-file bridge', {
  skip: process.platform === 'win32'
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-provider-');
  const authPath = path.join(fixture, 'explicit-auth.json');
  await writeFile(authPath, '{}\n', { mode: 0o600 });
  const fakeGrok = await fakeExecutable(fixture, 'grok', `#!/bin/sh
record_dir=\${0%/*}
if [ "$1" = "inspect" ]; then
  printf '%s\\n' '${JSON.stringify(grokInventory())}'
  exit 0
fi
printf '%s' "$HOME" > "$record_dir/home.txt"
printf '%s' "$GROK_HOME" > "$record_dir/grok-home.txt"
printf '%s' "$GROK_AUTH_PATH" > "$record_dir/auth-path.txt"
printf '%s' "\${XAI_API_KEY-unset}|\${GROK_CODE_XAI_API_KEY-unset}|\${GROK_AUTH-unset}" > "$record_dir/ambient-auth.txt"
: > "$record_dir/args.txt"
for arg in "$@"; do printf '%s\\n' "$arg" >> "$record_dir/args.txt"; done
previous=
prompt_file=
for arg in "$@"; do
  if [ "$previous" = "--prompt-file" ]; then prompt_file=$arg; fi
  previous=$arg
done
printf '%s' "$prompt_file" > "$record_dir/prompt-path.txt"
if [ -e "$PWD/review-prompt.txt" ]; then printf present; else printf absent; fi > "$record_dir/named-prompt.txt"
cat "$prompt_file" > "$record_dir/received-prompt.txt"
printf '%s\\n' '{"text":"{\\"schema_version\\":\\"1\\",\\"status\\":\\"no_findings\\",\\"summary\\":\\"No validated defect.\\",\\"findings\\":[],\\"comments\\":[]}","stopReason":"EndTurn","num_turns":1,"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15},"total_cost_usd_ticks":25}'
`);

  const previous = {
    XAI_API_KEY: process.env.XAI_API_KEY,
    GROK_CODE_XAI_API_KEY: process.env.GROK_CODE_XAI_API_KEY,
    GROK_AUTH: process.env.GROK_AUTH
  };
  process.env.XAI_API_KEY = 'must-not-pass';
  process.env.GROK_CODE_XAI_API_KEY = 'must-not-pass';
  process.env.GROK_AUTH = 'must-not-pass';
  try {
    const response = await reviewWithGrok({
      root: fixture,
      prompt: 'bounded packet',
      model: 'grok-4.5',
      effort: 'high',
      timeoutMs: 30_000,
      grokBin: fakeGrok,
      grokAuthPath: authPath,
      responseSchema: REVIEW_RESULT_SCHEMA
    });
    assert.deepEqual(JSON.parse(response.stdout), reviewResult());
    assert.deepEqual(response.reviewPayload, reviewResult());
    assert.equal(response.run.cost_usd_ticks, 25);
    assert.equal(response.run.usage.input_tokens, 10);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const isolatedHome = await readFile(path.join(fixture, 'home.txt'), 'utf8');
  const grokHome = await readFile(path.join(fixture, 'grok-home.txt'), 'utf8');
  assert.notEqual(isolatedHome, os.homedir());
  assert.notEqual(grokHome, path.join(os.homedir(), '.grok'));
  assert.equal(await readFile(path.join(fixture, 'auth-path.txt'), 'utf8'), authPath);
  assert.equal(await readFile(path.join(fixture, 'ambient-auth.txt'), 'utf8'), 'unset|unset|unset');
  await assert.rejects(access(isolatedHome));
  await assert.rejects(access(grokHome));
  const args = (await readFile(path.join(fixture, 'args.txt'), 'utf8')).trim().split('\n');
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.equal(args[args.indexOf('--max-turns') + 1], '1');
  assert.equal(args.includes('--no-subagents'), true);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--deny') + 1], '*');
  assert.match(args[args.indexOf('--disallowed-tools') + 1], /(?:^|,)Agent(?:,|$)/);
  assert.equal(args[args.indexOf('--prompt-file') + 1], '.grok-prompt.pipe');
  assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(REVIEW_RESULT_SCHEMA));
  assert.equal(await readFile(path.join(fixture, 'prompt-path.txt'), 'utf8'), '.grok-prompt.pipe');
  assert.equal(await readFile(path.join(fixture, 'named-prompt.txt'), 'utf8'), 'absent');
  assert.equal(await readFile(path.join(fixture, 'received-prompt.txt'), 'utf8'), 'bounded packet');
});

test('Grok refuses missing inventory fields and every discovered external surface before inference', {
  skip: process.platform === 'win32'
}, async () => {
  for (const [name, inventory] of [
    ['missing', { projectInstructions: [], hooks: [], plugins: [] }],
    ['missing-agents', { projectInstructions: [], hooks: [], plugins: [], mcpServers: [] }],
    ['empty-agents', grokInventory({ agents: [] })],
    ['skills', grokInventory({ skills: [{ name: 'external' }] })],
    ['agents', grokInventory({ agents: [{ name: 'external' }] })],
    ['spoofed-builtin-agent', grokInventory({ agents: [
      { name: 'general-purpose', description: 'Not built in', source: { type: 'project' } },
      { name: 'explore', description: 'Built in', source: { type: 'builtin' } },
      { name: 'plan', description: 'Built in', source: { type: 'builtin' } }
    ] })],
    ['extra-agent', grokInventory({ agents: [
      ...GROK_BUILTIN_AGENTS,
      { name: 'custom', description: 'External', source: { type: 'user' } }
    ] })],
    ['unknown-builtin', grokInventory({ agents: [
      GROK_BUILTIN_AGENTS[0],
      GROK_BUILTIN_AGENTS[1],
      { name: 'future', description: 'Future built in', source: { type: 'builtin' } }
    ] })],
    ['duplicate-agent', grokInventory({ agents: [
      GROK_BUILTIN_AGENTS[0],
      GROK_BUILTIN_AGENTS[1],
      GROK_BUILTIN_AGENTS[1]
    ] })],
    ['extra-source-metadata', grokInventory({ agents: [
      { ...GROK_BUILTIN_AGENTS[0], source: { type: 'builtin', path: '/not-safe' } },
      GROK_BUILTIN_AGENTS[1],
      GROK_BUILTIN_AGENTS[2]
    ] })],
    ['lsp', grokInventory({ lspServers: [{ name: 'external' }] })]
  ]) {
    const fixture = await temporaryDirectory(`codex-buddy-grok-${name}-`);
    const authPath = await syntheticGrokAuth(fixture);
    const fakeGrok = await fakeExecutable(fixture, 'grok', `#!/bin/sh
record_dir=\${0%/*}
if [ "$1" = "inspect" ]; then
  printf '%s\\n' '${JSON.stringify(inventory)}'
  exit 0
fi
: > "$record_dir/inference-started"
exit 0
`);
    await assert.rejects(
      reviewWithGrok({
        root: fixture,
        prompt: 'packet',
        timeoutMs: 5_000,
        grokBin: fakeGrok,
        grokAuthPath: authPath,
        responseSchema: REVIEW_RESULT_SCHEMA
      }),
      (error) => {
        assert.equal(error instanceof ProviderFailure, true);
        assert.equal(error.failureCode, 'isolation_failed');
        assert.equal(error.run.stage, 'preflight');
        assert.doesNotMatch(JSON.stringify(error.run), /external/);
        return true;
      }
    );
    await assert.rejects(access(path.join(fixture, 'inference-started')));
  }
});

test('Grok inference failure metadata is safe and the adapter never retries or falls back', {
  skip: process.platform === 'win32'
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-failure-');
  const authPath = await syntheticGrokAuth(fixture);
  const fakeGrok = await fakeExecutable(fixture, 'grok', `#!/bin/sh
record_dir=\${0%/*}
if [ "$1" = "inspect" ]; then
  printf '%s\\n' '${JSON.stringify(grokInventory())}'
  exit 0
fi
printf '%s\\n' called >> "$record_dir/calls.txt"
printf '%s\\n' 'SECRET PROVIDER DIAGNOSTIC' >&2
exit 7
`);
  await assert.rejects(
    reviewWithGrok({
      root: fixture,
      prompt: 'packet',
      timeoutMs: 5_000,
      grokBin: fakeGrok,
      grokAuthPath: authPath,
      responseSchema: REVIEW_RESULT_SCHEMA
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'transport_exit');
      assert.doesNotMatch(error.message, /SECRET/);
      assert.doesNotMatch(JSON.stringify(error), /SECRET/);
      return true;
    }
  );
  assert.equal((await readFile(path.join(fixture, 'calls.txt'), 'utf8')).trim().split('\n').length, 1);
});

test('Grok preserves a validated outcome and reports only bounded cleanup status', {
  skip: process.platform === 'win32'
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-cleanup-success-');
  const authPath = await syntheticGrokAuth(fixture);
  const fakeGrok = await fakeExecutable(fixture, 'grok', `#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf '%s\\n' '${JSON.stringify(grokInventory())}'
  exit 0
fi
/bin/cat .grok-prompt.pipe >/dev/null
printf '%s\\n' '${JSON.stringify({
    text: JSON.stringify(reviewResult()),
    stopReason: 'EndTurn',
    num_turns: 1
  })}'
`);

  const response = await reviewWithGrok({
    root: fixture,
    prompt: 'packet',
    timeoutMs: 5_000,
    grokBin: fakeGrok,
    grokAuthPath: authPath,
    responseSchema: REVIEW_RESULT_SCHEMA,
    cleanupImpl: removeThenFailCleanup
  });

  assert.deepEqual(response.reviewPayload, reviewResult());
  assert.equal(response.run.ok, true);
  assert.equal(response.run.cleanup_status, 'failed');
  assert.doesNotMatch(JSON.stringify(response.run), /SECRET|CLEANUP|codex-buddy-grok/);
});

test('Grok cleanup failure never replaces an inference failure', {
  skip: process.platform === 'win32'
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-cleanup-inference-');
  const authPath = await syntheticGrokAuth(fixture);
  const fakeGrok = await fakeExecutable(fixture, 'grok', `#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf '%s\\n' '${JSON.stringify(grokInventory())}'
  exit 0
fi
printf '%s\\n' 'SECRET PROVIDER DIAGNOSTIC' >&2
exit 7
`);

  await assert.rejects(
    reviewWithGrok({
      root: fixture,
      prompt: 'packet',
      timeoutMs: 5_000,
      grokBin: fakeGrok,
      grokAuthPath: authPath,
      responseSchema: REVIEW_RESULT_SCHEMA,
      cleanupImpl: removeThenFailCleanup
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'transport_exit');
      assert.equal(error.run.stage, 'inference');
      assert.doesNotMatch(error.message, /CLEANUP|SECRET/);
      assert.doesNotMatch(JSON.stringify(error), /CLEANUP|SECRET/);
      return true;
    }
  );
});

test('Grok remains fail closed when cleanup fails before any validated outcome', {
  skip: process.platform === 'win32'
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-cleanup-transport-');
  const authPath = await syntheticGrokAuth(fixture);
  const fakeGrok = await fakeExecutable(fixture, 'grok', `#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf '%s\\n' '${JSON.stringify(grokInventory())}'
  exit 0
fi
/bin/cat .grok-prompt.pipe >/dev/null
printf '%s\\n' 'not-json'
`);

  await assert.rejects(
    reviewWithGrok({
      root: fixture,
      prompt: 'packet',
      timeoutMs: 5_000,
      grokBin: fakeGrok,
      grokAuthPath: authPath,
      responseSchema: REVIEW_RESULT_SCHEMA,
      cleanupImpl: removeThenFailCleanup
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'invalid_transport_envelope');
      assert.equal(error.run.stage, 'transport');
      assert.doesNotMatch(error.message, /CLEANUP|SECRET/);
      return true;
    }
  );
});

test('Grok reports a missing executable with a stable safe failure code', async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-missing-');
  const authPath = await syntheticGrokAuth(fixture);
  await assert.rejects(
    reviewWithGrok({
      root: fixture,
      prompt: 'packet',
      timeoutMs: 5_000,
      grokBin: path.join(fixture, process.platform === 'win32' ? 'does-not-exist.exe' : 'does-not-exist'),
      grokAuthPath: authPath,
      responseSchema: REVIEW_RESULT_SCHEMA
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'binary_missing');
      assert.equal(error.run.stage, 'preflight');
      assert.match(error.message, /executable is unavailable/);
      return true;
    }
  );
});

test('Grok spends one aggregate timeout across preflight and inference', {
  skip: process.platform === 'win32'
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-grok-aggregate-timeout-');
  const inspected = path.join(fixture, 'inspected');
  const authPath = path.join(fixture, 'auth.json');
  await writeFile(authPath, '{}\n', { mode: 0o600 });
  const fakeGrok = await fakeExecutable(fixture, 'grok', `#!/bin/sh
record_dir=\${0%/*}
if [ "$1" = "inspect" ]; then
  : > "$record_dir/inspected"
  printf '%s\\n' '${JSON.stringify(grokInventory())}'
  exit 0
fi
: > "$record_dir/inference-started"
/bin/cat .grok-prompt.pipe >/dev/null
sleep 2
printf '%s\\n' '${JSON.stringify(reviewResult())}'
`);
  const fullBudget = await reviewWithGrok({
    root: fixture,
    prompt: 'packet',
    timeoutMs: 5_000,
    grokBin: fakeGrok,
    grokAuthPath: authPath,
    responseSchema: REVIEW_RESULT_SCHEMA,
    monotonicNow: () => 0
  });
  assert.deepEqual(fullBudget.reviewPayload, reviewResult());
  await Promise.all([
    rm(inspected, { force: true }),
    rm(path.join(fixture, 'inference-started'), { force: true })
  ]);
  await assert.rejects(
    reviewWithGrok({
      root: fixture,
      prompt: 'packet',
      timeoutMs: 5_000,
      grokBin: fakeGrok,
      grokAuthPath: authPath,
      responseSchema: REVIEW_RESULT_SCHEMA,
      monotonicNow: () => (existsSync(inspected) ? 3_900 : 0)
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'deadline_exceeded');
      assert.equal(error.run.stage, 'inference');
      assert.equal(error.run.duration_ms, 3_900);
      return true;
    }
  );
  await access(path.join(fixture, 'inference-started'));
});

test('Ollama runs from an attributed neutral cwd without repository discovery', {
  skip: process.platform === 'win32'
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-ollama-provider-');
  const workspace = path.join(fixture, 'workspace');
  const binaryDirectory = path.join(fixture, 'bin');
  const recordDirectory = path.join(fixture, 'records');
  await Promise.all([
    fsMkdir(workspace),
    fsMkdir(binaryDirectory),
    fsMkdir(recordDirectory)
  ]);
  await writeFile(path.join(workspace, '.ollama-project-config'), 'repository-local-config\n');
  const responseLine = `${JSON.stringify(reviewResult())}\n`;
  const fakeOllama = await fakeExecutable(binaryDirectory, 'ollama', `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const recordDirectory = ${JSON.stringify(recordDirectory)};
const cwd = process.cwd();
fs.writeFileSync(path.join(recordDirectory, 'cwd.txt'), cwd);
fs.writeFileSync(
  path.join(recordDirectory, 'repository-config-visible.txt'),
  String(fs.existsSync(path.join(cwd, '.ollama-project-config')))
);
fs.writeFileSync(
  path.join(recordDirectory, 'marker.json'),
  fs.readFileSync(path.join(cwd, '.codex-buddy-owner.json'))
);
fs.writeFileSync(path.join(recordDirectory, 'args.json'), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(recordDirectory, 'environment.json'), JSON.stringify({
  home: process.env.HOME,
  host: process.env.OLLAMA_HOST,
  noHistory: process.env.OLLAMA_NOHISTORY
}));
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(recordDirectory, 'received-prompt.txt'), prompt);
  process.stdout.write(${JSON.stringify(responseLine)});
});
`);
  const response = await reviewWithOllama({
    root: workspace,
    prompt: 'packet',
    model: 'qwen3.5:27b',
    timeoutMs: 5_000,
    ollamaBin: fakeOllama,
    responseSchema: REVIEW_RESULT_SCHEMA,
    ambientEnvironment: {
      PATH: process.env.PATH,
      HOME: '/synthetic/ollama-profile',
      OLLAMA_HOST: 'http://127.0.0.1:11434'
    }
  });
  assert.equal(JSON.parse(response.stdout).status, 'no_findings');
  assert.equal(response.run.ok, true);
  assert.equal(response.run.usage, null);
  assert.equal(response.run.cost_usd_ticks, null);
  const observedCwd = await readFile(path.join(recordDirectory, 'cwd.txt'), 'utf8');
  assert.notEqual(observedCwd, workspace);
  assert.match(path.basename(observedCwd), /^run-[0-9a-f]{32}$/u);
  assert.equal(
    await readFile(path.join(recordDirectory, 'repository-config-visible.txt'), 'utf8'),
    'false'
  );
  const markerText = await readFile(path.join(recordDirectory, 'marker.json'), 'utf8');
  const marker = JSON.parse(markerText);
  assert.equal(marker.schema, 'codex-buddy-provider-temp-v2');
  assert.equal(marker.provider, 'ollama');
  assert.match(marker.workspace_key, /^[0-9a-f]{16}$/u);
  assert.doesNotMatch(markerText, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  const args = JSON.parse(await readFile(path.join(recordDirectory, 'args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--think') + 1], 'high');
  assert.deepEqual(
    JSON.parse(args[args.indexOf('--format') + 1]),
    REVIEW_RESULT_SCHEMA
  );
  assert.ok(args.includes('--hidethinking'));
  assert.equal(await readFile(path.join(recordDirectory, 'received-prompt.txt'), 'utf8'), 'packet');
  assert.deepEqual(
    JSON.parse(await readFile(path.join(recordDirectory, 'environment.json'), 'utf8')),
    {
      home: '/synthetic/ollama-profile',
      host: 'http://127.0.0.1:11434',
      noHistory: '1'
    }
  );
  await assert.rejects(access(observedCwd));
  await assert.rejects(
    reviewWithOllama({
      root: workspace,
      prompt: 'packet',
      model: 'qwen3.5:27b',
      timeoutMs: 5_000,
      think: 'extreme',
      responseSchema: REVIEW_RESULT_SCHEMA
    }),
    /think setting/
  );
});

test('Ollama forwards dispatch cancellation and cleans isolated temporary state', async () => {
  const fixture = await temporaryDirectory('codex-buddy-ollama-cancel-');
  const controller = new AbortController();
  let isolatedCwd;
  await assert.rejects(
    reviewWithOllama({
      root: fixture,
      prompt: 'packet',
      model: 'glm-5.2:cloud',
      timeoutMs: 5_000,
      responseSchema: REVIEW_RESULT_SCHEMA,
      signal: controller.signal,
      runProcessImpl: async (_command, _args, options) => {
        isolatedCwd = options.cwd;
        assert.equal(options.signal, controller.signal);
        const error = new Error('PRIVATE cancellation diagnostic');
        error.kind = 'cancelled';
        error.code = 'ABORT_ERR';
        throw error;
      }
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'cancelled');
      assert.equal(error.stage, 'inference');
      assert.equal(error.message, 'The provider review was cancelled.');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
      return true;
    }
  );
  await assert.rejects(access(isolatedCwd));
});

test('Ollama removes its neutral cwd after an inference failure', {
  skip: process.platform === 'win32'
}, async () => {
  const fixture = await temporaryDirectory('codex-buddy-ollama-failure-');
  const workspace = path.join(fixture, 'workspace');
  const binaryDirectory = path.join(fixture, 'bin');
  const observedCwdFile = path.join(fixture, 'observed-cwd.txt');
  await Promise.all([fsMkdir(workspace), fsMkdir(binaryDirectory)]);
  const fakeOllama = await fakeExecutable(binaryDirectory, 'ollama-failure', `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(observedCwdFile)}, process.cwd());
process.stderr.write('synthetic provider failure\\n');
process.exit(23);
`);

  await assert.rejects(
    reviewWithOllama({
      root: workspace,
      prompt: 'packet',
      model: 'qwen3.5:27b',
      timeoutMs: 5_000,
      ollamaBin: fakeOllama,
      responseSchema: REVIEW_RESULT_SCHEMA
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.stage, 'inference');
      assert.equal(error.failureCode, 'transport_exit');
      assert.doesNotMatch(JSON.stringify(error.run), new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      return true;
    }
  );
  const observedCwd = await readFile(observedCwdFile, 'utf8');
  assert.notEqual(observedCwd, workspace);
  await assert.rejects(access(observedCwd));
});

test('Ollama reports cleanup failure without replacing a successful review', async () => {
  const fixture = await temporaryDirectory('codex-buddy-ollama-cleanup-');
  let observedCwd;
  const response = await reviewWithOllama({
    root: fixture,
    prompt: 'packet',
    model: 'qwen3.5:27b',
    timeoutMs: 5_000,
    responseSchema: REVIEW_RESULT_SCHEMA,
    runProcessImpl: async (_binary, _args, options) => {
      observedCwd = options.cwd;
      return { stdout: JSON.stringify(reviewResult()), stderr: '' };
    },
    cleanupImpl: removeThenFailCleanup
  });
  assert.equal(response.run.ok, true);
  assert.equal(response.run.cleanup_status, 'failed');
  assert.notEqual(observedCwd, fixture);
  await assert.rejects(access(observedCwd));
});
