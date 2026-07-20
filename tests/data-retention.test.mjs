import assert from 'node:assert/strict';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseDataArgs, runDataCommand } from '../src/data-cli.mjs';
import { changeMode } from '../src/mode.mjs';
import { appendOutboxEvent } from '../src/outbox.mjs';
import {
  DATA_INVENTORY_BYTE_LIMIT,
  DATA_INVENTORY_ENTRY_LIMIT,
  purgeWorkspaceData,
  workspaceDataStatus
} from '../src/retention.mjs';
import {
  cleanupProviderTempRun,
  createProviderTempRun
} from '../src/providers/temp-state.mjs';
import { opaqueKey, workspaceKey } from '../src/state.mjs';

const temporaryPaths = [];
test.after(async () => Promise.all(
  temporaryPaths.map((item) => rm(item, { recursive: true, force: true }))
));

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function writeEmptyFiles(directory, count, prefix) {
  const batchSize = 128;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(count, start + batchSize);
    await Promise.all(Array.from({ length: end - start }, (_, offset) => (
      writeFile(path.join(directory, `${prefix}-${start + offset}`), '')
    )));
  }
}

test('data command requires explicit purge acknowledgement and scopes settings flags', () => {
  assert.equal(parseDataArgs([]).action, 'status');
  assert.equal(parseDataArgs(['purge', '--confirm-purge']).confirmPurge, true);
  assert.throws(() => parseDataArgs(['purge']), /requires --confirm-purge/);
  assert.throws(() => parseDataArgs(['status', '--confirm-purge']), /only for data purge/);
  assert.throws(() => parseDataArgs(['status', '--include-settings']), /only for data purge/);
  assert.throws(() => parseDataArgs(['unknown']), /must be status or purge/);
});

test('data purge refuses while an outbound provider capability remains active', async () => {
  let purged = false;
  await assert.rejects(
    runDataCommand(['purge', '--confirm-purge'], {
      repositoryRoot: '/private/test/active-capability-repository',
      withProviderLane: async (_options, callback) => callback(),
      readMode: async () => ({ enabled: false }),
      readEgressRegistry: async () => ({ active: [{ capability_id: 'active' }] }),
      purgeWorkspaceData: async () => {
        purged = true;
      }
    }),
    /provider capability record\(s\) are still active/
  );
  assert.equal(purged, false);
});

test('data purge refuses enabled automatic mode before inspecting or deleting content', async () => {
  let registryRead = false;
  let purged = false;
  await assert.rejects(
    runDataCommand(['purge', '--confirm-purge'], {
      repositoryRoot: '/private/test/enabled-mode-repository',
      withProviderLane: async (_options, callback) => callback(),
      readMode: async () => ({ enabled: true }),
      readEgressRegistry: async () => {
        registryRead = true;
        return { active: [] };
      },
      purgeWorkspaceData: async () => {
        purged = true;
      }
    }),
    /automatic review mode is enabled/
  );
  assert.equal(registryRead, false);
  assert.equal(purged, false);
});

test('data purge proceeds inside the provider lane when mode is disabled and capabilities are drained', async () => {
  const expected = { workspace_key: 'a'.repeat(16), removed: [] };
  let laneEntered = false;
  const output = await runDataCommand(['purge', '--confirm-purge'], {
    repositoryRoot: '/private/test/disabled-mode-repository',
    withProviderLane: async (_options, callback) => {
      laneEntered = true;
      return callback();
    },
    readMode: async () => ({ enabled: false }),
    readEgressRegistry: async () => ({ active: [] }),
    purgeWorkspaceData: async () => expected
  });
  assert.equal(laneEntered, true);
  assert.equal(output.result, expected);
});

test('real workspace mode must be disabled before content can be purged', async () => {
  const dataDir = await temporaryDirectory('buddy-retention-mode-data-');
  const runtimeDataDir = await temporaryDirectory('buddy-retention-mode-runtime-');
  const providerTempBase = await temporaryDirectory('buddy-retention-mode-provider-');
  const root = '/private/test/retention-mode-repository';
  const receipt = path.join(dataDir, 'reviews', workspaceKey(root), 'manual-review', 'result.json');
  await mkdir(path.dirname(receipt), { recursive: true });
  await writeFile(receipt, '{"private":"content"}\n');
  await changeMode({ root, action: 'enable', dataDir });

  await assert.rejects(
    runDataCommand(['purge', '--confirm-purge'], {
      repositoryRoot: root, dataDir, runtimeDataDir, providerTempBase
    }),
    /automatic review mode is enabled/
  );
  await lstat(receipt);

  await changeMode({ root, action: 'disable', dataDir });
  const output = await runDataCommand(
    ['purge', '--confirm-purge'],
    { repositoryRoot: root, dataDir, runtimeDataDir, providerTempBase }
  );
  assert.equal(output.action, 'purge');
  await assert.rejects(lstat(receipt));
});

test('include-settings removes the drained workspace egress registry through the real provider lane', async () => {
  const dataDir = await temporaryDirectory('buddy-retention-egress-data-');
  const runtimeDataDir = await temporaryDirectory('buddy-retention-egress-runtime-');
  const providerTempBase = await temporaryDirectory('buddy-retention-egress-provider-');
  const root = '/private/test/retention-egress-repository';
  const egressDirectory = path.join(dataDir, 'egress', workspaceKey(root));
  await mkdir(egressDirectory, { recursive: true });
  await writeFile(path.join(egressDirectory, 'active.json'), `${JSON.stringify({
    schema_version: '2', workspace_key: workspaceKey(root), active: []
  })}\n`);

  const output = await runDataCommand(
    ['purge', '--confirm-purge', '--include-settings'],
    { repositoryRoot: root, dataDir, runtimeDataDir, providerTempBase }
  );
  assert.equal(output.result.removed.includes('egress_registry'), true);
  await assert.rejects(lstat(egressDirectory));
});

test('workspace purge removes content and legacy outbox state but retains content-free tombstones and settings', async () => {
  const dataDir = await temporaryDirectory('buddy-retention-data-');
  const runtimeDataDir = await temporaryDirectory('buddy-retention-runtime-');
  const providerTempBase = await temporaryDirectory('buddy-retention-provider-');
  const root = '/private/test/retention-repository';
  const workspace = workspaceKey(root);
  const reviewKey = 'd'.repeat(64);

  const manualReceipt = path.join(dataDir, 'reviews', workspace, 'manual-review', 'evidence.json');
  const automaticReceipt = path.join(runtimeDataDir, 'automatic-reviews', workspace, `${reviewKey}.json`);
  const rendererCursor = path.join(runtimeDataDir, 'renderers', workspace, 'local.json');
  const modeFile = path.join(dataDir, 'mode', `${workspace}.json`);
  const summaryGuardFile = path.join(dataDir, 'summary-claim-guard', `${workspace}.json`);
  const presentationFile = path.join(dataDir, 'presentation', workspace, 'profile.json');
  const circuitFile = path.join(runtimeDataDir, 'circuits', workspace, 'reviewer.json');
  const egressFile = path.join(dataDir, 'egress', workspace, 'active.json');
  const setupRecord = path.join(dataDir, 'setup', 'plans', 'shared-plan', '00-plan.json');
  const turnDir = path.join(
    runtimeDataDir,
    'turns',
    workspace,
    opaqueKey('retention-session'),
    opaqueKey('retention-turn')
  );
  await Promise.all([
    mkdir(path.dirname(manualReceipt), { recursive: true }),
    mkdir(path.dirname(automaticReceipt), { recursive: true }),
    mkdir(path.dirname(rendererCursor), { recursive: true }),
    mkdir(path.dirname(modeFile), { recursive: true }),
    mkdir(path.dirname(summaryGuardFile), { recursive: true }),
    mkdir(path.dirname(presentationFile), { recursive: true }),
    mkdir(path.dirname(circuitFile), { recursive: true }),
    mkdir(path.dirname(egressFile), { recursive: true }),
    mkdir(path.dirname(setupRecord), { recursive: true }),
    mkdir(path.join(turnDir, 'snapshot'), { recursive: true })
  ]);
  await Promise.all([
    writeFile(manualReceipt, '{"patch":"PRIVATE_MANUAL_CONTENT"}\n'),
    writeFile(automaticReceipt, '{"result":"PRIVATE_AUTOMATIC_CONTENT"}\n'),
    writeFile(rendererCursor, '{"cursor":"private"}\n'),
    writeFile(modeFile, '{"enabled":true}\n'),
    writeFile(summaryGuardFile, '{"enabled":true}\n'),
    writeFile(presentationFile, '{"pet_id":"buddy-bella"}\n'),
    writeFile(circuitFile, '{"consecutive_failures":1}\n'),
    writeFile(egressFile, `${JSON.stringify({
      schema_version: '2', workspace_key: workspace, active: []
    })}\n`),
    writeFile(setupRecord, '{"workspace_path":"PRIVATE_SETUP_STATE"}\n'),
    writeFile(path.join(turnDir, 'baseline.json'), `${JSON.stringify({
      snapshot: { captured_at: '2020-01-01T00:00:00.000Z' }
    })}\n`),
    writeFile(path.join(turnDir, 'attempt.json'), `${JSON.stringify({ review_key: reviewKey })}\n`)
  ]);

  const legacy = await appendOutboxEvent({
    repositoryRoot: root,
    runtimeDataDir,
    sessionId: 'legacy-session',
    turnId: 'legacy-turn',
    type: 'turn_started',
    state: 'working',
    headline: 'Legacy renderer event',
    occurredAt: '2020-01-01T00:00:00.000Z'
  });
  const legacyValue = JSON.parse(await readFile(legacy.file, 'utf8'));
  delete legacyValue.sequence;
  legacyValue.schema_version = '1';
  await writeFile(legacy.file, `${JSON.stringify(legacyValue)}\n`);

  const before = await workspaceDataStatus({ root, dataDir, runtimeDataDir, providerTempBase });
  assert.equal(before.complete, true);
  assert.equal(before.totals.content_files > 0, true);
  assert.equal(before.totals.outside_scope_files > 0, true);
  assert.equal(
    before.preserved_outside_scope.find((item) => item.id === 'setup_plans_and_journals')?.files,
    1
  );
  assert.equal(before.settings.find((item) => item.id === 'egress_registry')?.exists, true);
  const result = await purgeWorkspaceData({
    root,
    dataDir,
    runtimeDataDir,
    providerTempBase,
    includeSettings: false,
    now: Date.parse('2020-01-03T00:00:00.000Z')
  });
  assert.equal(result.include_settings, false);
  assert.equal(result.removed.includes('manual_reviews'), true);
  assert.equal(result.removed.includes('renderer_outbox'), true);
  assert.equal(
    result.preserved_outside_scope.some((item) => item.id === 'setup_plans_and_journals'),
    true
  );
  for (const target of [manualReceipt, automaticReceipt, rendererCursor, legacy.file]) {
    await assert.rejects(lstat(target));
  }
  for (const target of [modeFile, summaryGuardFile, presentationFile, circuitFile, egressFile]) {
    await lstat(target);
  }
  await lstat(setupRecord);
  const completed = JSON.parse(await readFile(path.join(turnDir, 'completed.json'), 'utf8'));
  assert.equal(completed.terminal_status, 'prior_attempt_incomplete');
  assert.equal(completed.review_key, reviewKey);
  await assert.rejects(lstat(path.join(turnDir, 'baseline.json')));
  await assert.rejects(lstat(path.join(turnDir, 'attempt.json')));

  const settingsResult = await purgeWorkspaceData({
    root,
    dataDir,
    runtimeDataDir,
    providerTempBase,
    includeSettings: true,
    now: Date.parse('2020-01-03T00:00:01.000Z')
  });
  assert.equal(settingsResult.include_settings, true);
  assert.equal(settingsResult.removed.includes('egress_registry'), true);
  for (const target of [modeFile, summaryGuardFile, presentationFile, circuitFile, egressFile]) {
    await assert.rejects(lstat(target));
  }
  await lstat(setupRecord);
});

test('workspace purge refuses symlinked state ancestors without touching their destination', async () => {
  const dataDir = await temporaryDirectory('buddy-retention-link-data-');
  const runtimeDataDir = await temporaryDirectory('buddy-retention-link-runtime-');
  const providerTempBase = await temporaryDirectory('buddy-retention-link-provider-');
  const outside = await temporaryDirectory('buddy-retention-link-outside-');
  const root = '/private/test/retention-link-repository';
  const sentinel = path.join(outside, 'sentinel.txt');
  await writeFile(sentinel, 'must remain\n');
  await symlink(outside, path.join(dataDir, 'reviews'));

  await assert.rejects(
    purgeWorkspaceData({ root, dataDir, runtimeDataDir, providerTempBase, includeSettings: false }),
    /symbolic link/
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'must remain\n');
});

test('workspace purge recursively rejects a nested turn symlink before deleting other content', async () => {
  const dataDir = await temporaryDirectory('buddy-retention-nested-link-data-');
  const runtimeDataDir = await temporaryDirectory('buddy-retention-nested-link-runtime-');
  const providerTempBase = await temporaryDirectory('buddy-retention-nested-link-provider-');
  const outside = await temporaryDirectory('buddy-retention-nested-link-outside-');
  const root = '/private/test/retention-nested-link-repository';
  const workspace = workspaceKey(root);
  const manualReceipt = path.join(dataDir, 'reviews', workspace, 'manual-review', 'result.json');
  const turnWorkspace = path.join(runtimeDataDir, 'turns', workspace);
  const sentinel = path.join(outside, 'sentinel.txt');
  await mkdir(path.dirname(manualReceipt), { recursive: true });
  await mkdir(turnWorkspace, { recursive: true });
  await writeFile(manualReceipt, '{"private":"must remain"}\n');
  await writeFile(sentinel, 'outside must remain\n');
  await symlink(outside, path.join(turnWorkspace, opaqueKey('unsafe-session')));

  await assert.rejects(
    purgeWorkspaceData({ root, dataDir, runtimeDataDir, providerTempBase, includeSettings: false }),
    /symbolic link/
  );
  assert.equal(await readFile(manualReceipt, 'utf8'), '{"private":"must remain"}\n');
  assert.equal(await readFile(sentinel, 'utf8'), 'outside must remain\n');
});

test('workspace purge preflights preserved settings before deleting review content', async () => {
  const dataDir = await temporaryDirectory('buddy-retention-setting-link-data-');
  const runtimeDataDir = await temporaryDirectory('buddy-retention-setting-link-runtime-');
  const providerTempBase = await temporaryDirectory('buddy-retention-setting-link-provider-');
  const outside = await temporaryDirectory('buddy-retention-setting-link-outside-');
  const root = '/private/test/retention-setting-link-repository';
  const workspace = workspaceKey(root);
  const manualReceipt = path.join(dataDir, 'reviews', workspace, 'manual', 'result.json');
  const presentationRoot = path.join(dataDir, 'presentation');
  const sentinel = path.join(outside, 'sentinel.txt');
  await mkdir(path.dirname(manualReceipt), { recursive: true });
  await mkdir(presentationRoot, { recursive: true });
  await writeFile(manualReceipt, '{"private":"must remain"}\n');
  await writeFile(sentinel, 'outside must remain\n');
  await symlink(outside, path.join(presentationRoot, workspace));

  await assert.rejects(
    purgeWorkspaceData({
      root,
      dataDir,
      runtimeDataDir,
      providerTempBase,
      includeSettings: false
    }),
    /symbolic link/
  );
  assert.equal(await readFile(manualReceipt, 'utf8'), '{"private":"must remain"}\n');
  assert.equal(await readFile(sentinel, 'utf8'), 'outside must remain\n');
});

test('workspace status and purge integrate provider attribution while preserving live and other-workspace runs', {
  skip: process.platform === 'win32'
}, async () => {
  const root = await temporaryDirectory('buddy-retention-provider-root-');
  const otherRoot = await temporaryDirectory('buddy-retention-provider-other-root-');
  const dataDir = await temporaryDirectory('buddy-retention-provider-data-');
  const runtimeDataDir = await temporaryDirectory('buddy-retention-provider-runtime-');
  const providerTempBase = await temporaryDirectory('buddy-retention-provider-temp-');
  const dead = await createProviderTempRun({
    root,
    provider: 'claude',
    tempBase: providerTempBase,
    pid: 5101
  });
  const live = await createProviderTempRun({
    root,
    provider: 'opencode',
    tempBase: providerTempBase,
    pid: 5102,
    processAliveImpl: () => true
  });
  const other = await createProviderTempRun({
    root: otherRoot,
    provider: 'grok',
    tempBase: providerTempBase,
    pid: 5103,
    processAliveImpl: () => true
  });
  await writeFile(path.join(dead.directory, 'private-state'), 'temporary private bytes\n');

  const status = await workspaceDataStatus({
    root,
    dataDir,
    runtimeDataDir,
    providerTempBase,
    providerProcessAliveImpl: (pid) => pid === 5102
  });
  assert.equal(status.complete, true);
  assert.equal(status.provider_temporary.attributed_runs, 2);
  assert.equal(status.provider_temporary.live_runs, 1);
  assert.equal(status.totals.provider_temporary_files >= 3, true);

  const purged = await purgeWorkspaceData({
    root,
    dataDir,
    runtimeDataDir,
    providerTempBase,
    providerProcessAliveImpl: (pid) => pid === 5102,
    includeSettings: false
  });
  assert.equal(purged.provider_temporary.removed_runs, 1);
  assert.equal(purged.provider_temporary.retained_live_runs, 1);
  await assert.rejects(access(dead.directory));
  await access(live.directory);
  await access(other.directory);
  await cleanupProviderTempRun(live);
  await cleanupProviderTempRun(other);
});

test('durable data inventory reports exact limit reason and purge refuses before touching another target', async () => {
  const root = await temporaryDirectory('buddy-retention-bounded-root-');
  const dataDir = await temporaryDirectory('buddy-retention-bounded-data-');
  const runtimeDataDir = await temporaryDirectory('buddy-retention-bounded-runtime-');
  const providerTempBase = await temporaryDirectory('buddy-retention-bounded-provider-');
  const workspace = workspaceKey(root);
  const manualRoot = path.join(dataDir, 'reviews', workspace);
  let nested = manualRoot;
  for (let depth = 0; depth <= 65; depth += 1) {
    nested = path.join(nested, `d${depth}`);
    await mkdir(nested, { mode: 0o700, recursive: true });
  }
  const safeReceipt = path.join(
    runtimeDataDir,
    'automatic-reviews',
    workspace,
    'safe-result.json'
  );
  await mkdir(path.dirname(safeReceipt), { recursive: true });
  await writeFile(safeReceipt, '{"must":"survive refused purge"}\n');

  const status = await workspaceDataStatus({ root, dataDir, runtimeDataDir, providerTempBase });
  assert.equal(status.complete, false);
  assert.equal(status.incomplete_reasons.includes('depth_limit'), true);
  assert.equal(
    status.content.find((item) => item.id === 'manual_reviews')?.incomplete_reason,
    'depth_limit'
  );
  await assert.rejects(
    purgeWorkspaceData({
      root,
      dataDir,
      runtimeDataDir,
      providerTempBase,
      includeSettings: false
    }),
    /data inventory is incomplete: depth_limit/
  );
  assert.equal(await readFile(safeReceipt, 'utf8'), '{"must":"survive refused purge"}\n');

  let tick = 0;
  const deadline = await workspaceDataStatus({
    root,
    dataDir,
    runtimeDataDir,
    providerTempBase,
    dataInventoryMonotonicNowImpl: () => {
      tick += 2_000;
      return tick;
    }
  });
  assert.equal(deadline.complete, false);
  assert.equal(deadline.incomplete_reasons.includes('deadline'), true);
});

test('durable data entry and byte limits are explicit and refuse purge before mutation', async () => {
  const root = await temporaryDirectory('buddy-retention-entry-byte-root-');
  const dataDir = await temporaryDirectory('buddy-retention-entry-byte-data-');
  const runtimeDataDir = await temporaryDirectory('buddy-retention-entry-byte-runtime-');
  const providerTempBase = await temporaryDirectory('buddy-retention-entry-byte-provider-');
  const workspace = workspaceKey(root);
  const manualRoot = path.join(dataDir, 'reviews', workspace);
  const safeReceipt = path.join(
    runtimeDataDir,
    'automatic-reviews',
    workspace,
    'safe-result.json'
  );
  await mkdir(manualRoot, { recursive: true });
  await mkdir(path.dirname(safeReceipt), { recursive: true });
  await writeFile(safeReceipt, '{"must":"survive both refusals"}\n');
  await writeEmptyFiles(manualRoot, DATA_INVENTORY_ENTRY_LIMIT + 1, 'entry');

  const entryStatus = await workspaceDataStatus({
    root,
    dataDir,
    runtimeDataDir,
    providerTempBase,
    dataInventoryMonotonicNowImpl: () => 0
  });
  assert.equal(entryStatus.complete, false);
  assert.equal(entryStatus.incomplete_reasons.includes('entry_limit'), true);
  await assert.rejects(
    purgeWorkspaceData({
      root,
      dataDir,
      runtimeDataDir,
      providerTempBase,
      includeSettings: false,
      dataInventoryMonotonicNowImpl: () => 0
    }),
    /data inventory is incomplete: entry_limit/
  );
  assert.equal(await readFile(safeReceipt, 'utf8'), '{"must":"survive both refusals"}\n');

  await rm(manualRoot, { recursive: true, force: true });
  await mkdir(manualRoot, { recursive: true });
  const oversized = path.join(manualRoot, 'oversized-private-state.bin');
  await writeFile(oversized, 'x');
  await truncate(oversized, DATA_INVENTORY_BYTE_LIMIT + 1);
  const byteStatus = await workspaceDataStatus({
    root,
    dataDir,
    runtimeDataDir,
    providerTempBase,
    dataInventoryMonotonicNowImpl: () => 0
  });
  assert.equal(byteStatus.complete, false);
  assert.equal(byteStatus.incomplete_reasons.includes('byte_limit'), true);
  await assert.rejects(
    purgeWorkspaceData({
      root,
      dataDir,
      runtimeDataDir,
      providerTempBase,
      includeSettings: false,
      dataInventoryMonotonicNowImpl: () => 0
    }),
    /data inventory is incomplete: byte_limit/
  );
  assert.equal(await readFile(safeReceipt, 'utf8'), '{"must":"survive both refusals"}\n');
});
