import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseModeArgs, runModeCommand } from '../src/mode-cli.mjs';
import {
  changeMode,
  modeFile,
  providerDefaultEffort,
  providerDefaultModel,
  readMode,
  reviewersForMode
} from '../src/mode.mjs';

const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-mode-reviewers-'));
  temporaryPaths.push(root);
  return { root: path.join(root, 'workspace'), dataDir: path.join(root, 'state') };
}

test('provider defaults cover every supported reviewer connection', () => {
  assert.deepEqual(
    ['grok', 'ollama', 'claude', 'opencode'].map((provider) => [
      provider,
      providerDefaultModel(provider),
      providerDefaultEffort(provider)
    ]),
    [
      ['grok', 'grok-4.5', 'high'],
      ['ollama', 'glm-5.2:cloud', 'high'],
      ['claude', 'claude-opus-4-8', 'high'],
      ['opencode', 'openai/gpt-5.6', 'high']
    ]
  );
  assert.throws(() => providerDefaultModel('unknown'), /Invalid Buddy mode provider/);
});

test('default and legacy modes expose one immutable reviewer', async () => {
  const options = await fixture();
  const initial = await readMode(options);
  assert.equal(initial.secondary_provider, null);
  assert.equal(initial.secondary_model, null);
  assert.equal(initial.secondary_effort, null);
  const initialReviewers = reviewersForMode(initial);
  assert.deepEqual(initialReviewers, [
    { provider: 'ollama', model: 'glm-5.2:cloud', effort: 'high' }
  ]);
  assert.equal(Object.isFrozen(initialReviewers), true);
  assert.equal(Object.isFrozen(initialReviewers[0]), true);
  assert.throws(() => initialReviewers.push({}), TypeError);

  const file = modeFile(options.root, options.dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  const { secondary_provider, secondary_model, secondary_effort, ...legacy } = initial;
  await writeFile(file, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const restored = await readMode(options);
  assert.equal(restored.secondary_provider, null);
  assert.equal(restored.secondary_model, null);
  assert.equal(restored.secondary_effort, null);
});

test('mode persists an ordered two-reviewer configuration with adapter defaults', async () => {
  const options = await fixture();
  const dual = await changeMode({
    ...options,
    action: 'enable',
    provider: 'grok',
    secondaryProvider: 'claude'
  });
  assert.equal(dual.secondary_provider, 'claude');
  assert.equal(dual.secondary_model, 'claude-opus-4-8');
  assert.equal(dual.secondary_effort, 'high');
  assert.deepEqual(reviewersForMode(dual), [
    { provider: 'grok', model: 'grok-4.5', effort: 'high' },
    { provider: 'claude', model: 'claude-opus-4-8', effort: 'high' }
  ]);

  const stored = JSON.parse(await readFile(modeFile(options.root, options.dataDir), 'utf8'));
  assert.equal(stored.secondary_provider, 'claude');
  assert.equal(stored.secondary_model, 'claude-opus-4-8');
  assert.equal(stored.secondary_effort, 'high');
});

test('secondary connection updates are bounded and single-reviewer clearing advances revision', async () => {
  const options = await fixture();
  const first = await changeMode({ ...options, action: 'enable', secondaryProvider: 'claude' });
  const custom = await changeMode({
    ...options,
    action: 'enable',
    secondaryModel: 'claude-sonnet-4-5',
    secondaryEffort: 'xhigh'
  });
  assert.equal(custom.secondary_provider, 'claude');
  assert.equal(custom.secondary_model, 'claude-sonnet-4-5');
  assert.equal(custom.secondary_effort, 'xhigh');

  const changed = await changeMode({ ...options, action: 'enable', secondaryProvider: 'opencode' });
  assert.equal(changed.secondary_model, 'openai/gpt-5.6');
  assert.equal(changed.secondary_effort, 'high');

  const cleared = await changeMode({ ...options, action: 'enable', singleReviewer: true });
  assert.equal(cleared.config_revision, first.config_revision + 3);
  assert.equal(cleared.secondary_provider, null);
  assert.equal(cleared.secondary_model, null);
  assert.equal(cleared.secondary_effort, null);
  assert.equal(reviewersForMode(cleared).length, 1);
});

test('duplicate and partial secondary configurations fail closed', async () => {
  const options = await fixture();
  await assert.rejects(
    changeMode({ ...options, action: 'enable', secondaryProvider: 'ollama' }),
    /distinct provider\/model connections/
  );
  const sameAdapter = await changeMode({
    ...options,
    action: 'enable',
    secondaryProvider: 'ollama',
    secondaryModel: 'qwen3-coder:cloud'
  });
  assert.equal(reviewersForMode(sameAdapter).length, 2);
  await assert.rejects(
    changeMode({ ...options, action: 'enable', secondaryProvider: null }),
    /singleReviewer/
  );
  await assert.rejects(
    changeMode({ ...options, action: 'enable', singleReviewer: true, secondaryProvider: 'grok' }),
    /configure and clear/
  );

  const file = modeFile(options.root, options.dataDir);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify({
    ...stored,
    secondary_provider: 'grok',
    secondary_model: null,
    secondary_effort: 'high'
  })}\n`, { mode: 0o600 });
  await assert.rejects(readMode(options), /Invalid Buddy secondary reviewer configuration/);
});

test('secondary Ollama rejects unsupported effort before mode persistence', async () => {
  for (const effort of ['xhigh', 'max']) {
    const options = await fixture();
    await assert.rejects(
      changeMode({
        ...options,
        action: 'enable',
        provider: 'grok',
        secondaryProvider: 'ollama',
        secondaryEffort: effort
      }),
      /Invalid Buddy secondary reviewer reasoning effort for ollama/
    );
    const mode = await readMode(options);
    assert.equal(mode.enabled, false);
    assert.equal(mode.config_revision, 0);
    assert.equal(mode.secondary_provider, null);
  }
});

test('mode CLI parses primary and secondary connections and documents clearing', async () => {
  assert.deepEqual(parseModeArgs([
    'enable',
    '--provider', 'grok',
    '--model', 'grok-4.5',
    '--also-provider', 'claude',
    '--also-model', 'claude-opus-4-8',
    '--also-effort', 'high'
  ]), {
    action: 'enable',
    json: false,
    provider: 'grok',
    model: 'grok-4.5',
    secondaryProvider: 'claude',
    secondaryModel: 'claude-opus-4-8',
    secondaryEffort: 'high'
  });
  assert.equal(parseModeArgs(['enable', '--single-reviewer']).singleReviewer, true);
  assert.throws(
    () => parseModeArgs(['enable', '--single-reviewer', '--also-provider', 'grok']),
    /cannot be combined/
  );
  assert.throws(() => parseModeArgs(['enable', '--provider', 'kimi']), /claude, or opencode/);
  assert.throws(() => parseModeArgs(['enable', '--also-provider', 'kimi']), /claude, or opencode/);

  const output = await runModeCommand(['--help']);
  assert.match(output.help, /Primary connection/);
  assert.match(output.help, /second independent reviewer connection/);
  assert.match(output.help, /--single-reviewer/);
});
