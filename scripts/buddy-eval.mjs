#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeDiagnosticLine } from '../src/policy.mjs';
import { DEFAULT_CORPUS_MANIFEST, loadEvalCorpus, scoreEvalArtifact } from './lib/eval-corpus.mjs';

const HELP = `Codex Buddy deterministic evaluator

Usage:
  buddy-eval.mjs validate [--corpus <manifest>] [--json]
  buddy-eval.mjs score --results <artifact.json> [--corpus <manifest>] [--json]

These commands are offline: they do not import or invoke a review provider.
Use buddy-live-eval.mjs with its explicit live budgets for model calls.
`;

export function parseEvalArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('-') ? args.shift() : 'validate';
  if (!['validate', 'score'].includes(action)) throw new Error('eval action must be validate or score');
  const options = { action, corpus: DEFAULT_CORPUS_MANIFEST, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--corpus' || arg === '--results') {
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('-')) throw new Error(`${arg} requires a path`);
      index += 1;
      if (arg === '--corpus') options.corpus = path.resolve(value);
      else options.results = path.resolve(value);
    } else throw new Error(`unknown eval argument: ${arg}`);
  }
  if (!options.help && action === 'score' && !options.results) throw new Error('eval score requires --results');
  if (action !== 'score' && options.results) throw new Error('--results is allowed only for eval score');
  return options;
}

export async function runEvalCommand(argv) {
  const options = parseEvalArgs(argv);
  if (options.help) return { help: HELP, json: options.json };
  const corpus = await loadEvalCorpus(options.corpus);
  if (options.action === 'validate') {
    return {
      json: options.json,
      result: {
        schema_version: '1',
        corpus_id: corpus.manifest.corpus_id,
        review_schema_version: corpus.manifest.review_schema_version,
        case_count: corpus.cases.length,
        categories: [...new Set(corpus.cases.map((item) => item.category))].sort(),
        cases: corpus.cases.map((item) => ({
          id: item.id,
          category: item.category,
          egress_expected: item.egress_expected
        }))
      }
    };
  }
  const artifact = JSON.parse(await readFile(options.results, 'utf8'));
  return { json: options.json, result: await scoreEvalArtifact(artifact, corpus) };
}

export function renderEvalOutput(output) {
  if (output.help) return output.help;
  if (output.result.case_count !== undefined) {
    return `Buddy eval corpus ${output.result.corpus_id}: ${output.result.case_count} valid deterministic cases.\n`;
  }
  return `Buddy eval score: ${output.result.passed}/${output.result.total} passed; ${output.result.failed} failed.\n`;
}

async function main() {
  try {
    const output = await runEvalCommand(process.argv.slice(2));
    process.stdout.write(output.json && output.result ? `${JSON.stringify(output.result, null, 2)}\n` : renderEvalOutput(output));
  } catch (error) {
    process.stderr.write(`Buddy eval failed: ${escapeDiagnosticLine(error?.message ?? error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
