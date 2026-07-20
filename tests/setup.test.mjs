import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readMode, changeMode } from '../src/mode.mjs';
import { installPet, removePet } from '../src/pet-catalog.mjs';
import { parseSetupArgs, renderSetupCommand } from '../src/setup-cli.mjs';
import { canonicalJson } from '../src/state.mjs';
import {
  applySetupPlan,
  createSetupPlan,
  pruneSetupPlansForWorkspace,
  readSetupPlan,
  rollbackSetupPlan,
  SETUP_TERMINAL_RETENTION_MS
} from '../src/setup.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryPaths = [];
const definitions = [
  ['buddy-byte', 'Byte', 'public'],
  ['buddy-mochi', 'Mochi', 'public'],
  ['buddy-orbit', 'Orbit', 'public'],
  ['buddy-bella', 'Bella', 'public'],
  ['buddy-lupo', 'Lupo', 'public']
];

test('setup CLI keeps plan options separate from immutable apply and rollback identity', () => {
  assert.equal(parseSetupArgs(['plan', '--pet-id', 'buddy-byte']).petId, 'buddy-byte');
  assert.deepEqual(parseSetupArgs([
    'plan',
    '--provider', 'claude',
    '--also-provider', 'grok',
    '--also-model', 'grok-4.5',
    '--also-effort', 'xhigh'
  ]), {
    action: 'plan',
    json: false,
    provider: 'claude',
    secondaryProvider: 'grok',
    secondaryModel: 'grok-4.5',
    secondaryEffort: 'xhigh'
  });
  assert.equal(parseSetupArgs(['plan', '--provider', 'opencode']).provider, 'opencode');
  assert.equal(parseSetupArgs(['plan', '--single-reviewer']).singleReviewer, true);
  assert.equal(parseSetupArgs([
    'apply', '--plan-id', 'plan-1', '--plan-digest', 'a'.repeat(64)
  ]).action, 'apply');
  assert.throws(
    () => parseSetupArgs([
      'apply', '--plan-id', 'plan-1', '--plan-digest', 'a'.repeat(64), '--provider', 'grok'
    ]),
    /--provider is only valid for setup plan/
  );
  assert.throws(
    () => parseSetupArgs(['plan', '--plan-id', 'plan-1']),
    /--plan-id is only valid for setup apply or rollback/
  );
  assert.throws(
    () => parseSetupArgs(['plan', '--single-reviewer', '--also-provider', 'grok']),
    /cannot be combined/
  );
  assert.throws(() => parseSetupArgs(['plan', '--provider', 'kimi']), /claude, or opencode/);
  assert.throws(() => parseSetupArgs(['plan', '--also-provider', 'kimi']), /claude, or opencode/);
});

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixtureCatalog() {
  const root = await temporaryDirectory('codex-buddy-setup-');
  const workspace = path.join(root, 'workspace');
  const catalogRoot = path.join(root, 'catalog');
  const codexHome = path.join(root, 'codex');
  const dataDir = path.join(root, 'state');
  await mkdir(workspace, { recursive: true });
  await mkdir(catalogRoot, { recursive: true });
  const sprite = Buffer.from('setup-fixture-sprite-v1');
  const pets = [];
  for (const [id, displayName, scope] of definitions) {
    const directory = path.join(catalogRoot, id);
    await mkdir(directory, { recursive: true });
    const description = `${displayName} setup fixture.`;
    const available = id === 'buddy-byte';
    const manifest = {
      id,
      displayName,
      description,
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp'
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(directory, 'pet.json'), manifestBytes);
    await writeJson(path.join(directory, 'provenance.json'), {
      schema_version: '1',
      pet_id: id,
      scope,
      status: available ? 'validated' : 'awaiting-v2-artwork',
      redistribution: scope === 'private' ? 'private-only' : available ? 'cleared' : 'not-cleared',
      binary_asset_present: available,
      notes: 'Setup fixture.'
    });
    if (available) await writeFile(path.join(directory, 'spritesheet.webp'), sprite);
    pets.push({
      id,
      displayName,
      description,
      scope,
      spriteVersionNumber: 2,
      available,
      notReadyReason: available ? null : 'Fixture unavailable.',
      manifestPath: `./${id}/pet.json`,
      manifestSha256: hash(manifestBytes),
      spritesheetPath: `./${id}/spritesheet.webp`,
      provenancePath: `./${id}/provenance.json`,
      spritesheetSha256: available ? hash(sprite) : null
    });
  }
  const catalogFile = path.join(catalogRoot, 'catalog.json');
  await writeJson(catalogFile, { schema_version: '1', pets });
  return { root, workspace, catalogRoot, catalogFile, codexHome, dataDir, sprite };
}

async function replaceByteSprite(fixture, bytes) {
  await writeFile(path.join(fixture.catalogRoot, 'buddy-byte', 'spritesheet.webp'), bytes);
  const catalog = JSON.parse(await readFile(fixture.catalogFile, 'utf8'));
  catalog.pets.find((pet) => pet.id === 'buddy-byte').spritesheetSha256 = hash(bytes);
  await writeJson(fixture.catalogFile, catalog);
}

function setupOptions(fixture, overrides = {}) {
  return {
    root: fixture.workspace,
    resolveRoot: async (value) => value,
    codexHome: fixture.codexHome,
    dataDir: fixture.dataDir,
    catalogFile: fixture.catalogFile,
    pluginRoot: repositoryRoot,
    petId: 'buddy-byte',
    ...overrides
  };
}

async function planFiles(dataDir, planId) {
  return readdir(path.join(dataDir, 'setup', 'plans', planId));
}

test('setup applies the pet first, enables review last, and rolls both back safely', async () => {
  const fixture = await fixtureCatalog();
  const plan = await createSetupPlan(setupOptions(fixture));
  assert.deepEqual(plan.steps.map((step) => [step.order, step.kind, step.action]), [
    [10, 'pet', 'install'],
    [20, 'review', 'enable']
  ]);
  assert.equal(Object.hasOwn(plan.desired_mode, 'pet_id'), false);
  assert.deepEqual(plan.desired_presentation, {
    pet_id: 'buddy-byte',
    selection: 'manual_host'
  });
  assert.equal(plan.manual_host_steps.some((step) => /hook trust/i.test(step)), true);
  assert.equal(plan.manual_host_steps.some((step) => /\/pet/i.test(step)), true);

  const applied = await applySetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  assert.equal(applied.outcome, 'applied');
  assert.equal(applied.pet_result.action, 'installed');
  assert.equal((await readMode({ root: plan.workspace_root, dataDir: fixture.dataDir })).enabled, true);
  const target = path.join(fixture.codexHome, 'pets', 'buddy-byte');
  assert.deepEqual(await readFile(path.join(target, 'spritesheet.webp')), fixture.sprite);
  assert.deepEqual((await planFiles(fixture.dataDir, plan.plan_id)).sort(), [
    '00-plan.json',
    '00-plan.json.lock',
    '10-apply-intent.json',
    '20-pet-applied.json',
    '25-mode-applied.json',
    '30-applied.json'
  ]);

  const rolledBack = await rollbackSetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  assert.equal(rolledBack.outcome, 'rolled_back');
  await assert.rejects(access(target));
  assert.equal((await readMode({ root: plan.workspace_root, dataDir: fixture.dataDir })).enabled, false);
  assert.deepEqual((await planFiles(fixture.dataDir, plan.plan_id)).sort(), [
    '00-plan.json',
    '00-plan.json.lock',
    '10-apply-intent.json',
    '20-pet-applied.json',
    '25-mode-applied.json',
    '30-applied.json',
    '40-rollback-intent.json',
    '50-mode-rolled-back.json',
    '60-pet-rolled-back.json',
    '70-rolled-back.json'
  ]);
});

test('apply resumes safely after pet or mode mutation before its durable receipt', async () => {
  const petFixture = await fixtureCatalog();
  const petPlan = await createSetupPlan(setupOptions(petFixture, { nowMs: 1_000, ttlMs: 10 }));
  await assert.rejects(
    applySetupPlan(setupOptions(petFixture, {
      planId: petPlan.plan_id,
      planDigest: petPlan.plan_digest,
      nowMs: 1_005,
      afterPetMutation: async () => { throw new Error('simulated pet receipt crash'); }
    })),
    /simulated pet receipt crash/
  );
  assert.equal((await readMode({ root: petPlan.workspace_root, dataDir: petFixture.dataDir })).enabled, false);
  const recoveredPet = await applySetupPlan(setupOptions(petFixture, {
    planId: petPlan.plan_id,
    planDigest: petPlan.plan_digest,
    nowMs: 1_000_000
  }));
  assert.equal(recoveredPet.outcome, 'applied');
  assert.equal(recoveredPet.pet_result.action, 'installed');

  const modeFixture = await fixtureCatalog();
  const modePlan = await createSetupPlan(setupOptions(modeFixture));
  await assert.rejects(
    applySetupPlan(setupOptions(modeFixture, {
      planId: modePlan.plan_id,
      planDigest: modePlan.plan_digest,
      afterModeMutation: async () => { throw new Error('simulated mode receipt crash'); }
    })),
    /simulated mode receipt crash/
  );
  assert.equal((await readMode({ root: modePlan.workspace_root, dataDir: modeFixture.dataDir })).enabled, true);
  const recoveredMode = await applySetupPlan(setupOptions(modeFixture, {
    planId: modePlan.plan_id,
    planDigest: modePlan.plan_digest
  }));
  assert.equal(recoveredMode.outcome, 'applied');
  assert.equal(recoveredMode.mode_after.enabled, true);
});

test('rollback resumes safely after mode or pet mutation before its durable receipt', async () => {
  const modeFixture = await fixtureCatalog();
  const modePlan = await createSetupPlan(setupOptions(modeFixture));
  await applySetupPlan(setupOptions(modeFixture, {
    planId: modePlan.plan_id,
    planDigest: modePlan.plan_digest
  }));
  await assert.rejects(
    rollbackSetupPlan(setupOptions(modeFixture, {
      planId: modePlan.plan_id,
      planDigest: modePlan.plan_digest,
      afterModeRollbackMutation: async () => { throw new Error('simulated mode rollback receipt crash'); }
    })),
    /simulated mode rollback receipt crash/
  );
  assert.equal((await readMode({ root: modePlan.workspace_root, dataDir: modeFixture.dataDir })).enabled, false);
  assert.equal(
    await readFile(path.join(modeFixture.codexHome, 'pets', 'buddy-byte', 'spritesheet.webp'), 'utf8'),
    modeFixture.sprite.toString()
  );
  const recoveredMode = await rollbackSetupPlan(setupOptions(modeFixture, {
    planId: modePlan.plan_id,
    planDigest: modePlan.plan_digest
  }));
  assert.equal(recoveredMode.outcome, 'rolled_back');
  await assert.rejects(access(path.join(modeFixture.codexHome, 'pets', 'buddy-byte')));

  const petFixture = await fixtureCatalog();
  const petPlan = await createSetupPlan(setupOptions(petFixture));
  await applySetupPlan(setupOptions(petFixture, {
    planId: petPlan.plan_id,
    planDigest: petPlan.plan_digest
  }));
  await assert.rejects(
    rollbackSetupPlan(setupOptions(petFixture, {
      planId: petPlan.plan_id,
      planDigest: petPlan.plan_digest,
      afterPetRollbackMutation: async () => { throw new Error('simulated pet rollback receipt crash'); }
    })),
    /simulated pet rollback receipt crash/
  );
  await assert.rejects(access(path.join(petFixture.codexHome, 'pets', 'buddy-byte')));
  const recoveredPet = await rollbackSetupPlan(setupOptions(petFixture, {
    planId: petPlan.plan_id,
    planDigest: petPlan.plan_digest
  }));
  assert.equal(recoveredPet.outcome, 'rolled_back');
});

test('update rollback resumes between preserving the new package and restoring the old package', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  const updatedSprite = Buffer.from('setup-fixture-sprite-v2-interrupted');
  await replaceByteSprite(fixture, updatedSprite);
  const plan = await createSetupPlan(setupOptions(fixture));
  await applySetupPlan(setupOptions(fixture, { planId: plan.plan_id, planDigest: plan.plan_digest }));
  await assert.rejects(
    rollbackSetupPlan(setupOptions(fixture, {
      planId: plan.plan_id,
      planDigest: plan.plan_digest,
      afterPetRemovalMutation: async () => { throw new Error('simulated update rollback interruption'); }
    })),
    /simulated update rollback interruption/
  );
  await assert.rejects(access(path.join(fixture.codexHome, 'pets', 'buddy-byte')));
  const recovered = await rollbackSetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  assert.equal(recovered.outcome, 'rolled_back');
  assert.deepEqual(
    await readFile(path.join(fixture.codexHome, 'pets', 'buddy-byte', 'spritesheet.webp')),
    fixture.sprite
  );
});

test('rollback never removes a preexisting exact unowned pet', async () => {
  const fixture = await fixtureCatalog();
  const target = path.join(fixture.codexHome, 'pets', 'buddy-byte');
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(target, 'pet.json'),
    await readFile(path.join(fixture.catalogRoot, 'buddy-byte', 'pet.json'))
  );
  await writeFile(path.join(target, 'spritesheet.webp'), fixture.sprite);
  const plan = await createSetupPlan(setupOptions(fixture));
  assert.equal(plan.steps[0].action, 'none_preexisting');
  await applySetupPlan(setupOptions(fixture, { planId: plan.plan_id, planDigest: plan.plan_digest }));
  await rollbackSetupPlan(setupOptions(fixture, { planId: plan.plan_id, planDigest: plan.plan_digest }));
  assert.deepEqual(await readFile(path.join(target, 'spritesheet.webp')), fixture.sprite);
});

test('setup and rollback preserve an already-enabled matching review mode without revision churn', async () => {
  const fixture = await fixtureCatalog();
  const workspaceRoot = await realpath(fixture.workspace);
  const before = await changeMode({ root: workspaceRoot, dataDir: fixture.dataDir, action: 'enable' });
  const plan = await createSetupPlan(setupOptions(fixture));
  assert.equal(plan.steps.find((step) => step.kind === 'review').action, 'none');
  const applied = await applySetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  assert.equal(applied.mode_after.config_revision, before.config_revision);
  const rolledBack = await rollbackSetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  assert.equal(rolledBack.mode_result.config_revision, before.config_revision);
  assert.equal((await readMode({ root: workspaceRoot, dataDir: fixture.dataDir })).enabled, true);
});

test('setup preserves an unchanged ordered two-reviewer mode without revision churn', async () => {
  const fixture = await fixtureCatalog();
  const workspaceRoot = await realpath(fixture.workspace);
  const before = await changeMode({
    root: workspaceRoot,
    dataDir: fixture.dataDir,
    action: 'enable',
    provider: 'claude',
    secondaryProvider: 'grok',
    secondaryModel: 'grok-4.5',
    secondaryEffort: 'xhigh'
  });
  const plan = await createSetupPlan(setupOptions(fixture));
  assert.equal(plan.steps.find((step) => step.kind === 'review').action, 'none');
  assert.deepEqual(plan.mode_before, {
    workspace_root: workspaceRoot,
    config_revision: before.config_revision,
    enabled: true,
    provider: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
    secondary_provider: 'grok',
    secondary_model: 'grok-4.5',
    secondary_effort: 'xhigh',
    min_confidence: 0.75,
    max_patch_bytes: 256 * 1024,
    timeout_ms: 480_000
  });
  assert.deepEqual(plan.desired_mode, {
    enabled: true,
    provider: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
    secondary_provider: 'grok',
    secondary_model: 'grok-4.5',
    secondary_effort: 'xhigh',
    min_confidence: 0.75,
    max_patch_bytes: 256 * 1024,
    timeout_ms: 480_000
  });

  const applied = await applySetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  assert.equal(applied.mode_after.config_revision, before.config_revision);
  const rolledBack = await rollbackSetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  assert.equal(rolledBack.mode_result.config_revision, before.config_revision);
  assert.equal((await readMode({ root: workspaceRoot, dataDir: fixture.dataDir })).secondary_provider, 'grok');
});

test('setup applies both planned reviewer connections and rollback restores the exact prior pair', async () => {
  const fixture = await fixtureCatalog();
  const workspaceRoot = await realpath(fixture.workspace);
  const before = await changeMode({
    root: workspaceRoot,
    dataDir: fixture.dataDir,
    action: 'enable',
    provider: 'claude',
    secondaryProvider: 'grok',
    secondaryModel: 'grok-4.5',
    secondaryEffort: 'xhigh'
  });
  const plan = await createSetupPlan(setupOptions(fixture, {
    provider: 'opencode',
    model: 'openai/gpt-5.6',
    effort: 'medium',
    secondaryProvider: 'ollama',
    secondaryModel: 'qwen3-coder:cloud',
    secondaryEffort: 'high'
  }));
  assert.deepEqual(plan.desired_mode, {
    enabled: true,
    provider: 'opencode',
    model: 'openai/gpt-5.6',
    effort: 'medium',
    secondary_provider: 'ollama',
    secondary_model: 'qwen3-coder:cloud',
    secondary_effort: 'high',
    min_confidence: 0.75,
    max_patch_bytes: 256 * 1024,
    timeout_ms: 480_000
  });
  assert.match(renderSetupCommand({ action: 'plan', result: plan }), /Primary review connection: opencode/);
  assert.match(renderSetupCommand({ action: 'plan', result: plan }), /Secondary review connection: ollama/);

  await applySetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  const applied = await readMode({ root: workspaceRoot, dataDir: fixture.dataDir });
  assert.deepEqual(
    [applied.provider, applied.model, applied.effort],
    ['opencode', 'openai/gpt-5.6', 'medium']
  );
  assert.deepEqual(
    [applied.secondary_provider, applied.secondary_model, applied.secondary_effort],
    ['ollama', 'qwen3-coder:cloud', 'high']
  );

  await rollbackSetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  const restored = await readMode({ root: workspaceRoot, dataDir: fixture.dataDir });
  assert.deepEqual(
    [restored.provider, restored.model, restored.effort],
    [before.provider, before.model, before.effort]
  );
  assert.deepEqual(
    [restored.secondary_provider, restored.secondary_model, restored.secondary_effort],
    [before.secondary_provider, before.secondary_model, before.secondary_effort]
  );
});

test('setup can explicitly clear a secondary reviewer and restores it on rollback', async () => {
  const fixture = await fixtureCatalog();
  const workspaceRoot = await realpath(fixture.workspace);
  const before = await changeMode({
    root: workspaceRoot,
    dataDir: fixture.dataDir,
    action: 'enable',
    secondaryProvider: 'claude'
  });
  const plan = await createSetupPlan(setupOptions(fixture, { singleReviewer: true }));
  assert.equal(plan.desired_mode.secondary_provider, null);
  assert.equal(plan.steps.find((step) => step.kind === 'review').action, 'enable');
  assert.match(renderSetupCommand({ action: 'plan', result: plan }), /none \(single reviewer\)/);

  await applySetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  assert.equal((await readMode({ root: workspaceRoot, dataDir: fixture.dataDir })).secondary_provider, null);
  await rollbackSetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  const restored = await readMode({ root: workspaceRoot, dataDir: fixture.dataDir });
  assert.equal(restored.secondary_provider, before.secondary_provider);
  assert.equal(restored.secondary_model, before.secondary_model);
  assert.equal(restored.secondary_effort, before.secondary_effort);
});

test('setup update rollback restores the exact prior package through the pet backup journal', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  const updatedSprite = Buffer.from('setup-fixture-sprite-v2');
  await replaceByteSprite(fixture, updatedSprite);
  const plan = await createSetupPlan(setupOptions(fixture));
  assert.equal(plan.steps[0].action, 'update');
  const applied = await applySetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  assert.equal(applied.pet_result.action, 'updated');
  assert.deepEqual(
    await readFile(path.join(fixture.codexHome, 'pets', 'buddy-byte', 'spritesheet.webp')),
    updatedSprite
  );
  await rollbackSetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  assert.deepEqual(
    await readFile(path.join(fixture.codexHome, 'pets', 'buddy-byte', 'spritesheet.webp')),
    fixture.sprite
  );
});

test('apply rejects expired plans and an incorrect immutable digest before changing state', async () => {
  const fixture = await fixtureCatalog();
  const plan = await createSetupPlan(setupOptions(fixture, { nowMs: 1_000, ttlMs: 10 }));
  await assert.rejects(
    applySetupPlan(setupOptions(fixture, {
      planId: plan.plan_id,
      planDigest: '0'.repeat(64),
      nowMs: 1_005
    })),
    /digest does not match/
  );
  await assert.rejects(
    applySetupPlan(setupOptions(fixture, {
      planId: plan.plan_id,
      planDigest: plan.plan_digest,
      nowMs: 1_011
    })),
    /expired/
  );
  await assert.rejects(access(path.join(fixture.codexHome, 'pets', 'buddy-byte')));
  assert.equal((await readMode({ root: plan.workspace_root, dataDir: fixture.dataDir })).enabled, false);
});

test('setup validates reviewer settings before approving a plan or mutating a pet', async () => {
  const fixture = await fixtureCatalog();
  const primaryCredential = ['xai-', 'A9_bC7-dE5_fG3-hJ1_kL8'].join('');
  const secondaryCredential = ['sk-proj-', 'Q7mN2vR9_kL4pX8aC6Zt1Yw5'].join('');
  await assert.rejects(
    createSetupPlan(setupOptions(fixture, { model: 'grok 4.5' })),
    /Invalid Buddy mode model/
  );
  await assert.rejects(
    createSetupPlan(setupOptions(fixture, { model: primaryCredential })),
    /Invalid Buddy mode model/
  );
  await assert.rejects(
    createSetupPlan(setupOptions(fixture, {
      secondaryProvider: 'claude',
      secondaryModel: secondaryCredential,
      secondaryEffort: 'high'
    })),
    /Invalid Buddy secondary reviewer model/
  );
  await assert.rejects(
    createSetupPlan(setupOptions(fixture, { effort: 'ultra' })),
    /Invalid Buddy reasoning effort/
  );
  for (const effort of ['xhigh', 'max']) {
    await assert.rejects(
      createSetupPlan(setupOptions(fixture, { provider: 'ollama', effort })),
      /Invalid Buddy reasoning effort for ollama/
    );
    await assert.rejects(
      createSetupPlan(setupOptions(fixture, {
        provider: 'grok',
        secondaryProvider: 'ollama',
        secondaryModel: 'qwen3-coder:cloud',
        secondaryEffort: effort
      })),
      /Invalid Buddy secondary reviewer reasoning effort for ollama/
    );
  }
  await assert.rejects(
    createSetupPlan(setupOptions(fixture, { timeoutMs: 480_001 })),
    /Invalid Buddy timeout/
  );
  await assert.rejects(
    createSetupPlan(setupOptions(fixture, { secondaryModel: 'grok-4.5' })),
    /secondary reviewer configuration/
  );
  await assert.rejects(
    createSetupPlan(setupOptions(fixture, { secondaryProvider: 'ollama' })),
    /distinct provider\/model connections/
  );
  await assert.rejects(
    createSetupPlan(setupOptions(fixture, { singleReviewer: true, secondaryProvider: 'grok' })),
    /configure and clear/
  );
  await assert.rejects(
    createSetupPlan(setupOptions(fixture, { secondaryProvider: null })),
    /singleReviewer/
  );
  await assert.rejects(access(path.join(fixture.codexHome, 'pets', 'buddy-byte')));
  await assert.rejects(access(path.join(fixture.dataDir, 'setup', 'plans')));
});

test('apply rejects stale mode revision and changed pet hashes without overwriting them', async () => {
  const modeFixture = await fixtureCatalog();
  const modePlan = await createSetupPlan(setupOptions(modeFixture));
  await changeMode({ root: modePlan.workspace_root, dataDir: modeFixture.dataDir, action: 'enable' });
  await assert.rejects(
    applySetupPlan(setupOptions(modeFixture, {
      planId: modePlan.plan_id,
      planDigest: modePlan.plan_digest
    })),
    /mode revision changed/
  );
  await assert.rejects(access(path.join(modeFixture.codexHome, 'pets', 'buddy-byte')));

  const petFixture = await fixtureCatalog();
  const petPlan = await createSetupPlan(setupOptions(petFixture));
  const target = path.join(petFixture.codexHome, 'pets', 'buddy-byte');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'pet.json'), 'external manifest');
  await writeFile(path.join(target, 'spritesheet.webp'), 'external sprite');
  await assert.rejects(
    applySetupPlan(setupOptions(petFixture, {
      planId: petPlan.plan_id,
      planDigest: petPlan.plan_digest
    })),
    /pet hashes or ownership changed/
  );
  assert.equal(await readFile(path.join(target, 'spritesheet.webp'), 'utf8'), 'external sprite');
});

test('apply rejects a changed backup inventory before its first approved mutation', async () => {
  const fixture = await fixtureCatalog();
  const plan = await createSetupPlan(setupOptions(fixture));
  await installPet('buddy-byte', fixture);
  await removePet('buddy-byte', fixture);
  await assert.rejects(
    applySetupPlan(setupOptions(fixture, {
      planId: plan.plan_id,
      planDigest: plan.plan_digest
    })),
    /pet backups changed/
  );
  await assert.rejects(access(path.join(fixture.codexHome, 'pets', 'buddy-byte')));
  assert.equal((await readMode({ root: plan.workspace_root, dataDir: fixture.dataDir })).enabled, false);
});

test('apply rejects stale plugin version, workspace, and canonical Codex home', async () => {
  const fixture = await fixtureCatalog();
  const pluginRoot = path.join(fixture.root, 'plugin');
  await writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
    name: 'codex-buddy-reviewer', version: '1.0.0'
  });
  const plan = await createSetupPlan(setupOptions(fixture, { pluginRoot }));
  await writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
    name: 'codex-buddy-reviewer', version: '1.0.1'
  });
  await assert.rejects(
    applySetupPlan(setupOptions(fixture, {
      pluginRoot,
      planId: plan.plan_id,
      planDigest: plan.plan_digest
    })),
    /plugin version or root changed/
  );

  const fresh = await fixtureCatalog();
  const freshPlan = await createSetupPlan(setupOptions(fresh));
  await assert.rejects(
    applySetupPlan(setupOptions(fresh, {
      root: path.join(fresh.root, 'different-workspace'),
      planId: freshPlan.plan_id,
      planDigest: freshPlan.plan_digest
    })),
    /workspace changed/
  );
  await assert.rejects(
    applySetupPlan(setupOptions(fresh, {
      codexHome: path.join(fresh.root, 'different-home'),
      planId: freshPlan.plan_id,
      planDigest: freshPlan.plan_digest
    })),
    /Codex home changed/
  );
});

test('rollback refuses later pet or mode changes before mutating either subsystem', async () => {
  const fixture = await fixtureCatalog();
  const plan = await createSetupPlan(setupOptions(fixture));
  await applySetupPlan(setupOptions(fixture, { planId: plan.plan_id, planDigest: plan.plan_digest }));
  const target = path.join(fixture.codexHome, 'pets', 'buddy-byte');
  await writeFile(path.join(target, 'spritesheet.webp'), 'later user change');
  await assert.rejects(
    rollbackSetupPlan(setupOptions(fixture, {
      planId: plan.plan_id,
      planDigest: plan.plan_digest
    })),
    /pet hashes or ownership changed after apply/
  );
  assert.equal(await readFile(path.join(target, 'spritesheet.webp'), 'utf8'), 'later user change');
  assert.equal((await readMode({ root: plan.workspace_root, dataDir: fixture.dataDir })).enabled, true);
});

test('stored plans are immutable and can be read only with their exact digest', async () => {
  const fixture = await fixtureCatalog();
  const plan = await createSetupPlan(setupOptions(fixture, { secondaryProvider: 'claude' }));
  assert.deepEqual(
    await readSetupPlan({ dataDir: fixture.dataDir, planId: plan.plan_id, planDigest: plan.plan_digest }),
    plan
  );
  await assert.rejects(
    createSetupPlan(setupOptions(fixture, { planId: plan.plan_id, provider: 'grok' })),
    /immutable/
  );

  const file = path.join(fixture.dataDir, 'setup', 'plans', plan.plan_id, '00-plan.json');
  const tampered = JSON.parse(await readFile(file, 'utf8'));
  tampered.payload.desired_mode.secondary_model = 'claude-sonnet-4-5';
  await writeJson(file, tampered);
  await assert.rejects(
    readSetupPlan({ dataDir: fixture.dataDir, planId: plan.plan_id, planDigest: plan.plan_digest }),
    /digest does not match its immutable body/
  );

  tampered.payload.desired_mode.secondary_model = ['xai-', 'A9_bC7-dE5_fG3-hJ1_kL8'].join('');
  const { plan_digest: _oldDigest, ...tamperedBody } = tampered.payload;
  tampered.payload.plan_digest = hash(canonicalJson(tamperedBody));
  await writeJson(file, tampered);
  await assert.rejects(
    readSetupPlan({
      dataDir: fixture.dataDir,
      planId: plan.plan_id,
      planDigest: tampered.payload.plan_digest
    }),
    /stored plan reviewer configuration is invalid: Invalid Buddy secondary reviewer model/
  );
});

test('setup cleanup removes only expired never-started plans for the selected workspace', async () => {
  const fixture = await fixtureCatalog();
  const secondWorkspace = path.join(fixture.root, 'second-workspace');
  await mkdir(secondWorkspace, { recursive: true });
  const first = await createSetupPlan(setupOptions(fixture, { nowMs: 1_000, ttlMs: 10 }));
  const second = await createSetupPlan(setupOptions(fixture, {
    root: secondWorkspace,
    nowMs: 1_000,
    ttlMs: 10
  }));

  const result = await pruneSetupPlansForWorkspace({
    root: fixture.workspace,
    resolveRoot: async (value) => value,
    dataDir: fixture.dataDir,
    nowMs: 1_011
  });
  assert.equal(result.removed, 1);
  assert.equal(result.preserved, 1);
  await assert.rejects(access(path.join(fixture.dataDir, 'setup', 'plans', first.plan_id)));
  await access(path.join(fixture.dataDir, 'setup', 'plans', second.plan_id));
});

test('setup cleanup retains terminal plans for 24 hours and then quarantines before removal', async () => {
  const fixture = await fixtureCatalog();
  const plan = await createSetupPlan(setupOptions(fixture));
  await applySetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  const planRoot = path.join(fixture.dataDir, 'setup', 'plans', plan.plan_id);
  const terminal = JSON.parse(await readFile(path.join(planRoot, '30-applied.json'), 'utf8'));
  const terminalAt = Date.parse(terminal.recorded_at);
  let renamedFrom = null;
  let renamedTo = null;

  const retained = await pruneSetupPlansForWorkspace({
    root: fixture.workspace,
    resolveRoot: async (value) => value,
    dataDir: fixture.dataDir,
    nowMs: terminalAt + SETUP_TERMINAL_RETENTION_MS - 1
  });
  assert.equal(retained.removed, 0);
  assert.equal(retained.preserved, 1);
  await access(planRoot);

  const removed = await pruneSetupPlansForWorkspace({
    root: fixture.workspace,
    resolveRoot: async (value) => value,
    dataDir: fixture.dataDir,
    nowMs: terminalAt + SETUP_TERMINAL_RETENTION_MS,
    renameImpl: async (source, target) => {
      renamedFrom = source;
      renamedTo = target;
      return rename(source, target);
    }
  });
  assert.equal(removed.removed, 1);
  assert.equal(renamedFrom, planRoot);
  assert.match(path.basename(renamedTo), new RegExp(`^\\.quarantine-${plan.plan_id}-`));
  await assert.rejects(access(planRoot));
  await assert.rejects(access(renamedTo));
});

test('setup cleanup removes a terminal rollback journal only after its retention window', async () => {
  const fixture = await fixtureCatalog();
  const plan = await createSetupPlan(setupOptions(fixture));
  await rollbackSetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  const planRoot = path.join(fixture.dataDir, 'setup', 'plans', plan.plan_id);
  const terminal = JSON.parse(await readFile(path.join(planRoot, '70-rolled-back.json'), 'utf8'));
  const result = await pruneSetupPlansForWorkspace({
    root: fixture.workspace,
    resolveRoot: async (value) => value,
    dataDir: fixture.dataDir,
    nowMs: Date.parse(terminal.recorded_at) + SETUP_TERMINAL_RETENTION_MS
  });
  assert.equal(result.removed, 1);
  await assert.rejects(access(planRoot));
});

test('setup cleanup recovers an owned quarantine left by an interrupted removal', async () => {
  const fixture = await fixtureCatalog();
  const plan = await createSetupPlan(setupOptions(fixture));
  await rollbackSetupPlan(setupOptions(fixture, {
    planId: plan.plan_id,
    planDigest: plan.plan_digest
  }));
  const plansRoot = path.join(fixture.dataDir, 'setup', 'plans');
  const terminal = JSON.parse(await readFile(
    path.join(plansRoot, plan.plan_id, '70-rolled-back.json'),
    'utf8'
  ));
  const nowMs = Date.parse(terminal.recorded_at) + SETUP_TERMINAL_RETENTION_MS;
  const interrupted = await pruneSetupPlansForWorkspace({
    root: fixture.workspace,
    resolveRoot: async (value) => value,
    dataDir: fixture.dataDir,
    nowMs,
    removeImpl: async () => { throw new Error('simulated interrupted quarantine removal'); }
  });
  assert.equal(interrupted.removed, 0);
  assert.equal(interrupted.preserved, 1);
  await assert.rejects(access(path.join(plansRoot, plan.plan_id)));
  const quarantines = (await readdir(plansRoot)).filter((name) => name.startsWith('.quarantine-'));
  assert.equal(quarantines.length, 1);

  const recovered = await pruneSetupPlansForWorkspace({
    root: fixture.workspace,
    resolveRoot: async (value) => value,
    dataDir: fixture.dataDir,
    nowMs
  });
  assert.equal(recovered.removed, 1);
  await assert.rejects(access(path.join(plansRoot, quarantines[0])));
});

test('setup cleanup preserves unresolved, malformed, and needs-attention journals', async () => {
  const unresolvedFixture = await fixtureCatalog();
  const unresolved = await createSetupPlan(setupOptions(unresolvedFixture, {
    nowMs: 1_000,
    ttlMs: 10
  }));
  await assert.rejects(
    applySetupPlan(setupOptions(unresolvedFixture, {
      planId: unresolved.plan_id,
      planDigest: unresolved.plan_digest,
      nowMs: 1_005,
      afterPetMutation: async () => { throw new Error('leave setup apply unresolved'); }
    })),
    /leave setup apply unresolved/
  );
  const unresolvedResult = await pruneSetupPlansForWorkspace({
    root: unresolvedFixture.workspace,
    resolveRoot: async (value) => value,
    dataDir: unresolvedFixture.dataDir,
    nowMs: Date.now() + SETUP_TERMINAL_RETENTION_MS * 2
  });
  assert.equal(unresolvedResult.removed, 0);
  assert.equal(unresolvedResult.preserved, 1);
  await access(path.join(unresolvedFixture.dataDir, 'setup', 'plans', unresolved.plan_id));

  const malformedFixture = await fixtureCatalog();
  const malformed = await createSetupPlan(setupOptions(malformedFixture, { nowMs: 2_000, ttlMs: 10 }));
  const malformedRoot = path.join(malformedFixture.dataDir, 'setup', 'plans', malformed.plan_id);
  await writeFile(path.join(malformedRoot, '00-plan.json'), '{malformed');
  const malformedResult = await pruneSetupPlansForWorkspace({
    root: malformedFixture.workspace,
    resolveRoot: async (value) => value,
    dataDir: malformedFixture.dataDir,
    nowMs: 2_011
  });
  assert.equal(malformedResult.removed, 0);
  assert.equal(malformedResult.refused, 1);
  await access(malformedRoot);

  const needsAttentionFixture = await fixtureCatalog();
  const needsAttention = await createSetupPlan(setupOptions(needsAttentionFixture));
  await applySetupPlan(setupOptions(needsAttentionFixture, {
    planId: needsAttention.plan_id,
    planDigest: needsAttention.plan_digest
  }));
  const needsAttentionRoot = path.join(
    needsAttentionFixture.dataDir,
    'setup',
    'plans',
    needsAttention.plan_id
  );
  const appliedFile = path.join(needsAttentionRoot, '30-applied.json');
  const applied = JSON.parse(await readFile(appliedFile, 'utf8'));
  applied.payload.recovery_status = 'needs_attention';
  await writeFile(appliedFile, `${JSON.stringify(applied, null, 2)}\n`);
  const needsAttentionResult = await pruneSetupPlansForWorkspace({
    root: needsAttentionFixture.workspace,
    resolveRoot: async (value) => value,
    dataDir: needsAttentionFixture.dataDir,
    nowMs: Date.parse(applied.recorded_at) + SETUP_TERMINAL_RETENTION_MS * 2
  });
  assert.equal(needsAttentionResult.removed, 0);
  assert.equal(needsAttentionResult.preserved, 1);
  await access(needsAttentionRoot);
});

test('setup cleanup refuses symlinked plan content and preserves the external target', async () => {
  const fixture = await fixtureCatalog();
  const externalRoot = await temporaryDirectory('codex-buddy-setup-external-');
  const external = path.join(externalRoot, 'operator-owned.txt');
  await writeFile(external, 'keep me');
  const plan = await createSetupPlan(setupOptions(fixture, { nowMs: 3_000, ttlMs: 10 }));
  const planRoot = path.join(fixture.dataDir, 'setup', 'plans', plan.plan_id);
  await symlink(external, path.join(planRoot, 'external-link'));

  const result = await pruneSetupPlansForWorkspace({
    root: fixture.workspace,
    resolveRoot: async (value) => value,
    dataDir: fixture.dataDir,
    nowMs: 3_011
  });
  assert.equal(result.removed, 0);
  assert.equal(result.refused, 1);
  assert.equal(await readFile(external, 'utf8'), 'keep me');
  await access(planRoot);
});

test('setup cleanup refuses a symlinked setup root without touching its external tree', async () => {
  const root = await temporaryDirectory('codex-buddy-setup-root-link-');
  const workspace = path.join(root, 'workspace');
  const dataDir = path.join(root, 'state');
  const externalSetup = await temporaryDirectory('codex-buddy-external-setup-');
  const externalPlans = path.join(externalSetup, 'plans');
  const marker = path.join(externalPlans, 'operator-owned.txt');
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(externalPlans, { mode: 0o700 });
  await writeFile(marker, 'keep external setup tree');
  await symlink(externalSetup, path.join(dataDir, 'setup'));

  await assert.rejects(
    pruneSetupPlansForWorkspace({
      root: workspace,
      resolveRoot: async (value) => value,
      dataDir,
      nowMs: Date.now()
    }),
    /setup state root must be a private owned non-symlink directory/
  );
  assert.equal(await readFile(marker, 'utf8'), 'keep external setup tree');
});

test('setup cleanup bounds each opportunistic scan', async () => {
  const fixture = await fixtureCatalog();
  const first = await createSetupPlan(setupOptions(fixture, { nowMs: 4_000, ttlMs: 10 }));
  const second = await createSetupPlan(setupOptions(fixture, { nowMs: 4_000, ttlMs: 10 }));
  const result = await pruneSetupPlansForWorkspace({
    root: fixture.workspace,
    resolveRoot: async (value) => value,
    dataDir: fixture.dataDir,
    nowMs: 4_011,
    scanLimit: 1
  });
  assert.equal(result.scanned, 1);
  assert.equal(result.removed, 1);
  assert.equal(result.limited, true);
  const survivors = await Promise.all([first, second].map(async (plan) => (
    access(path.join(fixture.dataDir, 'setup', 'plans', plan.plan_id)).then(() => true, () => false)
  )));
  assert.equal(survivors.filter(Boolean).length, 1);
});
