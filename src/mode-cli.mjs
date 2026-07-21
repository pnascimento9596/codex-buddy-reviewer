import { changeMode, resolveRepositoryRoot } from './mode.mjs';

const MODE_HELP = `Codex Buddy Reviewer mode

Usage:
  buddy-review.mjs mode [toggle|enable|disable|status] [options]

Options:
  --cwd <path>                 Git workspace (default: current directory)
  --provider <adapter>         Primary connection: grok, ollama, claude, or opencode
  --model <id>                 Primary reviewer model
  --effort <level>             Primary reviewer reasoning effort
  --also-provider <adapter>    Add a second independent reviewer connection
  --also-model <id>            Secondary model (default: adapter-specific)
  --also-effort <level>        Secondary reasoning effort (default: high)
  --single-reviewer            Clear the secondary reviewer connection
  --continuous-review          Start bounded background review after repository mutations
  --no-continuous-review       Review only at the final Stop hook
  --confidence <0..1>          Publication threshold
  --max-patch-bytes <n>        Sanitized patch cap
  --timeout-seconds <n>        Reviewer deadline, at most 480 seconds
  --json                       Emit machine-readable mode state
  -h, --help                   Show this help

Automatic mode is workspace-scoped, advisory, and fail-open. Use the host's
built-in /pet command to wake or tuck away the animated pet. Enabling
or toggling raw mode remains final-only unless --continuous-review explicitly
authorizes privacy-filtered intermediate change evidence to be sent to each
configured reviewer, up to two speculative batches per turn.
`;

export function parseModeArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('-') ? args.shift() : 'toggle';
  const options = { action, json: false };
  const values = new Set([
    '--cwd', '--provider', '--model', '--effort', '--also-provider', '--also-model', '--also-effort',
    '--confidence', '--max-patch-bytes', '--timeout-seconds'
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--single-reviewer') options.singleReviewer = true;
    else if (arg === '--continuous-review') options.continuousReview = true;
    else if (arg === '--no-continuous-review') options.continuousReview = false;
    else if (values.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--cwd') options.cwd = value;
      if (arg === '--provider') options.provider = value;
      if (arg === '--model') options.model = value;
      if (arg === '--effort') options.effort = value;
      if (arg === '--also-provider') options.secondaryProvider = value;
      if (arg === '--also-model') options.secondaryModel = value;
      if (arg === '--also-effort') options.secondaryEffort = value;
      if (arg === '--confidence') options.minConfidence = Number(value);
      if (arg === '--max-patch-bytes') options.maxPatchBytes = Number(value);
      if (arg === '--timeout-seconds') options.timeoutMs = Number(value) * 1000;
    } else throw new Error(`unknown mode argument: ${arg}`);
  }
  if (!['toggle', 'enable', 'disable', 'status'].includes(options.action)) {
    throw new Error('mode action must be toggle, enable, disable, or status');
  }
  if (options.provider && !['grok', 'ollama', 'claude', 'opencode'].includes(options.provider)) {
    throw new Error('--provider must be grok, ollama, claude, or opencode');
  }
  if (options.secondaryProvider
    && !['grok', 'ollama', 'claude', 'opencode'].includes(options.secondaryProvider)) {
    throw new Error('--also-provider must be grok, ollama, claude, or opencode');
  }
  if (options.singleReviewer && (
    options.secondaryProvider !== undefined
    || options.secondaryModel !== undefined
    || options.secondaryEffort !== undefined
  )) {
    throw new Error('--single-reviewer cannot be combined with --also-provider, --also-model, or --also-effort');
  }
  if (args.includes('--continuous-review') && args.includes('--no-continuous-review')) {
    throw new Error('--continuous-review and --no-continuous-review cannot be combined');
  }
  if (options.minConfidence !== undefined && (
    !Number.isFinite(options.minConfidence) || options.minConfidence < 0 || options.minConfidence > 1
  )) throw new Error('--confidence must be between 0 and 1');
  if (options.maxPatchBytes !== undefined && (
    !Number.isInteger(options.maxPatchBytes) || options.maxPatchBytes < 4096
  )) throw new Error('--max-patch-bytes must be an integer >= 4096');
  if (options.timeoutMs !== undefined && (
    !Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 480_000
  )) throw new Error('--timeout-seconds must be between 1 and 480');
  return options;
}

export async function runModeCommand(argv) {
  const options = parseModeArgs(argv);
  if (options.help) return { help: MODE_HELP };
  const root = await resolveRepositoryRoot(options.cwd);
  const mode = await changeMode({ root, ...options });
  return { mode, json: options.json };
}
