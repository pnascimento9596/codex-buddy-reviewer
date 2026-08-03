import { resolveRepositoryRoot } from './mode.mjs';
import {
  changePresentationProfile,
  readCompletedReviewKeys,
  readPresentationProfile
} from './presentation-state.mjs';

export const PRESENTATION_HELP = `Codex Buddy Reviewer presentation

Usage:
  buddy-review.mjs presentation [status|set] [options]

Options:
  --cwd <path>                 Git workspace (default: current directory)
  --pet-id <id>                native:selected or an id printed by pet list
  --personality <name>         precise, warm, or wry
  --json                       Emit machine-readable presentation state
  -h, --help                   Show this help

This selects Buddy's local companion profile. Codex host pet selection remains
in Settings > Pets and the built-in /pet command.
`;

export function parsePresentationArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('-') ? args.shift() : 'status';
  const options = { action, json: false };
  const values = new Set(['--cwd', '--pet-id', '--personality']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (values.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--cwd') options.cwd = value;
      if (arg === '--pet-id') options.petId = value;
      if (arg === '--personality') options.personality = value;
    } else throw new Error(`unknown presentation argument: ${arg}`);
  }
  if (!['status', 'set'].includes(action)) throw new Error('presentation action must be status or set');
  if (action === 'status' && (options.petId !== undefined || options.personality !== undefined)) {
    throw new Error('presentation profile options are only valid for presentation set');
  }
  if (action === 'set' && options.petId === undefined && options.personality === undefined) {
    throw new Error('presentation set requires --pet-id and/or --personality');
  }
  return options;
}

export async function runPresentationCommand(argv, dependencies = {}) {
  const options = parsePresentationArgs(argv);
  if (options.help) return { help: PRESENTATION_HELP };
  const root = await (dependencies.resolveRoot ?? resolveRepositoryRoot)(options.cwd);
  const profile = options.action === 'set'
    ? await changePresentationProfile({
        root,
        dataDir: dependencies.dataDir,
        petId: options.petId,
        personality: options.personality
      })
    : await readPresentationProfile({ root, dataDir: dependencies.dataDir });
  const completedReviewKeys = await readCompletedReviewKeys({ root, dataDir: dependencies.dataDir });
  return {
    json: options.json,
    result: {
      ...profile,
      xp: completedReviewKeys.length * 10,
      completed_reviews: completedReviewKeys.length
    }
  };
}

export function renderPresentationCommand(output) {
  if (output.help) return output.help;
  const profile = output.result;
  return `Buddy presentation · ${profile.pet_id}\n`
    + `Personality: ${profile.personality} · XP: ${profile.xp} · completed reviews: ${profile.completed_reviews}\n`
    + 'Use Settings > Pets, Refresh, and /pet for the native Codex sprite window.\n';
}
