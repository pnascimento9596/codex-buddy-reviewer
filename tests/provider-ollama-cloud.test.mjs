import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProviderFailure } from '../src/provider-contract.mjs';
import { ollamaFormatForModel, reviewWithOllama } from '../src/providers/ollama.mjs';

const RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['ok'] }
  }
});

const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-ollama-cloud-'));
  temporaryPaths.push(directory);
  return directory;
}

async function fakeOllama(directory) {
  const executable = path.join(directory, 'ollama-fixture.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
writeFileSync(join(directory, 'argv.json'), JSON.stringify(process.argv.slice(2)));
writeFileSync(join(directory, 'stdin.txt'), Buffer.concat(chunks));
writeFileSync(join(directory, 'env.json'), JSON.stringify({
  OLLAMA_NOHISTORY: process.env.OLLAMA_NOHISTORY,
  NO_COLOR: process.env.NO_COLOR,
  TERM: process.env.TERM
}));
process.stdout.write('{"status":"ok"}\\n');
`);
  await chmod(executable, 0o755);
  return executable;
}

function formatValue(argv) {
  const index = argv.indexOf('--format');
  assert.notEqual(index, -1);
  return argv[index + 1];
}

test('Ollama Cloud selects JSON mode while local models retain the explicit schema', () => {
  assert.equal(ollamaFormatForModel('glm-5.2:cloud', RESPONSE_SCHEMA), 'json');
  assert.equal(ollamaFormatForModel('registry.example/team/model:cloud', RESPONSE_SCHEMA), 'json');
  assert.equal(
    ollamaFormatForModel('glm-5.2', RESPONSE_SCHEMA),
    JSON.stringify(RESPONSE_SCHEMA)
  );
  assert.equal(
    ollamaFormatForModel('cloud-model:latest', RESPONSE_SCHEMA),
    JSON.stringify(RESPONSE_SCHEMA)
  );
});

test('Ollama Cloud passes JSON mode and the prepared prompt through stdin', {
  skip: process.platform === 'win32'
}, async () => {
  const fixture = await temporaryDirectory();
  const executable = await fakeOllama(fixture);
  const response = await reviewWithOllama({
    root: fixture,
    prompt: 'cloud review packet',
    model: 'glm-5.2:cloud',
    timeoutMs: 5_000,
    ollamaBin: executable,
    responseSchema: RESPONSE_SCHEMA
  });

  assert.equal(response.model, 'glm-5.2:cloud');
  assert.equal(response.run.ok, true);
  assert.equal(response.stdout, '{"status":"ok"}\n');
  const argv = JSON.parse(await readFile(path.join(fixture, 'argv.json'), 'utf8'));
  assert.deepEqual(argv.slice(0, 2), ['run', 'glm-5.2:cloud']);
  assert.equal(formatValue(argv), 'json');
  assert.equal(argv.includes(JSON.stringify(RESPONSE_SCHEMA)), false);
  assert.equal(argv[argv.indexOf('--think') + 1], 'high');
  assert.ok(argv.includes('--hidethinking'));
  assert.ok(argv.includes('--nowordwrap'));
  assert.equal(await readFile(path.join(fixture, 'stdin.txt'), 'utf8'), 'cloud review packet');
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture, 'env.json'), 'utf8')), {
    OLLAMA_NOHISTORY: '1',
    NO_COLOR: '1',
    TERM: 'dumb'
  });
});

test('local Ollama models pass the full response schema without changing stdin behavior', {
  skip: process.platform === 'win32'
}, async () => {
  const fixture = await temporaryDirectory();
  const executable = await fakeOllama(fixture);
  await reviewWithOllama({
    root: fixture,
    prompt: 'local review packet',
    model: 'qwen3.5:27b',
    timeoutMs: 5_000,
    ollamaBin: executable,
    think: 'medium',
    responseSchema: RESPONSE_SCHEMA
  });

  const argv = JSON.parse(await readFile(path.join(fixture, 'argv.json'), 'utf8'));
  assert.deepEqual(argv.slice(0, 2), ['run', 'qwen3.5:27b']);
  assert.equal(formatValue(argv), JSON.stringify(RESPONSE_SCHEMA));
  assert.equal(argv[argv.indexOf('--think') + 1], 'medium');
  assert.equal(await readFile(path.join(fixture, 'stdin.txt'), 'utf8'), 'local review packet');

  await reviewWithOllama({
    root: fixture,
    prompt: 'low effort packet',
    model: 'qwen3.5:27b',
    timeoutMs: 5_000,
    ollamaBin: executable,
    think: 'low',
    responseSchema: RESPONSE_SCHEMA
  });
  const lowArgv = JSON.parse(await readFile(path.join(fixture, 'argv.json'), 'utf8'));
  assert.equal(lowArgv[lowArgv.indexOf('--think') + 1], 'low');
});

test('Ollama Cloud still requires an explicit response schema before process launch', async () => {
  await assert.rejects(
    reviewWithOllama({
      root: process.cwd(),
      prompt: 'packet',
      model: 'glm-5.2:cloud',
      timeoutMs: 1_000
    }),
    (error) => error instanceof ProviderFailure
      && error.stage === 'preflight'
      && error.failureCode === 'isolation_failed'
      && /explicit response schema/.test(error.message)
  );
});

test('direct Ollama rejects xhigh and max as safe preflight failures without process launch', async () => {
  for (const think of ['xhigh', 'max']) {
    const fixture = await temporaryDirectory();
    const executable = await fakeOllama(fixture);
    await assert.rejects(
      reviewWithOllama({
        root: fixture,
        prompt: 'must not launch',
        model: 'glm-5.2:cloud',
        timeoutMs: 5_000,
        ollamaBin: executable,
        think,
        responseSchema: RESPONSE_SCHEMA
      }),
      (error) => error instanceof ProviderFailure
        && error.stage === 'preflight'
        && error.run.stage === 'preflight'
        && error.failureCode === 'isolation_failed'
        && /think setting/.test(error.message)
    );
    await assert.rejects(readFile(path.join(fixture, 'argv.json'), 'utf8'));
  }
});

test('direct Ollama normalizes malformed adapter options to a safe preflight failure', async () => {
  for (const options of [null, []]) {
    await assert.rejects(
      reviewWithOllama(options),
      (error) => error instanceof ProviderFailure
        && error.stage === 'preflight'
        && error.failureCode === 'isolation_failed'
        && /options must be an object/.test(error.message)
    );
  }
});
