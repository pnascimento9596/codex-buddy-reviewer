#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewPrompt } from '../src/prompt.mjs';
import {
  approveProviderReviewRequest,
  dispatchProviderReview,
  supportedProviderIds,
  validateProviderEffort
} from '../src/provider-registry.mjs';
import { parseReviewerOutput, validateReviewResult } from '../src/result.mjs';
import { REVIEW_RESULT_SCHEMA } from '../src/review-schema.mjs';
import { escapeDiagnosticLine } from '../src/policy.mjs';
import { assertProviderEgressPlatformAllowed } from '../src/provider-egress-platform.mjs';
import { DEFAULT_CORPUS_MANIFEST, loadEvalCorpus } from './lib/eval-corpus.mjs';

const HELP = `Codex Buddy explicit live-provider evaluator

Usage:
  buddy-live-eval.mjs live --provider <claude|grok|ollama|opencode> --model <id>
    --effort <level> --cases <id,id,...> --runs <n>
    --timeout-seconds <1..480> --max-calls <n>
    --max-prompt-bytes <4096..1048576> --max-total-seconds <n>
    --confidence <0..1> --output <new-file> [--corpus <manifest>]

Every budget and provider choice is required. The runner makes exactly one
attempt for each planned provider-eligible case/run, with no fallback and no
retry. Cases whose corpus policy forbids egress are evaluated locally.
`;

function requiredNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number`);
  return number;
}

export function parseLiveEvalArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('-') ? args.shift() : null;
  const options = { action, corpus: DEFAULT_CORPUS_MANIFEST, live: false };
  const valueOptions = new Set([
    '--provider', '--model', '--effort', '--cases', '--runs', '--timeout-seconds', '--max-calls',
    '--max-prompt-bytes', '--max-total-seconds', '--confidence', '--output', '--corpus'
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--live') options.live = true;
    else if (valueOptions.has(arg)) {
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--provider') options.provider = value;
      if (arg === '--model') options.model = value;
      if (arg === '--effort') options.effort = value;
      if (arg === '--cases') options.cases = value.split(',');
      if (arg === '--runs') options.runs = requiredNumber(value, '--runs');
      if (arg === '--timeout-seconds') options.timeoutSeconds = requiredNumber(value, '--timeout-seconds');
      if (arg === '--max-calls') options.maxCalls = requiredNumber(value, '--max-calls');
      if (arg === '--max-prompt-bytes') options.maxPromptBytes = requiredNumber(value, '--max-prompt-bytes');
      if (arg === '--max-total-seconds') options.maxTotalSeconds = requiredNumber(value, '--max-total-seconds');
      if (arg === '--confidence') options.minConfidence = requiredNumber(value, '--confidence');
      if (arg === '--output') options.output = path.resolve(value);
      if (arg === '--corpus') options.corpus = path.resolve(value);
    } else throw new Error(`unknown live-eval argument: ${arg}`);
  }
  if (options.help) return options;
  if (action !== 'live' || !options.live) throw new Error('live evaluation requires both the live action and --live acknowledgement');
  for (const field of ['provider', 'model', 'effort', 'cases', 'runs', 'timeoutSeconds', 'maxCalls', 'maxPromptBytes', 'maxTotalSeconds', 'minConfidence', 'output']) {
    if (options[field] === undefined) throw new Error(`live evaluation requires an explicit ${field} value`);
  }
  if (!supportedProviderIds().includes(options.provider)) {
    throw new Error(`--provider must be one of ${supportedProviderIds().join(', ')}`);
  }
  if (!options.model.trim() || !options.effort.trim()) throw new Error('--model and --effort must be non-empty');
  validateProviderEffort(options.provider, options.effort);
  if (!Array.isArray(options.cases) || !options.cases.length || new Set(options.cases).size !== options.cases.length
      || options.cases.some((id) => !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id))) {
    throw new Error('--cases must be a comma-separated list of unique corpus case ids');
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) throw new Error('--runs must be an integer from 1 to 10');
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > 480) {
    throw new Error('--timeout-seconds must be an integer from 1 to 480');
  }
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 0 || options.maxCalls > 100) {
    throw new Error('--max-calls must be an integer from 0 to 100');
  }
  if (!Number.isInteger(options.maxPromptBytes) || options.maxPromptBytes < 4096 || options.maxPromptBytes > 1024 * 1024) {
    throw new Error('--max-prompt-bytes must be an integer from 4096 to 1048576');
  }
  if (!Number.isInteger(options.maxTotalSeconds) || options.maxTotalSeconds < 1 || options.maxTotalSeconds > 86_400) {
    throw new Error('--max-total-seconds must be an integer from 1 to 86400');
  }
  if (options.minConfidence < 0 || options.minConfidence > 1) throw new Error('--confidence must be between 0 and 1');
  return options;
}

function localNoEgressResult(evalCase, schemaVersion) {
  return {
    schema_version: schemaVersion,
    status: 'abstain',
    summary: evalCase.category === 'privacy'
      ? 'Sensitive-only fixture evidence is represented by a private aggregate; no provider call is allowed.'
      : 'Fixture evidence is incomplete and no complete transmitted path is available.',
    findings: [],
    comments: []
  };
}

function hashText(value) {
  return value?.trim() ? createHash('sha256').update(value.trim()).digest('hex') : null;
}

export async function runLiveEval(argv, overrides = {}) {
  const options = { ...parseLiveEvalArgs(argv), ...overrides };
  if (options.help) return { help: HELP };
  const monotonicNow = overrides.monotonicNow ?? (() => performance.now());
  const aggregateDeadline = monotonicNow() + options.maxTotalSeconds * 1000;
  const corpus = await loadEvalCorpus(options.corpus);
  const caseMap = new Map(corpus.cases.map((item) => [item.id, item]));
  const selected = options.cases.map((id) => {
    const evalCase = caseMap.get(id);
    if (!evalCase) throw new Error(`unknown corpus case ${id}`);
    if (!evalCase.live_eligible) throw new Error(`corpus case ${id} is not live-eligible`);
    return evalCase;
  });
  const plannedCalls = selected.filter((item) => item.egress_expected).length * options.runs;
  if (options.maxCalls !== plannedCalls) {
    throw new Error(`--max-calls must exactly equal the ${plannedCalls} planned provider call(s)`);
  }
  if (plannedCalls > 0) {
    assertProviderEgressPlatformAllowed(overrides.platform ?? process.platform);
  }
  const buildPrompt = overrides.buildReviewPrompt ?? buildReviewPrompt;
  const prompts = new Map();
  for (const evalCase of selected) {
    if (!evalCase.egress_expected) continue;
    const prompt = buildPrompt(evalCase.evidence);
    if (Buffer.byteLength(prompt) > options.maxPromptBytes) {
      throw new Error(`case ${evalCase.id} prompt exceeds the explicit ${options.maxPromptBytes}-byte budget`);
    }
    prompts.set(evalCase.id, prompt);
  }
  const outputHandle = await open(options.output, 'wx', 0o600);
  let completed = false;
  try {
    const startedAt = new Date().toISOString();
    const runs = [];
    for (const evalCase of selected) {
      for (let run = 1; run <= options.runs; run += 1) {
        if (!evalCase.egress_expected) {
          runs.push({
            case_id: evalCase.id,
            run,
            provider_called: false,
            outcome: 'local_no_egress',
            result: localNoEgressResult(evalCase, corpus.manifest.review_schema_version),
            provider: null,
            model: null,
            stderr_hash: null,
            error_hash: null
          });
          continue;
        }

        const prompt = prompts.get(evalCase.id);
        if (typeof prompt !== 'string') throw new Error(`case ${evalCase.id} is missing its preflighted prompt`);
        const remainingAggregateMs = aggregateDeadline - monotonicNow();
        if (remainingAggregateMs < 1_000) {
          runs.push({
            case_id: evalCase.id,
            run,
            provider_called: false,
            outcome: 'failed',
            result: null,
            provider: options.provider,
            model: options.model,
            stderr_hash: null,
            error_hash: createHash('sha256').update('aggregate live-eval deadline cannot provide the minimum provider timeout').digest('hex')
          });
          continue;
        }
        const callTimeoutMs = Math.min(
          options.timeoutSeconds * 1000,
          Math.floor(remainingAggregateMs)
        );
        let providerCalled = false;
        try {
          const reviewOptions = {
            root: overrides.root ?? process.cwd(),
            prompt,
            model: options.model,
            effort: options.effort,
            timeoutMs: callTimeoutMs,
            responseSchema: REVIEW_RESULT_SCHEMA
          };
          const legacyOverride = options.provider === 'ollama'
            ? overrides.reviewWithOllama
            : options.provider === 'grok' ? overrides.reviewWithGrok : null;
          let response;
          if (legacyOverride) {
            providerCalled = true;
            response = await legacyOverride(reviewOptions);
          } else if (overrides.reviewProvider) {
            providerCalled = true;
            response = await overrides.reviewProvider(options.provider, reviewOptions);
          } else {
            const approvedRequest = (overrides.approveProviderReviewRequest ?? approveProviderReviewRequest)(
              options.provider,
              reviewOptions,
              { purpose: 'technical_review', summaryGuardPacket: null }
            );
            providerCalled = true;
            response = await (overrides.dispatchProviderReview ?? dispatchProviderReview)(
              approvedRequest,
              { platform: overrides.platform ?? process.platform }
            );
          }
          if (response.provider !== options.provider || response.model !== options.model) {
            throw new Error('provider response identity differs from the pinned live-eval configuration');
          }
          const result = validateReviewResult(parseReviewerOutput(response.stdout), evalCase.evidence, {
            minConfidence: options.minConfidence
          });
          runs.push({
            case_id: evalCase.id,
            run,
            provider_called: providerCalled,
            outcome: 'completed',
            result,
            provider: response.provider,
            model: response.model,
            stderr_hash: hashText(response.stderr),
            error_hash: null
          });
        } catch (error) {
          runs.push({
            case_id: evalCase.id,
            run,
            provider_called: providerCalled,
            outcome: 'failed',
            result: null,
            provider: options.provider,
            model: options.model,
            stderr_hash: null,
            error_hash: createHash('sha256').update(String(error?.message ?? error)).digest('hex')
          });
        }
      }
    }

    const artifact = {
      schema_version: '1',
      corpus_id: corpus.manifest.corpus_id,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      config: {
        provider: options.provider,
        model: options.model,
        effort: options.effort,
        cases: options.cases,
        runs: options.runs,
        timeout_seconds: options.timeoutSeconds,
        max_calls: options.maxCalls,
        max_prompt_bytes: options.maxPromptBytes,
        max_total_seconds: options.maxTotalSeconds,
        min_confidence: options.minConfidence,
        fallback: false,
        retry: false
      },
      runs
    };
    await outputHandle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`);
    await outputHandle.sync();
    completed = true;
    return { artifact, output: options.output, failed: runs.filter((item) => item.outcome === 'failed').length };
  } finally {
    await outputHandle.close();
    if (!completed) await rm(options.output, { force: true }).catch(() => {});
  }
}

async function main() {
  try {
    const output = await runLiveEval(process.argv.slice(2));
    if (output.help) process.stdout.write(output.help);
    else {
      process.stdout.write(`Buddy live eval wrote ${output.artifact.runs.length} run record(s) to ${escapeDiagnosticLine(output.output)}.\n`);
      if (output.failed) process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`Buddy live eval failed: ${escapeDiagnosticLine(error?.message ?? error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
