import { readEgressRegistry, withProviderLane } from './egress-capability.mjs';
import { readMode, resolveRepositoryRoot } from './mode.mjs';
import { purgeWorkspaceData, workspaceDataStatus } from './retention.mjs';

export const DATA_HELP = `Codex Buddy Reviewer private data controls

Usage:
  buddy-review.mjs data status [options]
  buddy-review.mjs data purge --confirm-purge [options]

Options:
  --cwd <path>                 Git workspace (default: current directory)
  --data-dir <path>            Buddy durable private-state root
  --runtime-data-dir <path>    Buddy automatic-review runtime-state root
  --confirm-purge              Required acknowledgement for purge
  --include-settings           Also remove workspace mode, reviewer, presentation, and circuit settings
  --json                       Emit machine-readable JSON
  -h, --help                   Show this help

Purge is workspace-scoped. It removes manual receipts, automatic review
content, renderer events, renderer cursors, and attributable non-live provider
temporary runs. Minimal content-free turn tombstones remain to prevent a
completed provider review from running again. The pet install registry and
backups remain shared state outside review-content purge.

Provider credentials are absent from durable workspace state. A selected
OpenCode auth entry or other CLI authentication material can exist transiently
inside a Buddy-owned provider temporary run and is removed only through the
verified run cleanup boundary. External provider CLI authentication is never
deleted by this command.
`;

export function parseDataArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('-') ? args.shift() : 'status';
  if (!['status', 'purge'].includes(action)) {
    throw new Error('data action must be status or purge');
  }
  const options = { action, json: false, includeSettings: false, confirmPurge: false };
  const values = new Set(['--cwd', '--data-dir', '--runtime-data-dir']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--confirm-purge') options.confirmPurge = true;
    else if (arg === '--include-settings') options.includeSettings = true;
    else if (values.has(arg)) {
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === '--cwd') options.cwd = value;
      if (arg === '--data-dir') options.dataDir = value;
      if (arg === '--runtime-data-dir') options.runtimeDataDir = value;
    } else throw new Error(`unknown data argument: ${arg}`);
  }
  if (action === 'status' && options.confirmPurge) {
    throw new Error('--confirm-purge is allowed only for data purge');
  }
  if (action === 'status' && options.includeSettings) {
    throw new Error('--include-settings is allowed only for data purge');
  }
  if (!options.help && action === 'purge' && !options.confirmPurge) {
    throw new Error('data purge requires --confirm-purge');
  }
  return options;
}

export async function runDataCommand(argv, dependencies = {}) {
  const options = parseDataArgs(argv);
  if (options.help) return { help: DATA_HELP, json: options.json };
  const root = dependencies.repositoryRoot
    ?? await (dependencies.resolveRoot ?? resolveRepositoryRoot)(options.cwd);
  const dataDir = dependencies.dataDir ?? options.dataDir;
  const runtimeDataDir = dependencies.runtimeDataDir ?? options.runtimeDataDir;
  const readRegistry = dependencies.readEgressRegistry ?? readEgressRegistry;
  const readWorkspaceMode = dependencies.readMode ?? readMode;
  const readStatus = dependencies.workspaceDataStatus ?? workspaceDataStatus;
  const purge = dependencies.purgeWorkspaceData ?? purgeWorkspaceData;

  if (options.action === 'status') {
    const [registry, mode] = await Promise.all([
      readRegistry({ root, dataDir }),
      readWorkspaceMode({ root, dataDir })
    ]);
    // Registry reads can migrate expired records and create their private lock
    // path. Inventory after those reads so status never races its own setup.
    const status = await readStatus({
      root,
      dataDir,
      runtimeDataDir,
      providerTempBase: dependencies.providerTempBase,
      providerProcessAliveImpl: dependencies.providerProcessAliveImpl,
      dataInventoryMonotonicNowImpl: dependencies.dataInventoryMonotonicNowImpl,
      providerInventoryMonotonicNowImpl: dependencies.providerInventoryMonotonicNowImpl,
      platform: dependencies.platform
    });
    return {
      action: 'status',
      result: {
        ...status,
        mode_enabled: mode.enabled,
        active_provider_capabilities: registry.active.length
      },
      json: options.json
    };
  }

  const runInProviderLane = dependencies.withProviderLane ?? withProviderLane;
  const result = await runInProviderLane({ root, dataDir }, async () => {
    const mode = await readWorkspaceMode({ root, dataDir });
    if (mode.enabled) {
      throw new Error('Buddy data purge refused because automatic review mode is enabled for this workspace');
    }
    const registry = await readRegistry({ root, dataDir });
    if (registry.active.length > 0) {
      throw new Error(
        `Buddy data purge refused because ${registry.active.length} provider capability `
        + 'record(s) are still active'
      );
    }
    return purge({
      root,
      dataDir,
      runtimeDataDir,
      includeSettings: options.includeSettings,
      providerTempBase: dependencies.providerTempBase,
      providerProcessAliveImpl: dependencies.providerProcessAliveImpl,
      providerRandomBytesImpl: dependencies.providerRandomBytesImpl,
      providerRenameImpl: dependencies.providerRenameImpl,
      providerRemoveImpl: dependencies.providerRemoveImpl,
      dataInventoryMonotonicNowImpl: dependencies.dataInventoryMonotonicNowImpl,
      providerInventoryMonotonicNowImpl: dependencies.providerInventoryMonotonicNowImpl,
      platform: dependencies.platform
    });
  });
  return { action: 'purge', result, json: options.json };
}

export function renderDataCommand(output) {
  if (output.help) return output.help;
  if (output.action === 'purge') {
    return `Buddy removed private review content for workspace ${output.result.workspace_key}.\n`
      + `Removed areas: ${output.result.removed.length ? output.result.removed.join(', ') : 'none found'}.\n`
      + `Content-free turn tombstone files retained: ${output.result.retained_turn_tombstones}.\n`
      + `Provider temporary runs removed: ${output.result.provider_temporary.removed_runs} `
      + `(${output.result.provider_temporary.removed_bytes} bytes).\n`
      + `Live provider temporary runs retained: ${output.result.provider_temporary.retained_live_runs}.\n`
      + `Eligible setup records removed: ${output.result.setup_cleanup.removed}.\n`
      + `Settings ${output.result.include_settings ? 'were included in the purge' : 'were preserved'}.\n`
      + `Preserved outside workspace purge: ${output.result.preserved_outside_scope.map((item) => item.id).join(', ')}.\n`;
  }
  const result = output.result;
  return `Buddy private data for workspace ${result.workspace_key}\n`
    + `Inventory: ${result.complete ? 'complete' : `incomplete (${result.incomplete_reasons.join(', ')})`}\n`
    + `Review/runtime files: ${result.totals.content_files} (${result.totals.content_bytes} bytes)\n`
    + `Settings files: ${result.totals.settings_files} (${result.totals.settings_bytes} bytes)\n`
    + `Provider temporary runs: ${result.provider_temporary.attributed_runs} `
    + `(${result.provider_temporary.files} files, ${result.provider_temporary.bytes} bytes; `
    + `${result.provider_temporary.live_runs} live)\n`
    + `Provider temporary ownership: ${result.provider_temporary.ownership_assurance}\n`
    + `Shared setup/pet state: ${result.totals.outside_scope_files} `
    + `(${result.totals.outside_scope_bytes} bytes)\n`
    + `Automatic review mode: ${result.mode_enabled ? 'enabled' : 'disabled'}\n`
    + `Active provider capabilities: ${result.active_provider_capabilities}\n`
    + `Outside workspace purge: ${result.preserved_outside_scope.map((item) => item.id).join(', ')}\n`
    + 'Use data purge --confirm-purge to remove workspace review content.\n';
}
