import { runDoctor } from './doctor.mjs';
import { reviewersForMode } from './mode.mjs';
import { approveProviderReviewRequest, dispatchProviderReview } from './provider-registry.mjs';
import { parseReviewerOutput } from './result.mjs';
import { runProcess } from './process.mjs';
import {
  providerEgressPlatformPolicy,
  WINDOWS_PROVIDER_EGRESS_FAILURE_CODE
} from './provider-egress-platform.mjs';

const HEALTH_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { const: 'ok' } }
});
const HEALTH_PROMPT = 'Return only {"status":"ok"}. Do not use tools or external context.';
const SAFE_FAILURE_CODES = new Set([
  'auth_unavailable',
  'binary_missing',
  'deadline_exceeded',
  'health_check_failed',
  'invalid_review_json',
  'invalid_review_schema',
  'invalid_transport_envelope',
  'isolation_failed',
  'output_limit_exceeded',
  'transport_exit',
  WINDOWS_PROVIDER_EGRESS_FAILURE_CODE
]);

export const DOCTOR_HELP = `Codex Buddy Reviewer doctor

Usage:
  buddy-review.mjs doctor [options]

Options:
  --cwd <path>                 Git workspace (default: current directory)
  --codex-home <path>          Codex home to inspect
  --provider-check             Allow one bounded health call per configured reviewer (maximum two)
  --timeout-seconds <n>        Per-reviewer deadline; requires --provider-check (default: 60)
  --json                       Emit machine-readable diagnostics
  -h, --help                   Show this help

Doctor is read-only and does not use the network or a model by default. Host
hook trust, command discovery, pet selection, and /pet wake remain manual.
`;

export function parseDoctorArgs(argv) {
  const options = { json: false, includeProviderCheck: false, timeoutMs: 60_000 };
  let timeoutSpecified = false;
  const values = new Set(['--cwd', '--codex-home', '--timeout-seconds']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--provider-check') options.includeProviderCheck = true;
    else if (values.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--cwd') options.cwd = value;
      if (arg === '--codex-home') options.codexHome = value;
      if (arg === '--timeout-seconds') {
        options.timeoutMs = Number(value) * 1000;
        timeoutSpecified = true;
      }
    } else throw new Error(`unknown doctor argument: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 120_000) {
    throw new Error('--timeout-seconds must be between 1 and 120');
  }
  if (timeoutSpecified && !options.includeProviderCheck) {
    throw new Error('--timeout-seconds requires --provider-check');
  }
  return options;
}

function healthPayload(response) {
  const payload = response?.reviewPayload ?? parseReviewerOutput(response?.stdout);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.status !== 'ok' || Object.keys(payload).length !== 1) {
    throw new Error('invalid health response schema');
  }
  return payload;
}

function boundedFailureCode(error) {
  const candidate = error?.failureCode ?? error?.run?.failure_code;
  return typeof candidate === 'string' && SAFE_FAILURE_CODES.has(candidate)
    ? candidate
    : 'health_check_failed';
}

export async function explicitProviderCheck(
  { root, mode },
  options,
  dependencies = {}
) {
  if (!root || !mode) return { status: 'unknown', summary: 'No workspace provider configuration was available.' };
  let reviewers;
  try {
    reviewers = reviewersForMode(mode);
  } catch {
    return {
      status: 'fail',
      summary: 'Configured reviewer connections are invalid or unsupported.',
      detail: 'No provider was contacted.',
      configured_count: 0,
      passed_count: 0,
      reviewer_checks: []
    };
  }
  const platformPolicy = providerEgressPlatformPolicy(dependencies.platform ?? process.platform);
  if (!platformPolicy.allowed) {
    return {
      status: 'fail',
      summary: platformPolicy.summary,
      detail: platformPolicy.detail,
      configured_count: reviewers.length,
      passed_count: 0,
      reviewer_checks: reviewers.map((reviewer, index) => ({
        role: index === 0 ? 'primary' : 'secondary',
        provider: reviewer.provider,
        model: reviewer.model,
        status: 'fail',
        failure_code: platformPolicy.failureCode
      }))
    };
  }
  const approve = dependencies.approveProviderReviewRequest ?? approveProviderReviewRequest;
  const dispatch = dependencies.dispatchProviderReview ?? dispatchProviderReview;
  const reviewerChecks = await Promise.all(reviewers.map(async (reviewer, index) => {
    try {
      const approvedRequest = approve(reviewer.provider, {
        root,
        prompt: HEALTH_PROMPT,
        model: reviewer.model,
        effort: reviewer.effort,
        timeoutMs: options.timeoutMs,
        responseSchema: HEALTH_SCHEMA
      }, {
        purpose: 'health_check',
        summaryGuardPacket: null
      });
      const response = await dispatch(approvedRequest, {
        platform: dependencies.platform ?? process.platform
      });
      healthPayload(response);
      return {
        role: index === 0 ? 'primary' : 'secondary',
        provider: reviewer.provider,
        model: reviewer.model,
        status: 'pass',
        failure_code: null
      };
    } catch (error) {
      return {
        role: index === 0 ? 'primary' : 'secondary',
        provider: reviewer.provider,
        model: reviewer.model,
        status: 'fail',
        failure_code: boundedFailureCode(error)
      };
    }
  }));
  const passedCount = reviewerChecks.filter((check) => check.status === 'pass').length;
  const configuredCount = reviewerChecks.length;
  const status = passedCount === configuredCount ? 'pass' : passedCount === 0 ? 'fail' : 'warn';
  const failedCount = configuredCount - passedCount;
  return {
    status,
    summary: failedCount === 0
      ? `${passedCount}/${configuredCount} configured reviewer health checks passed.`
      : `${passedCount}/${configuredCount} configured reviewer health checks passed; ${failedCount} connection(s) failed closed.`,
    detail: 'Each configured reviewer received one strict one-field health prompt with no repository evidence; review quality was not tested.',
    configured_count: configuredCount,
    passed_count: passedCount,
    reviewer_checks: reviewerChecks
  };
}

export async function runDoctorCommand(argv, dependencies = {}) {
  const options = parseDoctorArgs(argv);
  if (options.help) return { help: DOCTOR_HELP };
  const result = await runDoctor({
    cwd: options.cwd,
    codexHome: options.codexHome,
    pluginRoot: dependencies.pluginRoot,
    dataDir: dependencies.dataDir,
    runtimeDataDir: dependencies.runtimeDataDir,
    platform: dependencies.platform,
    hostVersionCheck: dependencies.hostVersionCheck ?? (async () => {
      const response = await runProcess('codex', ['--version'], { timeoutMs: 10_000, maxOutputBytes: 4_096 });
      return response.stdout.trim();
    }),
    includeProviderCheck: options.includeProviderCheck,
    ...(options.includeProviderCheck
      ? {
            providerCheck: (context) => explicitProviderCheck(context, options, {
              approveProviderReviewRequest: dependencies.approveProviderReviewRequest,
              dispatchProviderReview: dependencies.dispatchProviderReview,
              platform: dependencies.platform
            })
        }
      : {})
  });
  return { result, json: options.json };
}

export function renderDoctorCommand(output) {
  if (output.help) return output.help;
  const lines = [`Buddy doctor · ${output.result.overall.toUpperCase()}`];
  for (const item of output.result.checks) {
    lines.push(`[${item.status}] ${item.id}: ${item.summary}`);
  }
  return `${lines.join('\n')}\n`;
}
