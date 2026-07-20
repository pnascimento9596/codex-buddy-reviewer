import { applySetupPlan, createSetupPlan, rollbackSetupPlan } from './setup.mjs';

export const SETUP_HELP = `Codex Buddy Reviewer setup

Usage:
  buddy-review.mjs setup plan [options]
  buddy-review.mjs setup apply --plan-id <id> --plan-digest <sha256> [options]
  buddy-review.mjs setup rollback --plan-id <id> --plan-digest <sha256> [options]

Options:
  --cwd <path>                 Git workspace (default: current directory)
  --codex-home <path>          Codex home containing the pets directory
  --pet-id <buddy-id>          Plan only: pet package (default: buddy-byte)
  --provider <adapter>         Plan only: primary connection (grok, ollama, claude, or opencode)
  --model <id>                 Plan only: primary reviewer model
  --effort <level>             Plan only: primary reviewer reasoning effort
  --also-provider <adapter>    Plan only: add a second independent reviewer connection
  --also-model <id>            Plan only: secondary model (default: adapter-specific)
  --also-effort <level>        Plan only: secondary reasoning effort (default: high)
  --single-reviewer            Plan only: clear the secondary reviewer connection
  --confidence <0..1>          Plan only: publication threshold
  --max-patch-bytes <n>        Plan only: sanitized patch cap
  --timeout-seconds <n>        Plan only: reviewer deadline, at most 480 seconds
  --plan-ttl-seconds <n>       Plan only: lifetime, at most 86400 seconds
  --plan-id <id>               Apply/rollback: immutable plan identifier
  --plan-digest <sha256>       Apply/rollback: exact immutable plan digest
  --json                       Emit machine-readable output
  -h, --help                   Show this help

Plan is read-only except for its private immutable plan record. Apply installs
or updates the pet first and enables review last. Host trust, pet selection,
and /pet wake are always manual. Rollback refuses intervening changes.
`;

export function parseSetupArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('-') ? args.shift() : 'plan';
  const options = { action, json: false };
  const values = new Set([
    '--cwd', '--codex-home', '--pet-id', '--provider', '--model', '--effort', '--confidence',
    '--also-provider', '--also-model', '--also-effort', '--max-patch-bytes', '--timeout-seconds',
    '--plan-ttl-seconds', '--plan-id', '--plan-digest'
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--single-reviewer') options.singleReviewer = true;
    else if (values.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--cwd') options.cwd = value;
      if (arg === '--codex-home') options.codexHome = value;
      if (arg === '--pet-id') options.petId = value;
      if (arg === '--provider') options.provider = value;
      if (arg === '--model') options.model = value;
      if (arg === '--effort') options.effort = value;
      if (arg === '--also-provider') options.secondaryProvider = value;
      if (arg === '--also-model') options.secondaryModel = value;
      if (arg === '--also-effort') options.secondaryEffort = value;
      if (arg === '--confidence') options.minConfidence = Number(value);
      if (arg === '--max-patch-bytes') options.maxPatchBytes = Number(value);
      if (arg === '--timeout-seconds') options.timeoutMs = Number(value) * 1000;
      if (arg === '--plan-ttl-seconds') options.ttlMs = Number(value) * 1000;
      if (arg === '--plan-id') options.planId = value;
      if (arg === '--plan-digest') options.planDigest = value;
    } else throw new Error(`unknown setup argument: ${arg}`);
  }
  if (!['plan', 'apply', 'rollback'].includes(action)) {
    throw new Error('setup action must be plan, apply, or rollback');
  }
  const planOnly = [
    ['--pet-id', options.petId],
    ['--provider', options.provider],
    ['--model', options.model],
    ['--effort', options.effort],
    ['--also-provider', options.secondaryProvider],
    ['--also-model', options.secondaryModel],
    ['--also-effort', options.secondaryEffort],
    ['--single-reviewer', options.singleReviewer],
    ['--confidence', options.minConfidence],
    ['--max-patch-bytes', options.maxPatchBytes],
    ['--timeout-seconds', options.timeoutMs],
    ['--plan-ttl-seconds', options.ttlMs]
  ];
  const immutablePlanIdentity = [
    ['--plan-id', options.planId],
    ['--plan-digest', options.planDigest]
  ];
  if (action !== 'plan') {
    const unsupported = planOnly.find(([, value]) => value !== undefined);
    if (unsupported) throw new Error(`${unsupported[0]} is only valid for setup plan`);
  } else {
    const unsupported = immutablePlanIdentity.find(([, value]) => value !== undefined);
    if (unsupported) throw new Error(`${unsupported[0]} is only valid for setup apply or rollback`);
  }
  if (options.provider !== undefined
      && !['grok', 'ollama', 'claude', 'opencode'].includes(options.provider)) {
    throw new Error('--provider must be grok, ollama, claude, or opencode');
  }
  if (options.secondaryProvider !== undefined
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
  if (['apply', 'rollback'].includes(action) && (!options.planId || !options.planDigest)) {
    throw new Error(`setup ${action} requires --plan-id and --plan-digest`);
  }
  if (options.minConfidence !== undefined
      && (!Number.isFinite(options.minConfidence) || options.minConfidence < 0 || options.minConfidence > 1)) {
    throw new Error('--confidence must be between 0 and 1');
  }
  if (options.maxPatchBytes !== undefined
      && (!Number.isInteger(options.maxPatchBytes) || options.maxPatchBytes < 4096)) {
    throw new Error('--max-patch-bytes must be an integer >= 4096');
  }
  if (options.timeoutMs !== undefined
      && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 480_000)) {
    throw new Error('--timeout-seconds must be between 1 and 480');
  }
  if (options.ttlMs !== undefined
      && (!Number.isInteger(options.ttlMs) || options.ttlMs < 1_000 || options.ttlMs > 86_400_000)) {
    throw new Error('--plan-ttl-seconds must be between 1 and 86400');
  }
  return options;
}

export async function runSetupCommand(argv, dependencies = {}) {
  const options = parseSetupArgs(argv);
  if (options.help) return { help: SETUP_HELP };
  const shared = {
    cwd: options.cwd,
    codexHome: options.codexHome,
    dataDir: dependencies.dataDir,
    pluginRoot: dependencies.pluginRoot
  };
  const result = options.action === 'plan'
    ? await createSetupPlan({
        ...shared,
        petId: options.petId,
        provider: options.provider,
        model: options.model,
        effort: options.effort,
        secondaryProvider: options.secondaryProvider,
        secondaryModel: options.secondaryModel,
        secondaryEffort: options.secondaryEffort,
        singleReviewer: options.singleReviewer,
        minConfidence: options.minConfidence,
        maxPatchBytes: options.maxPatchBytes,
        timeoutMs: options.timeoutMs,
        ttlMs: options.ttlMs
      })
    : options.action === 'apply'
      ? await applySetupPlan({
          ...shared,
          planId: options.planId,
          planDigest: options.planDigest
        })
      : await rollbackSetupPlan({
          ...shared,
          planId: options.planId,
          planDigest: options.planDigest
        });
  return { action: options.action, result, json: options.json };
}

export function renderSetupCommand(output) {
  if (output.help) return output.help;
  if (output.action === 'plan') {
    const primary = `${output.result.desired_mode.provider}/${output.result.desired_mode.model}`;
    const secondary = output.result.desired_mode.secondary_provider === null
      ? 'none (single reviewer)'
      : `${output.result.desired_mode.secondary_provider}/${output.result.desired_mode.secondary_model}`;
    return `Buddy setup plan created\nPlan ID: ${output.result.plan_id}\nPlan digest: ${output.result.plan_digest}\n`
      + `Expires: ${output.result.expires_at}\nPet: ${output.result.pet_id}\n`
      + `Primary review connection: ${primary}\nSecondary review connection: ${secondary}\n`
      + 'Review the plan, then pass its exact ID and digest to setup apply.\n';
  }
  const steps = output.result.manual_host_steps ?? [];
  return `Buddy setup ${output.result.outcome}${output.result.idempotent ? ' (already complete)' : ''}\n`
    + (steps.length ? `Manual host steps:\n${steps.map((step) => `- ${step}`).join('\n')}\n` : '');
}
