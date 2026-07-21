import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { changeMode, modeFile, readMode, resolveRepositoryRoot } from '../src/mode.mjs';
import { runProcess } from '../src/process.mjs';

const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-mode-validation-'));
  temporaryPaths.push(root);
  return { root: path.join(root, 'workspace'), dataDir: path.join(root, 'state') };
}

test('repository roots use the host filesystem canonical path form', async () => {
  const options = await fixture();
  await mkdir(options.root, { recursive: true });
  await runProcess('git', ['init', '--quiet'], { cwd: options.root });
  assert.equal(await resolveRepositoryRoot(options.root), await realpath(options.root));
});

test('mode state configured inside the reviewed repository fails before writing', async () => {
  const options = await fixture();
  await mkdir(options.root, { recursive: true });
  const dataDir = path.join(options.root, '.buddy-mode');
  await assert.rejects(
    changeMode({ root: options.root, dataDir, action: 'enable' }),
    /outside the reviewed repository/u
  );
  await assert.rejects(access(dataDir));
});

test('mode accepts bounded model identifiers and closed reasoning efforts', async () => {
  const options = await fixture();
  for (const [model, effort] of [
    ['grok-4.5', 'high'],
    ['glm-5.2:cloud', 'medium'],
    ['vendor/model@2026-07', 'xhigh'],
    ['model+variant', 'max'],
    ['model_name', 'low']
  ]) {
    const mode = await changeMode({ ...options, action: 'enable', provider: 'grok', model, effort });
    assert.equal(mode.model, model);
    assert.equal(mode.effort, effort);
  }
});

test('mode accepts Ollama low through high and rejects xhigh or max before persistence', async () => {
  const valid = await fixture();
  for (const effort of ['low', 'medium', 'high']) {
    const mode = await changeMode({
      ...valid,
      action: 'enable',
      provider: 'ollama',
      effort
    });
    assert.equal(mode.effort, effort);
  }

  for (const effort of ['xhigh', 'max']) {
    const invalid = await fixture();
    await assert.rejects(
      changeMode({ ...invalid, action: 'enable', provider: 'ollama', effort }),
      /Invalid Buddy reasoning effort for ollama/
    );
    const mode = await readMode(invalid);
    assert.equal(mode.enabled, false);
    assert.equal(mode.config_revision, 0);
    assert.equal(mode.effort, 'high');
  }
});

test('mode rejects terminal controls, option-like text, whitespace, and unbounded identifiers', async () => {
  const options = await fixture();
  for (const model of [
    '--tools',
    'grok 4.5',
    'grok-4.5\n--permission-mode',
    'grok-4.5\u001b]52;c;payload\u0007',
    'x'.repeat(201)
  ]) {
    await assert.rejects(
      changeMode({ ...options, action: 'enable', provider: 'grok', model }),
      /Invalid Buddy mode model/
    );
  }
  for (const effort of ['HIGH', 'high\n--tools', '', 'ultra']) {
    await assert.rejects(
      changeMode({ ...options, action: 'enable', provider: 'grok', effort }),
      /Invalid Buddy reasoning effort/
    );
  }
});

test('legacy mode state is validated before display or provider use', async () => {
  const options = await fixture();
  const current = await readMode(options);
  const file = modeFile(options.root, options.dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    ...current,
    model: 'grok-4.5\n--tools',
    config_revision: current.config_revision + 1
  })}\n`, { mode: 0o600 });

  await assert.rejects(readMode(options), /Invalid Buddy mode model/);
});

test('expected mode revisions prevent stale setup writes under the mode lock', async () => {
  const options = await fixture();
  const enabled = await changeMode({ ...options, action: 'enable', expectedRevision: 0 });
  assert.equal(enabled.config_revision, 1);
  await assert.rejects(
    changeMode({ ...options, action: 'disable', expectedRevision: 0 }),
    /expected 0, found 1/
  );
  const current = await readMode(options);
  assert.equal(current.enabled, true);
  assert.equal(current.config_revision, 1);
});

test('generic enable and toggle remain final-only until continuous review is explicitly authorized', async () => {
  const options = await fixture();
  const enabled = await changeMode({ ...options, action: 'enable' });
  assert.equal(enabled.continuous_review_enabled, false);
  assert.equal(enabled.continuous_review_consented_at, null);

  const disabled = await changeMode({ ...options, action: 'toggle' });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.continuous_review_enabled, false);
  assert.equal(disabled.continuous_review_consented_at, null);

  const toggledOn = await changeMode({ ...options, action: 'toggle' });
  assert.equal(toggledOn.enabled, true);
  assert.equal(toggledOn.continuous_review_enabled, false);
  assert.equal(toggledOn.continuous_review_consented_at, null);
});

test('explicit continuous review records canonical purpose-specific consent and final-only clears it', async () => {
  const options = await fixture();
  const enabled = await changeMode({ ...options, action: 'enable', continuousReview: true });
  assert.equal(enabled.continuous_review_enabled, true);
  const consentMilliseconds = Date.parse(enabled.continuous_review_consented_at);
  assert.equal(Number.isFinite(consentMilliseconds), true);
  assert.equal(new Date(consentMilliseconds).toISOString(), enabled.continuous_review_consented_at);

  const finalOnly = await changeMode({
    ...options,
    action: 'enable',
    continuousReview: false,
    expectedRevision: enabled.config_revision
  });
  assert.equal(finalOnly.enabled, true);
  assert.equal(finalOnly.continuous_review_enabled, false);
  assert.equal(finalOnly.continuous_review_consented_at, null);
});

test('legacy v2 and ambiguous v3 policy records migrate final-only', async () => {
  for (const policyVersion of ['2', '3']) {
    const options = await fixture();
    const current = await readMode(options);
    const file = modeFile(options.root, options.dataDir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({
      ...current,
      policy_version: policyVersion,
      enabled: true,
      continuous_review_enabled: true,
      continuous_review_consented_at: '2026-07-20T00:00:00.000Z'
    })}\n`, { mode: 0o600 });

    const migrated = await readMode(options);
    assert.equal(migrated.policy_version, '4');
    assert.equal(migrated.enabled, true);
    assert.equal(migrated.continuous_review_enabled, false);
    assert.equal(migrated.continuous_review_consented_at, null);
  }
});

test('enabled continuous mode rejects missing, malformed, or noncanonical consent timestamps', async () => {
  for (const consent of [null, 'not-a-date', '2026-07-20T00:00:00Z']) {
    const options = await fixture();
    const current = await changeMode({ ...options, action: 'enable', continuousReview: true });
    const file = modeFile(options.root, options.dataDir);
    await writeFile(file, `${JSON.stringify({
      ...current,
      continuous_review_consented_at: consent
    })}\n`, { mode: 0o600 });
    await assert.rejects(readMode(options), /continuous review (?:consent|requires explicit consent)/);
  }
});
