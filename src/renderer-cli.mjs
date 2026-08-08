import { resolveRepositoryRoot } from './mode.mjs';
import {
  acknowledgeRendererEvents,
  pruneAcknowledgedRendererEvents,
  readRendererEvents,
  registerRendererConsumer,
  rendererConsumerStatus,
  unregisterRendererConsumer
} from './renderer-protocol.mjs';

const CONSUMER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const RENDERER_HELP = `Codex Buddy Reviewer renderer protocol

Usage:
  buddy-review.mjs renderer register --consumer <id> [options]
  buddy-review.mjs renderer next --consumer <id> [options]
  buddy-review.mjs renderer ack --consumer <id> --cursor <token> [options]
  buddy-review.mjs renderer status --consumer <id> [options]
  buddy-review.mjs renderer unregister --consumer <id> [options]
  buddy-review.mjs renderer prune [--dry-run|--apply] [options]

Options:
  --consumer <id>             Local renderer identity
  --cwd <path>                Git workspace (default: current directory)
  --data-dir <path>           Buddy runtime state root
  --limit <1..100>            Maximum events returned by next (default: 20)
  --cursor <token>            Opaque cursor returned by next
  --include-worker-summary    Include a retained legacy v1 summary in next output
  --min-age-hours <n>         Minimum acknowledged event age for prune (default: 24)
  --dry-run                   Report prune eligibility without deleting (default)
  --apply                     Delete eligible acknowledged v1 or v2 events
  --json                      Emit machine-readable JSON
  -h, --help                  Show this help

The renderer protocol is local pull/ack only. Reading does not acknowledge an
event. New v2 events never persist worker summaries. The legacy flag can expose
only a still-retained v1 summary. This command does not call a reviewer, control
the native pet, or open a network listener. Acknowledgment can shorten retention,
but cannot extend the 24-hour content limit. Lifecycle pruning hard-expires aged
v1 and v2 content even when no renderer is registered.
`;

export function parseRendererArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('-') ? args.shift() : 'status';
  if (!['register', 'next', 'ack', 'status', 'unregister', 'prune'].includes(action)) {
    throw new Error('renderer action must be register, next, ack, status, unregister, or prune');
  }
  const options = { action, json: false, includeWorkerSummary: false };
  const valueOptions = new Set(['--consumer', '--cwd', '--data-dir', '--limit', '--cursor', '--min-age-hours']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--include-worker-summary') options.includeWorkerSummary = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--apply') options.dryRun = false;
    else if (valueOptions.has(arg)) {
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--consumer') options.consumerId = value;
      if (arg === '--cwd') options.cwd = value;
      if (arg === '--data-dir') options.runtimeDataDir = value;
      if (arg === '--limit') options.limit = Number(value);
      if (arg === '--cursor') options.cursor = value;
      if (arg === '--min-age-hours') options.minAgeMs = Number(value) * 60 * 60_000;
    } else throw new Error(`unknown renderer argument: ${arg}`);
  }
  if (options.help) return options;
  if (action === 'prune' && options.dryRun === undefined) options.dryRun = true;
  if (action !== 'prune' && !options.consumerId) throw new Error(`renderer ${action} requires --consumer`);
  if (action === 'prune' && options.consumerId !== undefined) {
    throw new Error('--consumer is not used by renderer prune; every active consumer participates');
  }
  if (options.consumerId !== undefined && !CONSUMER_ID_PATTERN.test(options.consumerId)) {
    throw new Error('renderer consumer id must match [a-z0-9][a-z0-9._-]{0,63}');
  }
  if (options.limit !== undefined && (action !== 'next' || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) {
    throw new Error('--limit is allowed only for renderer next and must be between 1 and 100');
  }
  if (options.includeWorkerSummary && action !== 'next') {
    throw new Error('--include-worker-summary is allowed only for renderer next');
  }
  if (action === 'ack' && !options.cursor) throw new Error('renderer ack requires --cursor');
  if (action !== 'ack' && options.cursor !== undefined) throw new Error('--cursor is allowed only for renderer ack');
  if (options.minAgeMs !== undefined && (
    action !== 'prune' || !Number.isSafeInteger(options.minAgeMs) || options.minAgeMs < 0
  )) throw new Error('--min-age-hours is allowed only for renderer prune and must be non-negative');
  if (action !== 'prune' && options.dryRun !== undefined) {
    throw new Error('--dry-run and --apply are allowed only for renderer prune');
  }
  return options;
}

export async function runRendererCommand(argv, overrides = {}) {
  const parsed = parseRendererArgs(argv);
  const options = { ...parsed, ...overrides };
  if (options.help) return { kind: 'help', help: RENDERER_HELP, json: options.json };
  const repositoryRoot = options.repositoryRoot ?? await resolveRepositoryRoot(options.cwd);
  const shared = {
    repositoryRoot,
    runtimeDataDir: options.runtimeDataDir,
    consumerId: options.consumerId
  };
  let result;
  if (options.action === 'prune') {
    result = await pruneAcknowledgedRendererEvents({
      repositoryRoot,
      runtimeDataDir: options.runtimeDataDir,
      minAgeMs: options.minAgeMs,
      dryRun: options.dryRun
    });
  } else if (options.action === 'register') result = await registerRendererConsumer(shared);
  else if (options.action === 'next') {
    result = await readRendererEvents({
      ...shared,
      limit: options.limit,
      includeWorkerSummary: options.includeWorkerSummary
    });
  } else if (options.action === 'ack') result = await acknowledgeRendererEvents({ ...shared, cursor: options.cursor });
  else if (options.action === 'unregister') result = await unregisterRendererConsumer(shared);
  else result = await rendererConsumerStatus(shared);
  return { kind: options.action, result, json: options.json };
}

export function renderRendererCommand(output) {
  if (output.kind === 'help') return output.help;
  if (output.kind === 'next') return `${JSON.stringify(output.result, null, 2)}\n`;
  if (output.kind === 'prune') {
    if (output.result.blocked_reason === 'no_active_consumers') {
      return 'Buddy renderer retention found no active consumers; nothing eligible or deleted.\n';
    }
    return output.result.dry_run
      ? `Buddy renderer retention dry run: ${output.result.eligible_count} acknowledged event(s) eligible; nothing deleted.\n`
      : `Buddy renderer retention removed ${output.result.pruned_count} acknowledged event(s).\n`;
  }
  const state = output.result;
  const pending = state.pending
    ? `pending ${state.pending.count} event(s) through sequence ${state.pending.through_sequence}`
    : 'no pending delivery';
  return `Buddy renderer ${state.consumer_id} is ${state.active ? 'registered' : 'unregistered'} for workspace ${state.workspace_key}.\n`
    + `Acknowledged sequence: ${state.last_sequence}; ${pending}.\n`;
}
