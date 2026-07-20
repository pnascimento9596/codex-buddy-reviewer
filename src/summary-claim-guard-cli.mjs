import { readMode, resolveRepositoryRoot } from './mode.mjs';
import { supportedProviderIds } from './provider-registry.mjs';
import { changeSummaryClaimGuardConsent } from './summary-claim-guard.mjs';

const SUMMARY_PROVIDERS = supportedProviderIds();

export const SUMMARY_GUARD_HELP = `Codex Buddy Reviewer summary guard

Usage:
  buddy-review.mjs summary-guard [status|enable|disable] [options]

Options:
  --cwd <path>                 Git workspace (default: current directory)
  --provider <adapter>         Bind consent to claude, grok, ollama, or opencode (default: mode)
  --model <id>                 Bind consent to this model (default: mode)
  --confirm-summary-egress     Required to enable worker-summary egress
  --json                       Emit machine-readable consent state
  -h, --help                   Show this help

The guard is a separately consented advisory channel. It shares the existing
review call, cannot create code findings, and is disabled by default.
`;

export function parseSummaryGuardArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('-') ? args.shift() : 'status';
  const options = { action, json: false, confirmSummaryEgress: false };
  const values = new Set(['--cwd', '--provider', '--model']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--confirm-summary-egress') options.confirmSummaryEgress = true;
    else if (values.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--cwd') options.cwd = value;
      if (arg === '--provider') options.provider = value;
      if (arg === '--model') options.model = value;
    } else throw new Error(`unknown summary-guard argument: ${arg}`);
  }
  if (!['status', 'enable', 'disable'].includes(action)) {
    throw new Error('summary-guard action must be status, enable, or disable');
  }
  if (options.provider !== undefined && !SUMMARY_PROVIDERS.includes(options.provider)) {
    throw new Error(`--provider must be one of ${SUMMARY_PROVIDERS.join(', ')}`);
  }
  if (action !== 'enable'
      && (options.provider !== undefined || options.model !== undefined || options.confirmSummaryEgress)) {
    throw new Error('summary egress binding options are only valid for summary-guard enable');
  }
  if (action === 'enable' && !options.confirmSummaryEgress) {
    throw new Error('summary-guard enable requires --confirm-summary-egress');
  }
  return options;
}

export async function runSummaryGuardCommand(argv, dependencies = {}) {
  const options = parseSummaryGuardArgs(argv);
  if (options.help) return { help: SUMMARY_GUARD_HELP };
  const root = await (dependencies.resolveRoot ?? resolveRepositoryRoot)(options.cwd);
  const mode = options.action === 'enable'
    ? await (dependencies.readMode ?? readMode)({ root, dataDir: dependencies.dataDir })
    : null;
  const result = await changeSummaryClaimGuardConsent({
    root,
    dataDir: dependencies.dataDir,
    action: options.action,
    provider: options.provider ?? mode?.provider,
    model: options.model ?? mode?.model,
    confirmSummaryEgress: options.confirmSummaryEgress
  });
  return { result, json: options.json };
}

export function renderSummaryGuardCommand(output) {
  if (output.help) return output.help;
  const consent = output.result;
  const binding = consent.enabled ? `${consent.provider}/${consent.model}` : 'none';
  return `Buddy summary guard is ${consent.enabled ? 'ON' : 'OFF'}\n`
    + `Purpose: ${consent.scope} · binding: ${binding} · revision: ${consent.configuration_revision}\n`;
}
