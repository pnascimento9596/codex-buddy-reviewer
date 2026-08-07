import {
  installPet,
  listPets,
  petStatus,
  reconcilePetTransactions,
  removePet,
  restorePet,
  updatePet
} from './pet-catalog.mjs';

const PET_HELP = `Codex Buddy Reviewer pets

Usage:
  buddy-review.mjs pet list [options]
  buddy-review.mjs pet status [options]
  buddy-review.mjs pet install <buddy-pet-id> [options]
  buddy-review.mjs pet update <buddy-pet-id> [options]
  buddy-review.mjs pet remove <buddy-pet-id> [options]
  buddy-review.mjs pet restore <backup-id> [options]
  buddy-review.mjs pet reconcile [options]

Options:
  --codex-home <path>   Codex data root (default: CODEX_HOME or ~/.codex)
  --data-dir <path>     Buddy private state root
  --json                Emit machine-readable output
  -h, --help            Show this help

Pet installation never selects, wakes, or controls the native Codex pet. After
installation, use Settings > Pets > Refresh to select it, then enter /pet once.
`;

export function parsePetArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('-') ? args.shift() : 'list';
  if (!['list', 'status', 'install', 'update', 'remove', 'restore', 'reconcile'].includes(action)) {
    throw new Error('pet action must be list, status, install, update, remove, restore, or reconcile');
  }

  const requiresIdentifier = ['install', 'update', 'remove', 'restore'].includes(action);
  const options = { action, identifier: null, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--codex-home' || arg === '--data-dir') {
      const value = args[index + 1];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) {
        throw new Error(`${arg} requires a non-empty path value`);
      }
      index += 1;
      if (arg === '--codex-home') options.codexHome = value;
      if (arg === '--data-dir') options.dataDir = value;
    } else if (!arg.startsWith('-') && requiresIdentifier && options.identifier === null) {
      options.identifier = arg;
    } else throw new Error(`unknown pet argument: ${arg}`);
  }
  if (!options.help && requiresIdentifier && !options.identifier) {
    throw new Error(`pet ${action} requires an identifier`);
  }
  return options;
}

export async function runPetCommand(argv, overrides = {}) {
  const options = { ...parsePetArgs(argv), ...overrides };
  if (options.help) return { kind: 'help', help: PET_HELP, json: options.json };
  const shared = {
    catalogFile: options.catalogFile,
    codexHome: options.codexHome,
    dataDir: options.dataDir
  };
  if (options.action === 'list') return { kind: 'list', pets: await listPets(shared), json: options.json };
  if (options.action === 'status') return { kind: 'status', ...(await petStatus(shared)), json: options.json };
  if (options.action === 'install') {
    return { kind: 'install', result: await installPet(options.identifier, shared), json: options.json };
  }
  if (options.action === 'update') {
    return { kind: 'update', result: await updatePet(options.identifier, shared), json: options.json };
  }
  if (options.action === 'reconcile') {
    return { kind: 'reconcile', result: await reconcilePetTransactions(shared), json: options.json };
  }
  if (options.action === 'remove') {
    return { kind: 'remove', result: await removePet(options.identifier, shared), json: options.json };
  }
  return { kind: 'restore', result: await restorePet(options.identifier, shared), json: options.json };
}

export function renderPetCommand(output) {
  if (output.kind === 'help') return output.help;
  if (output.kind === 'list') {
    const rows = output.pets.map((pet) => {
      const availability = pet.available ? 'READY' : `NOT READY: ${pet.notReadyReason}`;
      return `- ${pet.displayName} (${pet.id}) [${pet.scope}]: ${availability}`;
    });
    return `Buddy pet catalog\n${rows.join('\n')}\n\nNo pet was selected or woken.\n`;
  }
  if (output.kind === 'status') {
    const rows = output.pets.map((pet) => (
      `- ${pet.displayName} (${pet.id}) [${pet.scope}]: ${pet.installStatus}; asset ${pet.available ? 'ready' : 'not ready'}`
    ));
    const backups = output.backups.length
      ? `\nBackups:\n${output.backups.map((item) => `- ${item.backupId}: ${item.id}`).join('\n')}\n`
      : '\nBackups: none\n';
    return `Buddy pet status\n${rows.join('\n')}\n${backups}`;
  }
  if (output.kind === 'install') {
    return `${output.result.displayName} is ${output.result.action === 'installed' ? 'installed' : 'already installed'} at ${output.result.target}.\n`
      + 'Open Settings > Pets, select Refresh, choose the pet, and enter /pet once. Buddy did not select or wake it automatically.\n';
  }
  if (output.kind === 'update') {
    if (output.result.action === 'already_current') {
      return `${output.result.displayName} is already current at ${output.result.target}.\n`;
    }
    return `${output.result.displayName} was updated at ${output.result.target}.\n`
      + `Rollback backup ID: ${output.result.backupId}\nRollback backup path: ${output.result.backup}\n`;
  }
  if (output.kind === 'reconcile') {
    const attention = output.result.transactions.filter((item) => item.outcome === 'needs_attention');
    return `Buddy pet transaction reconciliation inspected ${output.result.transactions.length} transaction(s).\n`
      + (attention.length
        ? `${attention.length} transaction(s) need manual attention; no ambiguous state was overwritten.\n`
        : 'All transaction states converged without ambiguous overwrites.\n');
  }
  if (output.kind === 'remove') {
    return `${output.result.displayName} was moved to a recoverable backup.\n`
      + `Backup ID: ${output.result.backupId}\nBackup path: ${output.result.backup}\n`;
  }
  return `${output.result.displayName} was restored to ${output.result.target}.\n`
    + 'Open Settings > Pets and select Refresh if the pet is not visible. Buddy did not select or wake it automatically.\n';
}

export { PET_HELP };
