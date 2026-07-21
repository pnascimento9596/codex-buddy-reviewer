import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import test from 'node:test';

import { ProviderFailure } from '../src/provider-contract.mjs';
import {
  buildClaudeProviderEnvironment,
  parseClaudeTransport,
  reviewWithClaude
} from '../src/providers/claude.mjs';
import { REVIEW_RESULT_SCHEMA } from '../src/review-schema.mjs';

function reviewResult() {
  return {
    schema_version: '1',
    status: 'no_findings',
    summary: 'No validated defect.',
    findings: [],
    comments: []
  };
}

function claudeEnvelope(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: reviewResult(),
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 40
    },
    ...overrides
  };
}

async function removeThenFailCleanup(target, options) {
  await rm(target, options);
  throw new Error('SECRET CLEANUP DIAGNOSTIC');
}

test('Claude invokes the verified isolated CLI contract with schema-bound stdin', async () => {
  const ambient = {
    PATH: '/usr/bin:/bin',
    HOME: '/private/fixture-home',
    USER: 'fixture-user',
    LOGNAME: 'fixture-user',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
    HTTPS_PROXY: 'http://proxy.invalid',
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth',
    ANTHROPIC_API_KEY: 'fixture-api-key',
    UNRELATED_SECRET: 'must-not-pass'
  };
  let isolatedCwd;
  let calls = 0;
  const runProcessImpl = async (command, args, options) => {
    calls += 1;
    isolatedCwd = options.cwd;
    await access(isolatedCwd);
    assert.equal(command, '/fixture/bin/claude');
    assert.deepEqual(args, [
      '--print',
      '--safe-mode',
      '--system-prompt', 'You are an independent read-only code reviewer. Analyze only the user-provided review packet. Do not request, infer, or disclose local machine, account, filesystem, repository, or environment information. Return only the structured response required by the supplied JSON schema.',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands',
      '--no-chrome',
      '--no-session-persistence',
      '--tools', '',
      '--permission-mode', 'plan',
      '--input-format', 'text',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(REVIEW_RESULT_SCHEMA),
      '--model', 'claude-opus-4-8',
      '--effort', 'high'
    ]);
    assert.equal(args.includes('--fallback-model'), false);
    assert.equal(args.includes('--append-system-prompt'), false);
    assert.equal(args.includes('bounded review packet'), false);
    assert.equal(options.input, 'bounded review packet');
    assert.equal(options.protectFromParentDeath, true);
    assert.equal(options.timeoutMs > 0 && options.timeoutMs <= 5_000, true);
    assert.equal(options.maxOutputBytes, 4 * 1024 * 1024);
    assert.deepEqual(options.env, {
      PATH: '/usr/bin:/bin',
      HOME: '/private/fixture-home',
      USER: 'fixture-user',
      LOGNAME: 'fixture-user',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy.invalid',
      CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth',
      ANTHROPIC_API_KEY: 'fixture-api-key',
      CLAUDE_CODE_SAFE_MODE: '1',
      NO_COLOR: '1',
      TERM: 'dumb'
    });
    assert.equal(options.env.UNRELATED_SECRET, undefined);
    return {
      stdout: JSON.stringify(claudeEnvelope()),
      stderr: JSON.stringify({ structured_output: { status: 'must-not-be-used' } })
    };
  };

  const response = await reviewWithClaude({
    root: '/private/repository-that-must-not-be-cwd',
    prompt: 'bounded review packet',
    model: 'claude-opus-4-8',
    effort: 'high',
    timeoutMs: 5_000,
    claudeBin: '/fixture/bin/claude',
    responseSchema: REVIEW_RESULT_SCHEMA,
    ambientEnvironment: ambient,
    platform: 'linux',
    runProcessImpl
  });

  assert.equal(calls, 1);
  assert.notEqual(isolatedCwd, '/private/repository-that-must-not-be-cwd');
  await assert.rejects(access(isolatedCwd));
  assert.deepEqual(response.reviewPayload, reviewResult());
  assert.deepEqual(JSON.parse(response.stdout), reviewResult());
  assert.equal(response.run.ok, true);
  assert.deepEqual(response.run.usage, {
    input_tokens: 120,
    cached_input_tokens: 30,
    output_tokens: 40,
    reasoning_tokens: null,
    total_tokens: 190
  });
  assert.equal(response.run.usage_complete, true);
  assert.equal(response.run.cost_usd_ticks, null);
});

test('Claude environment is allowlisted on Windows and does not forward unrelated credentials', () => {
  const result = buildClaudeProviderEnvironment({
    Path: 'C:\\Windows\\System32',
    HOME: 'C:\\fixture-home',
    USERPROFILE: 'C:\\fixture-home',
    APPDATA: 'C:\\fixture-home\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\fixture-home\\AppData\\Local',
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    SystemRoot: 'C:\\Windows',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token',
    AWS_SECRET_ACCESS_KEY: 'must-not-pass'
  }, 'win32');
  assert.equal(result.PATH, 'C:\\Windows\\System32');
  assert.equal(result.USERPROFILE, 'C:\\fixture-home');
  assert.equal(result.SystemRoot, 'C:\\Windows');
  assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-token');
  assert.equal(result.CLAUDE_CODE_SAFE_MODE, '1');
  assert.equal(result.AWS_SECRET_ACCESS_KEY, undefined);
});

test('Claude rejects a missing response schema before creating or running a process', async () => {
  let called = false;
  await assert.rejects(
    reviewWithClaude({
      root: '/tmp/repository',
      prompt: 'packet',
      runProcessImpl: async () => {
        called = true;
      }
    }),
    /explicit response schema/
  );
  assert.equal(called, false);
});

test('Claude transport accepts structured output objects and JSON strings with bounded usage', () => {
  const expected = reviewResult();
  assert.deepEqual(
    parseClaudeTransport(JSON.stringify(claudeEnvelope())).reviewPayload,
    expected
  );
  const parsed = parseClaudeTransport(JSON.stringify(claudeEnvelope({
    structured_output: JSON.stringify(expected),
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 5,
      output_tokens: 4,
      reasoning_tokens: 2,
      total_tokens: 19
    },
    usage_is_incomplete: true
  })));
  assert.deepEqual(parsed.reviewPayload, expected);
  assert.deepEqual(parsed.usage, {
    input_tokens: 10,
    cached_input_tokens: 5,
    output_tokens: 4,
    reasoning_tokens: 2,
    total_tokens: 19
  });
  assert.equal(parsed.usageComplete, false);
});

test('Claude transport accepts the bounded CLI event array only when one result is last', () => {
  const result = claudeEnvelope();
  const parsed = parseClaudeTransport(JSON.stringify([
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [] } },
    result
  ]));
  assert.deepEqual(parsed.reviewPayload, reviewResult());

  for (const malformed of [
    [],
    [result, { type: 'rate_limit_event' }],
    [result, result],
    [{ type: 'system' }, null, result]
  ]) {
    assert.throws(
      () => parseClaudeTransport(JSON.stringify(malformed)),
      /event array/
    );
  }
});

test('Claude refuses result-text and stderr fallbacks when structured output is missing', async () => {
  let isolatedCwd;
  await assert.rejects(
    reviewWithClaude({
      root: '/tmp/repository',
      prompt: 'packet',
      timeoutMs: 5_000,
      claudeBin: '/fixture/bin/claude',
      responseSchema: REVIEW_RESULT_SCHEMA,
      runProcessImpl: async (command, args, options) => {
        isolatedCwd = options.cwd;
        return {
          stdout: JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: JSON.stringify(reviewResult())
          }),
          stderr: JSON.stringify(claudeEnvelope())
        };
      }
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'invalid_transport_envelope');
      assert.equal(error.run.stage, 'transport');
      assert.doesNotMatch(error.message, /No validated defect/);
      return true;
    }
  );
  await assert.rejects(access(isolatedCwd));
});

test('Claude process failures are safe, single-shot, and clean the isolated directory', async () => {
  let calls = 0;
  let isolatedCwd;
  await assert.rejects(
    reviewWithClaude({
      root: '/tmp/repository',
      prompt: 'packet',
      timeoutMs: 5_000,
      claudeBin: '/fixture/bin/claude',
      responseSchema: REVIEW_RESULT_SCHEMA,
      runProcessImpl: async (command, args, options) => {
        calls += 1;
        isolatedCwd = options.cwd;
        const error = new Error('SECRET PROVIDER DIAGNOSTIC');
        error.code = 'ENOENT';
        throw error;
      }
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'binary_missing');
      assert.equal(error.run.stage, 'inference');
      assert.doesNotMatch(error.message, /SECRET/);
      assert.doesNotMatch(JSON.stringify(error), /SECRET/);
      return true;
    }
  );
  assert.equal(calls, 1);
  await assert.rejects(access(isolatedCwd));
});

test('Claude forwards dispatch cancellation and cleans isolated temporary state', async () => {
  const controller = new AbortController();
  let isolatedCwd;
  await assert.rejects(
    reviewWithClaude({
      root: '/tmp/repository',
      prompt: 'packet',
      timeoutMs: 5_000,
      claudeBin: '/fixture/bin/claude',
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

test('Claude preserves a validated outcome and reports only bounded cleanup status', async () => {
  const response = await reviewWithClaude({
    root: '/tmp/repository',
    prompt: 'packet',
    timeoutMs: 5_000,
    claudeBin: '/fixture/bin/claude',
    responseSchema: REVIEW_RESULT_SCHEMA,
    runProcessImpl: async () => ({
      stdout: JSON.stringify(claudeEnvelope()),
      stderr: ''
    }),
    cleanupImpl: removeThenFailCleanup
  });

  assert.deepEqual(response.reviewPayload, reviewResult());
  assert.equal(response.run.ok, true);
  assert.equal(response.run.cleanup_status, 'failed');
  assert.doesNotMatch(JSON.stringify(response.run), /SECRET|CLEANUP|codex-buddy-claude/);
});

test('Claude cleanup failure never replaces an inference failure', async () => {
  await assert.rejects(
    reviewWithClaude({
      root: '/tmp/repository',
      prompt: 'packet',
      timeoutMs: 5_000,
      claudeBin: '/fixture/bin/claude',
      responseSchema: REVIEW_RESULT_SCHEMA,
      runProcessImpl: async () => {
        const error = new Error('SECRET PROVIDER DIAGNOSTIC');
        error.code = 'ENOENT';
        throw error;
      },
      cleanupImpl: removeThenFailCleanup
    }),
    (error) => {
      assert.equal(error instanceof ProviderFailure, true);
      assert.equal(error.failureCode, 'binary_missing');
      assert.equal(error.run.stage, 'inference');
      assert.doesNotMatch(error.message, /CLEANUP|SECRET/);
      assert.doesNotMatch(JSON.stringify(error), /CLEANUP|SECRET/);
      return true;
    }
  );
});

test('Claude remains fail closed when cleanup fails before any validated outcome', async () => {
  await assert.rejects(
    reviewWithClaude({
      root: '/tmp/repository',
      prompt: 'packet',
      timeoutMs: 5_000,
      claudeBin: '/fixture/bin/claude',
      responseSchema: REVIEW_RESULT_SCHEMA,
      runProcessImpl: async () => ({
        stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
        stderr: ''
      }),
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

test('Claude rejects malformed or unsuccessful envelopes', () => {
  assert.throws(() => parseClaudeTransport('[]'), /event array/);
  assert.throws(
    () => parseClaudeTransport(JSON.stringify(claudeEnvelope({ subtype: 'error', is_error: true }))),
    /successful result envelope/
  );
  assert.throws(
    () => parseClaudeTransport(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, structured_output: []
    })),
    /structured output/
  );
});
