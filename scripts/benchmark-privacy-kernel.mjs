#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  createPrivacyCoverage,
  createPrivacyCoverageIndex,
  matchPrivacyCandidate
} from '../src/privacy-inventory.mjs';
import {
  createPrivacyFragmentSalt,
  privacyFragmentFingerprints
} from '../src/privacy-fragments.mjs';

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function buildIndex(source) {
  const salt = createPrivacyFragmentSalt();
  const fragments = privacyFragmentFingerprints(source, salt);
  const coverage = createPrivacyCoverage({
    salt,
    scope: 'benchmark',
    requiredSourceClasses: ['denied_tree'],
    completedSourceClasses: ['denied_tree'],
    counters: {
      sources: 1,
      source_bytes: source.length,
      source_window_work: fragments.shortFingerprints.length,
      exact_fingerprints: 1,
      fragment_fingerprints: fragments.fingerprints.length,
      window_fingerprints: fragments.shortFingerprints.length
    }
  });
  return createPrivacyCoverageIndex({
    salt,
    exactFingerprints: [sha256(source)],
    fragmentFingerprints: fragments.fingerprints,
    windowFingerprints: fragments.shortFingerprints,
    coverage
  });
}

function runCase(name, source, candidate, iterations = 25) {
  const index = buildIndex(source);
  const durations = [];
  const cpuStart = process.cpuUsage();
  let result = null;
  let peakHeap = process.memoryUsage().heapUsed;
  let peakRss = process.memoryUsage().rss;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    result = matchPrivacyCandidate(candidate, index);
    durations.push(performance.now() - started);
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakRss = Math.max(peakRss, memory.rss);
  }
  const cpu = process.cpuUsage(cpuStart);
  return {
    name,
    iterations,
    source_bytes: source.length,
    candidate_bytes: candidate.length,
    result,
    wall_ms: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      maximum: Math.max(...durations)
    },
    cpu_ms: { user: cpu.user / 1000, system: cpu.system / 1000 },
    sampled_peak_heap_bytes: peakHeap,
    sampled_peak_rss_bytes: peakRss
  };
}

const ordinarySource = Buffer.from(Array.from(
  { length: 100 },
  (_, index) => `PRIVATE_${index}=unique_benchmark_material_${index};`
).join('\n'));
const ordinaryCandidate = Buffer.from('export const unrelated = true;\n'.repeat(80));
const excerptCandidate = ordinarySource.subarray(900, 996);

const output = {
  schema_version: '1',
  generated_at: new Date().toISOString(),
  node: process.version,
  git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
  note: 'Peak memory values are samples taken between synchronous match calls, not profiler maxima.',
  cases: [
    runCase('ordinary_no_match', ordinarySource, ordinaryCandidate),
    runCase('protected_excerpt_match', ordinarySource, excerptCandidate)
  ]
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
