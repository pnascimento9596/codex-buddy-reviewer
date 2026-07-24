import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProviderFailure } from '../src/provider-contract.mjs';
import {
  buildOpenCodeProviderEnvironment,
  parseOpenCodeTransport,
  reviewWithOpenCode
} from '../src/providers/opencode.mjs';
import { REVIEW_RESULT_SCHEMA } from '../src/review-schema.mjs';

function reviewResult(summary = 'No validated defect.') {
  return {
    schema_version: '2',
    status: 'no_findings',
    summary,
    findings: [],
    comments: []
  };
}

function event(type, fields = {}) {
  return JSON.stringify({ type, timestamp: 1, sessionID: 'session-fixture', ...fields });
}

function completedText(value, end = 2) {
  return event('text', {
    part: { type: 'text', text: value, time: { start: 1, end } }
  });
}

async function removeThenFailCleanup(target, options) {
  await rm(target, options);
  throw new Error('SECRET OPENCODE CLEANUP DIAGNOSTIC');
}

test('OpenCode uses an empty private cwd, isolated config, denied tools, and stdin-only prompt transport', async () => {
  const prompt = 'bounded immutable evidence packet';
  const expected = reviewResult();
  let captured;
  const ambient = {
    PATH: '/fixture/bin',
    HOME: '/fixture/home',
    PWD: '/private/repository-that-must-not-be-root',
    OPENCODE_CONFIG: '/must/not/load.json',
    OPENCODE_TUI_CONFIG: '/must/not/load-tui.json',
    OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow"}}',
    OPENCODE_PERMISSION: '{"*":"allow"}',
    OPENCODE_AUTH_CONTENT: '{"anthropic":{"type":"oauth","refresh":"fixture","access":"fixture","expires":1}}',
    ANTHROPIC_API_KEY: 'provider-auth-remains-available'
  };
  const run = async (command, args, options) => {
    captured = { command, args, options };
    assert.equal(command, '/fixture/bin/opencode');
    assert.deepEqual(await readdir(options.cwd), []);
    assert.deepEqual(await readdir(options.env.OPENCODE_CONFIG_DIR), []);
    return {
      stdout: [
        event('step_start', { part: { type: 'step-start' } }),
        completedText(JSON.stringify(expected)),
        event('step_finish', { part: { type: 'step-finish', reason: 'stop' } })
      ].join('\n'),
      stderr: ''
    };
  };

  const result = await reviewWithOpenCode({
    root: '/private/repository-that-must-not-be-cwd',
    prompt,
    model: 'anthropic/claude-opus-4-6',
    effort: 'high',
    timeoutMs: 12_345,
    opencodeBin: '/fixture/bin/opencode',
    responseSchema: REVIEW_RESULT_SCHEMA,
    ambient,
    run
  });

  assert.deepEqual(result.reviewPayload, expected);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(result.provider, 'opencode');
  assert.equal(result.model, 'anthropic/claude-opus-4-6');
  assert.equal(result.run.ok, true);

  const { args, options } = captured;
  assert.equal(args[0], 'run');
  assert.equal(args[1], '--pure');
  const agentName = args[args.indexOf('--agent') + 1];
  assert.match(agentName, /^buddy-review-[0-9a-f]{48}$/u);
  assert.deepEqual(args, [
    'run',
    '--pure',
    '--agent', agentName,
    '--model', 'anthropic/claude-opus-4-6',
    '--variant', 'high',
    '--format', 'json'
  ]);
  assert.equal(args.includes(prompt), false);
  assert.equal(JSON.stringify(args).includes(prompt), false);
  assert.equal(options.input, prompt);
  assert.equal(options.cwd, path.join(path.dirname(options.cwd), 'work'));
  assert.notEqual(options.cwd, '/private/repository-that-must-not-be-cwd');
  assert.equal(options.env.OPENCODE_CONFIG_DIR, path.join(path.dirname(options.cwd), 'config'));
  assert.equal(options.env.PWD, options.cwd);
  assert.equal(options.env.XDG_CONFIG_HOME, options.env.OPENCODE_CONFIG_DIR);
  assert.equal(options.env.XDG_DATA_HOME, path.join(path.dirname(options.cwd), 'data'));
  assert.equal(options.env.XDG_CACHE_HOME, path.join(path.dirname(options.cwd), 'cache'));
  assert.equal(options.env.XDG_STATE_HOME, path.join(path.dirname(options.cwd), 'state'));
  assert.equal(options.env.TMPDIR, path.join(path.dirname(options.cwd), 'tmp'));
  assert.equal(options.env.TEMP, options.env.TMPDIR);
  assert.equal(options.env.TMP, options.env.TMPDIR);
  assert.equal(options.timeoutMs > 0 && options.timeoutMs <= 12_345, true);
  assert.equal(options.maxOutputBytes, 4 * 1024 * 1024);
  assert.equal(options.protectFromParentDeath, true);

  const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.autoupdate, false);
  assert.equal(config.share, 'disabled');
  assert.deepEqual(config.instructions, []);
  assert.deepEqual(config.plugin, []);
  assert.deepEqual(config.mcp, {});
  assert.equal(config.permission['*'], 'deny');
  assert.equal(Object.values(config.permission).every((permission) => permission === 'deny'), true);
  assert.deepEqual(Object.keys(config.agent), [agentName]);
  assert.equal(config.agent[agentName].mode, 'primary');
  assert.equal(config.agent[agentName].permission['*'], 'deny');
  assert.equal(Object.values(config.agent[agentName].permission).every((permission) => permission === 'deny'), true);
  assert.equal(Object.values(config.agent[agentName].tools).every((allowed) => allowed === false), true);
  for (const tool of ['bash', 'edit', 'read', 'task', 'webfetch', 'websearch', 'write']) {
    assert.equal(config.agent[agentName].tools[tool], false);
  }
  const permissions = JSON.parse(options.env.OPENCODE_PERMISSION);
  assert.equal(permissions['*'], 'deny');
  assert.equal(Object.values(permissions).every((permission) => permission === 'deny'), true);
  assert.equal(options.env.OPENCODE_PURE, 'true');
  assert.equal(options.env.OPENCODE_AUTO_SHARE, 'false');
  assert.equal(options.env.OPENCODE_DISABLE_SHARE, 'true');
  assert.equal(options.env.OPENCODE_DISABLE_AUTOUPDATE, 'true');
  // First-party providers require default plugins; pure mode covers externals.
  assert.equal(options.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, undefined);
  assert.equal(options.env.OPENCODE_DISABLE_CLAUDE_CODE, 'true');
  assert.equal(options.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT, 'true');
  assert.equal(options.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, 'true');
  assert.equal(options.env.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
  assert.equal(options.env.OPENCODE_DISABLE_LSP_DOWNLOAD, 'true');
  assert.equal(options.env.OPENCODE_CONFIG, undefined);
  assert.equal(options.env.OPENCODE_TUI_CONFIG, undefined);
  assert.equal(options.env.OPENCODE_DB, undefined);
  assert.deepEqual(JSON.parse(options.env.OPENCODE_AUTH_CONTENT), {
    anthropic: JSON.parse(ambient.OPENCODE_AUTH_CONTENT).anthropic
  });
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(options.env.HOME, options.cwd);
  assert.equal(options.env.OPENCODE_CONFIG_CONTENT.includes(prompt), false);
  await assert.rejects(access(options.cwd));
  await assert.rejects(access(options.env.OPENCODE_CONFIG_DIR));
});

test('OpenCode spends one aggregate timeout across preflight and inference', async () => {
  let now = -100;
  let calls = 0;
  const result = await reviewWithOpenCode({
    root: '/private/repository',
    prompt: 'packet',
    model: 'openai/gpt-5.4',
    timeoutMs: 1_000,
    responseSchema: REVIEW_RESULT_SCHEMA,
    ambient: {
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api","key":"fixture"}}'
    },
    monotonicNow: () => {
      now += 100;
      return now;
    },
    run: async (_command, _args, options) => {
      calls += 1;
      assert.equal(options.timeoutMs, 500);
      return { stdout: completedText(JSON.stringify(reviewResult())), stderr: '' };
    }
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.reviewPayload, reviewResult());
});

test('OpenCode fails with a safe preflight deadline before provider dispatch', async () => {
  let now = -200;
  let calls = 0;
  let cleanedRoot;
  await assert.rejects(
    reviewWithOpenCode({
      root: '/private/repository',
      prompt: 'packet',
      model: 'openai/gpt-5.4',
      timeoutMs: 150,
      responseSchema: REVIEW_RESULT_SCHEMA,
      ambient: { PATH: '/fixture/bin', HOME: '/fixture/home' },
      monotonicNow: () => {
        now += 200;
        return now;
      },
      run: async () => { calls += 1; },
      cleanupImpl: async (target, options) => {
        cleanedRoot = target;
        await rm(target, options);
      }
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'deadline_exceeded');
      assert.equal(error.stage, 'preflight');
      assert.equal(error.run.stage, 'preflight');
      assert.doesNotMatch(error.message, /codex-buddy-opencode|auth|fixture/i);
      return true;
    }
  );
  assert.equal(calls, 0);
  assert.match(cleanedRoot, /codex-buddy-provider-v1-.+[\\/]run-[0-9a-f]{32}$/u);
  await assert.rejects(access(cleanedRoot));
});

test('OpenCode checks the aggregate deadline within auth-file preflight boundaries', async () => {
  const sourceData = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-opencode-auth-deadline-'));
  const sourceAuthDir = path.join(sourceData, 'opencode');
  const sourceAuthFile = path.join(sourceAuthDir, 'auth.json');
  let now = -10;
  let calls = 0;
  try {
    await mkdir(sourceAuthDir, { mode: 0o700 });
    await writeFile(sourceAuthFile, 'SECRET MALFORMED AUTH CONTENT', { mode: 0o600 });
    await assert.rejects(
      reviewWithOpenCode({
        root: '/private/repository',
        prompt: 'packet',
        model: 'openai/gpt-5.4',
        timeoutMs: 45,
        responseSchema: REVIEW_RESULT_SCHEMA,
        ambient: { PATH: '/fixture/bin', HOME: '/fixture/home', XDG_DATA_HOME: sourceData },
        monotonicNow: () => {
          now += 10;
          return now;
        },
        run: async () => { calls += 1; }
      }),
      (error) => {
        assert.equal(error instanceof ProviderFailure, true);
        assert.equal(error.failureCode, 'deadline_exceeded');
        assert.equal(error.stage, 'preflight');
        assert.doesNotMatch(error.message, /SECRET|MALFORMED|auth content/i);
        assert.doesNotMatch(JSON.stringify(error), /SECRET|MALFORMED/);
        return true;
      }
    );
    assert.equal(calls, 0);
  } finally {
    await rm(sourceData, { recursive: true, force: true });
  }
});

test('OpenCode environment overrides ambient capability-enabling values', () => {
  const env = buildOpenCodeProviderEnvironment({
    ambient: {
      OPENCODE_AUTO_SHARE: 'true',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'false',
      OPENCODE_DISABLE_LSP_DOWNLOAD: 'false',
      OPENCODE_ENABLE_EXA: 'true',
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true',
      OPENCODE_PERMISSION: '{"*":"allow"}',
      SECRET_TOKEN: 'must-not-forward',
      ANTHROPIC_API_KEY: 'must-not-forward'
    },
    configDir: '/private/config',
    workDir: '/private/work',
    dataDir: '/private/data',
    cacheDir: '/private/cache',
    stateDir: '/private/state',
    tempDir: '/private/tmp',
    agentName: 'buddy-review-fixture'
  });
  assert.equal(env.OPENCODE_AUTO_SHARE, 'false');
  // Ambient OPENCODE_DISABLE_DEFAULT_PLUGINS must not be forwarded: forcing it
  // breaks first-party provider/model resolution (xai/grok-4.5 etc.).
  assert.equal(env.OPENCODE_DISABLE_DEFAULT_PLUGINS, undefined);
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, 'true');
  assert.equal(env.OPENCODE_DISABLE_LSP_DOWNLOAD, 'true');
  assert.equal(env.OPENCODE_ENABLE_EXA, 'false');
  assert.equal(env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, 'false');
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.notEqual(env.OPENCODE_PERMISSION, '{"*":"allow"}');
});

test('OpenCode env allowlist does not widen when ambient enables default plugins disable', () => {
  const env = buildOpenCodeProviderEnvironment({
    ambient: {
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow"}}',
      EXTRA_ENV: 'nope'
    },
    configDir: '/private/config',
    workDir: '/private/work',
    dataDir: '/private/data',
    cacheDir: '/private/cache',
    stateDir: '/private/state',
    tempDir: '/private/tmp',
    agentName: 'buddy-review-fixture'
  });
  const keys = Object.keys(env).sort();
  assert.equal(keys.includes('EXTRA_ENV'), false);
  assert.equal(keys.includes('OPENCODE_DISABLE_DEFAULT_PLUGINS'), false);
  assert.equal(keys.includes('OPENCODE_PURE'), true);
  assert.equal(env.OPENCODE_PURE, 'true');
});

test('OpenCode bridges stored auth into isolated runtime data without copying prompt state back', async () => {
  const sourceData = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-opencode-auth-source-'));
  const sourceAuthDir = path.join(sourceData, 'opencode');
  const sourceAuthFile = path.join(sourceAuthDir, 'auth.json');
  const authContent = '{"openai":{"type":"api","key":"fixture"},"xai":{"type":"oauth","access":"must-not-leave"}}\n';
  await mkdir(sourceAuthDir, { mode: 0o700 });
  await writeFile(sourceAuthFile, authContent, { mode: 0o600 });
  let isolatedData;
  try {
    await reviewWithOpenCode({
      root: '/private/repository',
      prompt: 'packet',
      model: 'openai/gpt-5.4',
      responseSchema: REVIEW_RESULT_SCHEMA,
      ambient: { PATH: '/fixture/bin', HOME: '/fixture/home', XDG_DATA_HOME: sourceData },
      run: async (_command, _args, options) => {
        isolatedData = options.env.XDG_DATA_HOME;
        assert.notEqual(isolatedData, sourceData);
        assert.deepEqual(JSON.parse(options.env.OPENCODE_AUTH_CONTENT), {
          openai: { type: 'api', key: 'fixture' }
        });
        assert.doesNotMatch(options.env.OPENCODE_AUTH_CONTENT, /must-not-leave|xai/);
        assert.deepEqual(await readdir(isolatedData), []);
        return { stdout: completedText(JSON.stringify(reviewResult())), stderr: '' };
      }
    });
    await assert.rejects(access(isolatedData));
    assert.equal(await readFile(sourceAuthFile, 'utf8'), authContent);
  } finally {
    await rm(sourceData, { recursive: true, force: true });
  }
});

test('OpenCode rejects unsafe or malformed authentication stores before provider dispatch', async () => {
  const sourceData = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-opencode-auth-unsafe-'));
  const sourceAuthDir = path.join(sourceData, 'opencode');
  const sourceAuthFile = path.join(sourceAuthDir, 'auth.json');
  const symlinkTarget = path.join(sourceData, 'actual-auth.json');
  let calls = 0;
  const run = async () => { calls += 1; };
  try {
    await mkdir(sourceAuthDir, { mode: 0o700 });
    await writeFile(sourceAuthFile, 'not-json', { mode: 0o600 });
    await assert.rejects(
      reviewWithOpenCode({
        root: '/private/repository', prompt: 'packet', model: 'openai/gpt-5.4',
        responseSchema: REVIEW_RESULT_SCHEMA,
        ambient: { PATH: '/fixture/bin', HOME: '/fixture/home', XDG_DATA_HOME: sourceData },
        run
      }),
      (error) => error instanceof ProviderFailure && error.failureCode === 'isolation_failed'
    );
    await rm(sourceAuthFile);
    await writeFile(symlinkTarget, '{"openai":{"type":"api","key":"fixture"}}', { mode: 0o600 });
    await symlink(symlinkTarget, sourceAuthFile);
    await assert.rejects(
      reviewWithOpenCode({
        root: '/private/repository', prompt: 'packet', model: 'openai/gpt-5.4',
        responseSchema: REVIEW_RESULT_SCHEMA,
        ambient: { PATH: '/fixture/bin', HOME: '/fixture/home', XDG_DATA_HOME: sourceData },
        run
      }),
      (error) => error instanceof ProviderFailure && error.failureCode === 'isolation_failed'
    );
    assert.equal(calls, 0);
  } finally {
    await rm(sourceData, { recursive: true, force: true });
  }
});

test('OpenCode JSONL transport selects the final completed non-empty text event', () => {
  const first = reviewResult('First completed response.');
  const final = reviewResult('Final completed response.');
  const stdout = [
    event('step_start', { part: { type: 'step-start' } }),
    event('text', { part: { type: 'text', text: JSON.stringify(first), time: { start: 1 } } }),
    completedText('   '),
    completedText(JSON.stringify(first), 3),
    event('step_finish', { part: { type: 'step-finish', reason: 'stop' } }),
    completedText(JSON.stringify(final), 4),
    ''
  ].join('\r\n');
  assert.deepEqual(parseOpenCodeTransport(stdout).reviewPayload, final);
});

test('OpenCode rejects tool, error, malformed, unknown, and incomplete transports', () => {
  const expected = reviewResult();
  for (const [name, stdout, pattern] of [
    [
      'tool use before valid output',
      [event('tool_use', { part: { type: 'tool', tool: 'read' } }), completedText(JSON.stringify(expected))].join('\n'),
      /denied tool/
    ],
    [
      'tool use after valid output',
      [completedText(JSON.stringify(expected)), event('tool_use', { part: { type: 'tool', tool: 'bash' } })].join('\n'),
      /denied tool/
    ],
    [
      'error event',
      event('error', { error: { name: 'private diagnostic' } }),
      /error event/
    ],
    ['malformed JSONL', '{not-json}\n', /invalid JSON event/],
    ['unknown event', event('reasoning', { part: { type: 'reasoning' } }), /unknown event/],
    [
      'incomplete text',
      event('text', { part: { type: 'text', text: JSON.stringify(expected), time: { start: 1 } } }),
      /no completed text/
    ],
    ['empty output', '\n', /did not contain JSON events/],
    ['non-object result', completedText('[]'), /must be one object/],
    ['markdown result', completedText('```json\n{}\n```'), /not valid review JSON/]
  ]) {
    assert.throws(() => parseOpenCodeTransport(stdout), pattern, name);
  }
});

test('OpenCode maps denied tool events to a safe typed transport failure and cleans up', async () => {
  let workDir;
  let configDir;
  await assert.rejects(
    reviewWithOpenCode({
      root: '/private/repository',
      prompt: 'packet',
      model: 'xai/grok-4.5',
      responseSchema: REVIEW_RESULT_SCHEMA,
      run: async (_command, _args, options) => {
        workDir = options.cwd;
        configDir = options.env.OPENCODE_CONFIG_DIR;
        return {
          stdout: [
            completedText(JSON.stringify(reviewResult())),
            event('tool_use', { part: { type: 'tool', tool: 'read', state: { status: 'completed' } } })
          ].join('\n'),
          stderr: 'PRIVATE PROVIDER DIAGNOSTIC'
        };
      }
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.provider, 'opencode');
      assert.equal(error.failureCode, 'invalid_transport_envelope');
      assert.equal(error.stage, 'transport');
      assert.doesNotMatch(error.message, /PRIVATE|read/);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE|read/);
      return true;
    }
  );
  await assert.rejects(access(workDir));
  await assert.rejects(access(configDir));
});

test('OpenCode maps process failures without retrying and cleans up temporary state', async () => {
  let calls = 0;
  let workDir;
  let configDir;
  await assert.rejects(
    reviewWithOpenCode({
      root: '/private/repository',
      prompt: 'packet',
      model: 'openai/gpt-5.4',
      responseSchema: REVIEW_RESULT_SCHEMA,
      run: async (_command, _args, options) => {
        calls += 1;
        workDir = options.cwd;
        configDir = options.env.OPENCODE_CONFIG_DIR;
        const error = new Error('PRIVATE timeout diagnostic');
        error.kind = 'deadline_exceeded';
        throw error;
      }
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'deadline_exceeded');
      assert.equal(error.stage, 'inference');
      assert.doesNotMatch(error.message, /PRIVATE/);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
      return true;
    }
  );
  assert.equal(calls, 1);
  await assert.rejects(access(workDir));
  await assert.rejects(access(configDir));
});

test('OpenCode forwards dispatch cancellation and cleans isolated temporary state', async () => {
  const controller = new AbortController();
  let workDir;
  await assert.rejects(
    reviewWithOpenCode({
      root: '/private/repository',
      prompt: 'packet',
      model: 'openai/gpt-5.4',
      responseSchema: REVIEW_RESULT_SCHEMA,
      signal: controller.signal,
      run: async (_command, _args, options) => {
        workDir = options.cwd;
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
  await assert.rejects(access(workDir));
});

test('OpenCode preserves a validated outcome and reports only bounded cleanup status', async () => {
  const response = await reviewWithOpenCode({
    root: '/private/repository',
    prompt: 'packet',
    model: 'openai/gpt-5.4',
    responseSchema: REVIEW_RESULT_SCHEMA,
    ambient: {
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api","key":"SECRET_AUTH_CONTENT"}}'
    },
    run: async () => ({
      stdout: completedText(JSON.stringify(reviewResult())),
      stderr: ''
    }),
    cleanupImpl: removeThenFailCleanup
  });

  assert.deepEqual(response.reviewPayload, reviewResult());
  assert.equal(response.run.ok, true);
  assert.equal(response.run.cleanup_status, 'failed');
  assert.doesNotMatch(
    JSON.stringify(response.run),
    /SECRET|CLEANUP|AUTH_CONTENT|codex-buddy-opencode/
  );
});

test('OpenCode cleanup failure never replaces inference or preflight failures', async () => {
  await assert.rejects(
    reviewWithOpenCode({
      root: '/private/repository',
      prompt: 'packet',
      model: 'openai/gpt-5.4',
      responseSchema: REVIEW_RESULT_SCHEMA,
      run: async () => {
        const error = new Error('SECRET OPENCODE INFERENCE DIAGNOSTIC');
        error.kind = 'deadline_exceeded';
        throw error;
      },
      cleanupImpl: removeThenFailCleanup
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'deadline_exceeded');
      assert.equal(error.stage, 'inference');
      assert.doesNotMatch(error.message, /SECRET|CLEANUP|DIAGNOSTIC/);
      assert.doesNotMatch(JSON.stringify(error), /SECRET|CLEANUP|DIAGNOSTIC/);
      return true;
    }
  );

  await assert.rejects(
    reviewWithOpenCode({
      root: '/private/repository',
      prompt: 'packet',
      model: 'openai/gpt-5.4',
      responseSchema: REVIEW_RESULT_SCHEMA,
      ambient: {
        PATH: '/fixture/bin',
        HOME: '/fixture/home',
        OPENCODE_AUTH_CONTENT: 'SECRET MALFORMED AUTH CONTENT'
      },
      run: async () => { throw new Error('must not run'); },
      cleanupImpl: removeThenFailCleanup
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'isolation_failed');
      assert.equal(error.stage, 'preflight');
      assert.doesNotMatch(error.message, /SECRET|CLEANUP|MALFORMED|AUTH CONTENT/);
      assert.doesNotMatch(JSON.stringify(error), /SECRET|CLEANUP|MALFORMED|AUTH CONTENT/);
      return true;
    }
  );
});

test('OpenCode validates schema and provider/model inputs before launching a process', async () => {
  let calls = 0;
  const run = async () => {
    calls += 1;
    throw new Error('must not run');
  };
  await assert.rejects(
    reviewWithOpenCode({ prompt: 'packet', model: 'openai/gpt-5.4', run }),
    /explicit response schema/
  );
  await assert.rejects(
    reviewWithOpenCode({ prompt: 'packet', model: 'missing-provider', responseSchema: REVIEW_RESULT_SCHEMA, run }),
    /provider\/model form/
  );
  await assert.rejects(
    reviewWithOpenCode({ prompt: 'packet', model: 'openai/gpt 5', responseSchema: REVIEW_RESULT_SCHEMA, run }),
    /printable ASCII token/
  );
  assert.equal(calls, 0);
});
