import { createHash } from 'node:crypto';
import path from 'node:path';

import { collectEvidence } from './evidence.mjs';
import { privacyCoverageIsCurrentComplete } from './privacy-inventory.mjs';
import { providerDefaultModel, validateReviewerConfiguration } from './mode.mjs';
import { buildReviewPrompt } from './prompt.mjs';
import {
  approveProviderReviewRequest,
  dispatchProviderReview,
  getProviderDefinition,
  inspectApprovedProviderReviewRequest,
  supportedProviderIds,
  validateProviderEffort
} from './provider-registry.mjs';
import { parseReviewerOutput, validateReviewResult } from './result.mjs';
import { renderHuman } from './render.mjs';
import { storeReceipt } from './store.mjs';
import { escapeDiagnosticLine } from './policy.mjs';
import { runModeCommand } from './mode-cli.mjs';
import { renderPetCommand, runPetCommand } from './pet-cli.mjs';
import { renderRendererCommand, runRendererCommand } from './renderer-cli.mjs';
import {
  REVIEW_RESULT_SCHEMA,
  REVIEW_SCHEMA_VERSION,
  REVIEW_WITH_SUMMARY_ADVISORY_SCHEMA,
  validateReviewWithSummaryAdvisoryEnvelope
} from './review-schema.mjs';
import { validateSummaryClaimGuardResult } from './summary-claim-guard.mjs';
import { canonicalJson } from './state.mjs';
import { renderPresentationCommand, runPresentationCommand } from './presentation-cli.mjs';
import { renderSummaryGuardCommand, runSummaryGuardCommand } from './summary-claim-guard-cli.mjs';
import { renderDoctorCommand, runDoctorCommand } from './doctor-cli.mjs';
import { renderSetupCommand, runSetupCommand } from './setup-cli.mjs';
import { renderDataCommand, runDataCommand } from './data-cli.mjs';
import { assertProviderEgressPlatformAllowed } from './provider-egress-platform.mjs';

const HELP = `Codex Buddy Reviewer

Usage:
  buddy-review.mjs review [options]
  buddy-review.mjs pet [list|status|install|update|remove|restore|reconcile] [options]
  buddy-review.mjs presentation [status|set] [options]
  buddy-review.mjs summary-guard [status|enable|disable] [options]
  buddy-review.mjs renderer [register|next|ack|status|unregister|prune] [options]
  buddy-review.mjs doctor [options]
  buddy-review.mjs setup [plan|apply|rollback] [options]
  buddy-review.mjs data [status|purge] [options]

Options:
  --provider <id>              Connection: claude, grok, ollama, or opencode (default: grok)
  --model <id>                 Provider model (uses the selected connection default)
  --effort <level>             Reviewer reasoning effort (default: high)
  --scope <working-tree|branch> Review scope (default: working-tree)
  --base <ref>                 Required for branch scope
  --cwd <path>                 Repository path (default: current directory)
  --confidence <0..1>          Publication threshold (default: 0.75)
  --max-patch-bytes <n>        Sanitized patch cap (default: 262144)
  --timeout-seconds <n>        Reviewer deadline (default: 480)
  --json                       Emit machine-readable JSON
  --dry-run                    Build and print evidence metadata without calling a model
  --store                      Write a bounded local review receipt
  --no-store                   Compatibility alias for the privacy-safe default
  --retain-evidence            Retain sanitized patch text in the local receipt
  -h, --help                   Show this help

No automatic hooks are installed by this command.
`;

export function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === 'review') args.shift();
  const options = {
    provider: 'grok',
    scope: 'working-tree',
    effort: 'high',
    minConfidence: 0.75,
    maxPatchBytes: 256 * 1024,
    timeoutMs: 480_000,
    store: false,
    retainEvidence: false,
    json: false,
    dryRun: false
  };

  const values = new Set([
    '--provider', '--model', '--effort', '--scope', '--base', '--cwd', '--confidence',
    '--max-patch-bytes', '--timeout-seconds'
  ]);
  let storeRequested = false;
  let noStoreRequested = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--store') {
      storeRequested = true;
      options.store = true;
    } else if (arg === '--no-store') {
      noStoreRequested = true;
      options.store = false;
    }
    else if (arg === '--retain-evidence') options.retainEvidence = true;
    else if (values.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--provider') options.provider = value;
      if (arg === '--model') options.model = value;
      if (arg === '--effort') options.effort = value;
      if (arg === '--scope') options.scope = value;
      if (arg === '--base') options.base = value;
      if (arg === '--cwd') options.cwd = value;
      if (arg === '--confidence') options.minConfidence = Number(value);
      if (arg === '--max-patch-bytes') options.maxPatchBytes = Number(value);
      if (arg === '--timeout-seconds') options.timeoutMs = Number(value) * 1000;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (storeRequested && noStoreRequested) throw new Error('--store and --no-store cannot be combined');
  if (options.retainEvidence && !options.store) {
    throw new Error('--retain-evidence requires explicit --store');
  }

  if (!supportedProviderIds().includes(options.provider)) {
    throw new Error('--provider must be claude, grok, ollama, or opencode');
  }
  if (!['working-tree', 'branch'].includes(options.scope)) throw new Error('--scope must be working-tree or branch');
  if (options.scope === 'branch' && !options.base) throw new Error('--base is required for branch scope');
  if (!Number.isFinite(options.minConfidence) || options.minConfidence < 0 || options.minConfidence > 1) {
    throw new Error('--confidence must be between 0 and 1');
  }
  if (!Number.isInteger(options.maxPatchBytes) || options.maxPatchBytes < 4096) {
    throw new Error('--max-patch-bytes must be an integer >= 4096');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error('--timeout-seconds must be at least 1');
  }
  validateReviewerConfiguration({
    provider: options.provider,
    model: options.model ?? providerDefaultModel(options.provider),
    effort: options.effort,
    min_confidence: options.minConfidence,
    max_patch_bytes: options.maxPatchBytes,
    timeout_ms: options.timeoutMs
  });
  return options;
}

function publicEvidence(evidence) {
  const { patch, ...metadata } = evidence;
  return metadata;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireProviderEligiblePrivacyCoverage(evidence) {
  const expectedScope = {
    'working-tree': 'manual_working',
    branch: 'manual_branch',
    turn: 'turn_evidence'
  }[evidence.scope];
  if (!expectedScope || !privacyCoverageIsCurrentComplete(evidence.privacy_coverage, expectedScope)) {
    const error = new Error('Buddy privacy coverage is incomplete or incompatible; no provider request was approved');
    error.failureCode = 'privacy_coverage_incomplete';
    throw error;
  }
}

export async function runReview(options) {
  if (!options.dryRun) {
    assertProviderEgressPlatformAllowed(options.platform ?? process.platform);
  }
  const evidence = await collectEvidence(options);
  if (options.dryRun) return { evidence, result: null, provider: null, model: null, receiptDir: null };

  return reviewEvidence(evidence, options);
}

function deepFreezeJson(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

function frozenJsonClone(value) {
  if (value === undefined) return undefined;
  return deepFreezeJson(JSON.parse(JSON.stringify(value)));
}

export function prepareReviewRequest(evidence, options = {}) {
  const summaryGuardPacket = options.summaryGuardPacket === null
    || options.summaryGuardPacket === undefined
    ? null
    : frozenJsonClone(options.summaryGuardPacket);
  const responseSchema = frozenJsonClone(
    summaryGuardPacket ? REVIEW_WITH_SUMMARY_ADVISORY_SCHEMA : REVIEW_RESULT_SCHEMA
  );
  return Object.freeze({
    prompt: buildReviewPrompt(evidence, { summaryGuardPacket }),
    responseSchema,
    summaryGuardPacket
  });
}

export async function reviewEvidence(evidence, options) {

  const transmittedPaths = new Set(
    (evidence.path_evidence ?? [])
      .filter((item) => item.transmitted && item.disposition === 'complete')
      .map((item) => item.path)
  );
  if (evidence.changed_paths.length === 0 || evidence.changed_paths.every((repoPath) => !transmittedPaths.has(repoPath))) {
    const excludedCount = evidence.excluded_paths.length
      + (evidence.sensitive_change_count ?? 0)
      + (evidence.ignored_change_count ?? 0);
    const incompleteCount = evidence.incomplete_paths?.length ?? 0;
    const result = excludedCount || incompleteCount
      ? {
          schema_version: REVIEW_SCHEMA_VERSION, status: 'abstain',
          summary: incompleteCount
            ? 'No complete transmitted evidence was available for the observed changes.'
            : 'All observed changes were excluded by privacy policy.',
          findings: [], comments: []
        }
      : {
          schema_version: REVIEW_SCHEMA_VERSION,
          status: 'no_findings',
          summary: 'No reviewable changes were observed in the selected scope.',
          findings: [],
          comments: []
        };
    const receiptDir = options.store
      ? await storeReceipt({ evidence, result, provider: 'none', model: 'none', retainEvidence: options.retainEvidence })
      : null;
    return { evidence, result, provider: 'none', model: 'none', receiptDir };
  }

  if (options.onProviderDispatch !== undefined && typeof options.onProviderDispatch !== 'function') {
    throw new TypeError('Buddy provider-dispatch observer must be a function');
  }
  assertProviderEgressPlatformAllowed(options.platform ?? process.platform);
  requireProviderEligiblePrivacyCoverage(evidence);
  const definition = getProviderDefinition(options.provider);
  const model = options.model ?? definition.defaultModel;
  const effort = options.effort ?? definition.defaultEffort;
  validateProviderEffort(options.provider, effort);
  let summaryGuardPacket = options.summaryGuardPacket ?? null;
  let approvedRequest = options.approvedRequest;
  if (approvedRequest === undefined) {
    const preparedRequest = options.preparedRequest ?? prepareReviewRequest(evidence, options);
    if (!preparedRequest || typeof preparedRequest !== 'object'
        || typeof preparedRequest.prompt !== 'string'
        || !Object.hasOwn(preparedRequest, 'responseSchema')
        || !Object.hasOwn(preparedRequest, 'summaryGuardPacket')) {
      throw new Error('Buddy prepared review request is invalid');
    }
    if (options.preparedRequest
        && Object.hasOwn(options, 'summaryGuardPacket')
        && summaryGuardPacket !== preparedRequest.summaryGuardPacket) {
      throw new Error('Buddy prepared review request summary packet does not match its execution options');
    }
    summaryGuardPacket = preparedRequest.summaryGuardPacket;
    approvedRequest = approveProviderReviewRequest(options.provider, {
      root: evidence.repository_root,
      prompt: preparedRequest.prompt,
      model,
      effort,
      timeoutMs: options.timeoutMs,
      responseSchema: preparedRequest.responseSchema
    }, {
      purpose: 'technical_review',
      summaryGuardPacket: preparedRequest.summaryGuardPacket
    });
  }
  const approval = inspectApprovedProviderReviewRequest(approvedRequest);
  if (approval.purpose !== 'technical_review'
      || approval.rootSha256 !== sha256(path.resolve(evidence.repository_root))
      || approval.provider !== options.provider
      || approval.model !== model
      || approval.effort !== effort
      || approval.timeoutMs !== options.timeoutMs
      || approval.summaryConsentRevision !== (summaryGuardPacket?.consent_revision ?? null)
      || approval.summarySha256 !== (summaryGuardPacket?.summary_sha256 ?? null)
      || approval.summaryPacketSha256 !== (summaryGuardPacket === null
        ? null
        : sha256(canonicalJson(summaryGuardPacket)))) {
    throw new Error('Buddy approved provider request does not match its execution options');
  }
  options.onProviderDispatch?.();
  const response = await dispatchProviderReview(approvedRequest, {
    platform: options.platform ?? process.platform,
    signal: options.signal
  });

  let raw;
  let result;
  try {
    raw = response.reviewPayload ?? parseReviewerOutput(response.stdout);
  } catch (error) {
    error.failureCode = 'invalid_review_json';
    error.run = response.run;
    throw error;
  }
  try {
    if (summaryGuardPacket) validateReviewWithSummaryAdvisoryEnvelope(raw);
    result = validateReviewResult(
      summaryGuardPacket ? raw?.technical_review : raw,
      evidence,
      { minConfidence: options.minConfidence }
    );
  } catch (error) {
    error.failureCode = /cites|contained|line_|changed range|file side|review scope/.test(error.message)
      ? 'grounding_rejected'
      : 'invalid_review_schema';
    error.run = response.run;
    throw error;
  }
  let summaryAdvisory = null;
  if (summaryGuardPacket) {
    try {
      summaryAdvisory = validateSummaryClaimGuardResult(
        raw?.summary_advisory,
        summaryGuardPacket,
        { minConfidence: options.minConfidence }
      );
    } catch {
      summaryAdvisory = Object.freeze({
        schema_version: '1',
        status: 'abstain',
        advisory: 'The provider returned an invalid summary advisory; the technical review remains unchanged.',
        notes: Object.freeze([])
      });
    }
  }
  const receiptDir = options.store
    ? await storeReceipt({
        evidence,
        result,
        provider: response.provider,
        model: response.model,
        stderr: response.stderr,
        run: response.run,
        retainEvidence: options.retainEvidence
      })
    : null;
  return {
    evidence,
    result,
    provider: response.provider,
    model: response.model,
    run: response.run,
    receiptDir,
    summaryAdvisory
  };
}

export async function main(argv) {
  try {
    if (argv[0] === 'pet' || argv[0] === 'pets') {
      const petArgs = argv[0] === 'pets' && argv.length === 1 ? ['list'] : argv.slice(1);
      const output = await runPetCommand(petArgs);
      if (output.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      else process.stdout.write(renderPetCommand(output));
      return 0;
    }
    if (argv[0] === 'mode') {
      const output = await runModeCommand(argv.slice(1));
      if (output.help) process.stdout.write(output.help);
      else if (output.json) process.stdout.write(`${JSON.stringify(output.mode, null, 2)}\n`);
      else {
        process.stdout.write(
          `Buddy automatic review is ${output.mode.enabled ? 'ON' : 'OFF'} for ${output.mode.workspace_root}\n`
          + `Reviewer: ${output.mode.provider}/${output.mode.model} · advisory · workspace-scoped\n`
          + 'Use /pet in Codex to wake or tuck away the host pet.\n'
        );
      }
      return 0;
    }
    if (argv[0] === 'renderer') {
      const output = await runRendererCommand(argv.slice(1));
      if (output.json) process.stdout.write(`${JSON.stringify(output.result, null, 2)}\n`);
      else process.stdout.write(renderRendererCommand(output));
      return 0;
    }
    if (argv[0] === 'presentation') {
      const output = await runPresentationCommand(argv.slice(1));
      if (output.help) process.stdout.write(output.help);
      else if (output.json) process.stdout.write(`${JSON.stringify(output.result, null, 2)}\n`);
      else process.stdout.write(renderPresentationCommand(output));
      return 0;
    }
    if (argv[0] === 'summary-guard') {
      const output = await runSummaryGuardCommand(argv.slice(1));
      if (output.help) process.stdout.write(output.help);
      else if (output.json) process.stdout.write(`${JSON.stringify(output.result, null, 2)}\n`);
      else process.stdout.write(renderSummaryGuardCommand(output));
      return 0;
    }
    if (argv[0] === 'data') {
      const output = await runDataCommand(argv.slice(1));
      if (output.help) process.stdout.write(output.help);
      else if (output.json) process.stdout.write(`${JSON.stringify(output.result, null, 2)}\n`);
      else process.stdout.write(renderDataCommand(output));
      return 0;
    }
    if (argv[0] === 'doctor') {
      const output = await runDoctorCommand(argv.slice(1));
      if (output.help) process.stdout.write(output.help);
      else if (output.json) process.stdout.write(`${JSON.stringify(output.result, null, 2)}\n`);
      else process.stdout.write(renderDoctorCommand(output));
      return 0;
    }
    if (argv[0] === 'setup') {
      const output = await runSetupCommand(argv.slice(1));
      if (output.help) process.stdout.write(output.help);
      else if (output.json) process.stdout.write(`${JSON.stringify(output.result, null, 2)}\n`);
      else process.stdout.write(renderSetupCommand(output));
      return 0;
    }
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const output = await runReview(options);
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify(publicEvidence(output.evidence), null, 2)}\n`);
      return 0;
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        review_id: output.evidence.review_id,
        patch_hash: output.evidence.patch_hash,
        provider: output.provider,
        model: output.model,
        receipt_dir: output.receiptDir,
        result: output.result,
        ...(output.run?.cleanup_status === 'failed'
          ? { operational_warnings: ['temporary_state_cleanup_failed'] }
          : {})
      }, null, 2)}\n`);
    } else {
      process.stdout.write(renderHuman(output));
    }
    return 0;
  } catch (error) {
    process.stderr.write(`Buddy review failed: ${escapeDiagnosticLine(error.message)}\n`);
    return 2;
  }
}
