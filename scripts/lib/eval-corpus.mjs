import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CORPUS_MANIFEST = fileURLToPath(
  new URL('../../evals/corpus/manifest.json', import.meta.url)
);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CATEGORIES = new Set(['clean', 'defect', 'abstain', 'privacy', 'deletion']);
const STATUSES = new Set(['findings', 'no_findings', 'abstain']);
const PROVIDER_CALLS = new Set(['required', 'forbidden']);
const MAX_CORPUS_CASES = 100;
const MAX_EVAL_RUNS = 10;
const MAX_PLANNED_RUNS = MAX_CORPUS_CASES * MAX_EVAL_RUNS;

function fail(message) {
  throw new Error(`Buddy eval corpus: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readPlainFile(file, label) {
  const details = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') fail(`${label} is missing`);
    throw error;
  });
  if (details.isSymbolicLink() || !details.isFile()) fail(`${label} must be a regular non-symlink file`);
  return readFile(file);
}

async function readPlainJson(file, label) {
  try {
    return JSON.parse((await readPlainFile(file, label)).toString('utf8'));
  } catch (error) {
    if (error.message.startsWith('Buddy eval corpus:')) throw error;
    fail(`${label} is not valid JSON`);
  }
}

function safeRepoPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 500
    && !path.posix.isAbsolute(value)
    && !value.split('/').includes('..')
    && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(value);
}

function validateRanges(ranges, label) {
  if (!Array.isArray(ranges)) fail(`${label} must be an array`);
  for (const [index, range] of ranges.entries()) {
    const allowed = range.kind === undefined ? ['start', 'end', 'side'] : ['start', 'end', 'side', 'kind'];
    exactKeys(range, allowed, `${label}[${index}]`);
    if (!Number.isInteger(range.start) || range.start < 1
        || !Number.isInteger(range.end) || range.end < range.start
        || !['new', 'old'].includes(range.side)) fail(`${label}[${index}] has an invalid range`);
    if (range.kind !== undefined && !['deletion', 'metadata'].includes(range.kind)) {
      fail(`${label}[${index}] has an unsupported synthetic-anchor kind`);
    }
  }
}

function validateEvidence(evidence, category) {
  exactKeys(evidence, [
    'schema_version', 'review_id', 'captured_at', 'repository_root', 'head', 'scope', 'base',
    'changed_paths', 'excluded_paths', 'sensitive_change_count', 'ignored_change_count',
    'path_evidence', 'incomplete_paths', 'hunk_ranges', 'status', 'patch', 'patch_hash',
    'patch_bytes', 'truncated', 'line_counts', 'old_line_counts'
  ], 'case evidence');
  if (evidence.schema_version !== '1' || typeof evidence.review_id !== 'string' || !evidence.review_id.startsWith('eval-')) {
    fail('case evidence has an unsupported identity or schema');
  }
  if (!Number.isFinite(Date.parse(evidence.captured_at)) || evidence.repository_root !== 'eval-fixture'
      || evidence.scope !== 'turn' || typeof evidence.head !== 'string' || typeof evidence.base !== 'string') {
    fail('case evidence has invalid fixed metadata');
  }
  for (const field of ['changed_paths', 'excluded_paths', 'path_evidence', 'incomplete_paths']) {
    if (!Array.isArray(evidence[field])) fail(`case evidence.${field} must be an array`);
  }
  if (!Number.isInteger(evidence.sensitive_change_count) || evidence.sensitive_change_count < 0
      || !Number.isInteger(evidence.ignored_change_count) || evidence.ignored_change_count < 0) {
    fail('case evidence aggregate counts must be non-negative integers');
  }
  if (typeof evidence.patch !== 'string' || !SHA256_PATTERN.test(evidence.patch_hash)
      || evidence.patch_hash !== sha256(Buffer.from(evidence.patch))
      || evidence.patch_bytes !== Buffer.byteLength(evidence.patch)
      || typeof evidence.truncated !== 'boolean') fail('case evidence patch bytes or digest do not match');

  const changed = new Set();
  for (const repoPath of evidence.changed_paths) {
    if (!safeRepoPath(repoPath) || changed.has(repoPath)) fail('case evidence changed_paths must contain unique safe repository-relative paths');
    changed.add(repoPath);
  }
  if (!evidence.hunk_ranges || typeof evidence.hunk_ranges !== 'object' || Array.isArray(evidence.hunk_ranges)
      || !evidence.line_counts || typeof evidence.line_counts !== 'object' || Array.isArray(evidence.line_counts)
      || !evidence.old_line_counts || typeof evidence.old_line_counts !== 'object' || Array.isArray(evidence.old_line_counts)) {
    fail('case evidence line and hunk maps must be objects');
  }
  const seenEvidence = new Set();
  for (const [index, item] of evidence.path_evidence.entries()) {
    exactKeys(item, ['path', 'disposition', 'patch_bytes', 'transmitted', 'hunk_ranges'], `path_evidence[${index}]`);
    if (!safeRepoPath(item.path) || !changed.has(item.path) || seenEvidence.has(item.path)) {
      fail(`path_evidence[${index}] has an invalid or duplicate path`);
    }
    seenEvidence.add(item.path);
    if (typeof item.disposition !== 'string' || !Number.isInteger(item.patch_bytes) || item.patch_bytes < 0
        || typeof item.transmitted !== 'boolean') fail(`path_evidence[${index}] has invalid disposition metadata`);
    validateRanges(item.hunk_ranges, `path_evidence[${index}].hunk_ranges`);
    validateRanges(evidence.hunk_ranges[item.path], `hunk_ranges.${item.path}`);
    if (JSON.stringify(item.hunk_ranges) !== JSON.stringify(evidence.hunk_ranges[item.path])) {
      fail(`path_evidence[${index}] and hunk_ranges disagree`);
    }
    if (item.transmitted && item.disposition !== 'complete') fail(`path_evidence[${index}] transmits incomplete evidence`);
  }
  for (const repoPath of evidence.incomplete_paths) {
    if (!changed.has(repoPath)) fail('case evidence incomplete_paths must be selected changed paths');
  }
  if (category === 'privacy') {
    if (evidence.changed_paths.length || evidence.path_evidence.length || evidence.excluded_paths.length
        || evidence.patch.length || evidence.sensitive_change_count < 1) {
      fail('privacy case must contain only a sensitive aggregate and no path or patch bytes');
    }
  }
}

function validateExpected(expected, evidence, egressExpected) {
  exactKeys(expected, ['allowed_statuses', 'min_findings', 'max_findings', 'provider_call', 'required_anchors'], 'case expected policy');
  if (!Array.isArray(expected.allowed_statuses) || !expected.allowed_statuses.length
      || expected.allowed_statuses.some((status) => !STATUSES.has(status))) fail('expected.allowed_statuses is invalid');
  if (!Number.isInteger(expected.min_findings) || expected.min_findings < 0
      || !Number.isInteger(expected.max_findings) || expected.max_findings < expected.min_findings || expected.max_findings > 5) {
    fail('expected finding bounds are invalid');
  }
  if (!PROVIDER_CALLS.has(expected.provider_call)
      || (expected.provider_call === 'required') !== egressExpected) fail('expected provider-call policy disagrees with egress_expected');
  if (!Array.isArray(expected.required_anchors)) fail('expected.required_anchors must be an array');
  for (const [index, anchor] of expected.required_anchors.entries()) {
    exactKeys(anchor, ['path', 'line_side', 'start', 'end'], `required_anchors[${index}]`);
    const ranges = evidence.hunk_ranges[anchor.path] ?? [];
    if (!['new', 'old'].includes(anchor.line_side) || !Number.isInteger(anchor.start) || !Number.isInteger(anchor.end)
        || !ranges.some((range) => range.side === anchor.line_side && anchor.start >= range.start && anchor.end <= range.end)) {
      fail(`required_anchors[${index}] is not grounded in case evidence`);
    }
  }
}

function validateCase(value, expectedId) {
  exactKeys(value, ['schema_version', 'id', 'category', 'description', 'live_eligible', 'egress_expected', 'evidence', 'expected'], `case ${expectedId}`);
  if (value.schema_version !== '1' || value.id !== expectedId || !ID_PATTERN.test(value.id)
      || !CATEGORIES.has(value.category) || typeof value.description !== 'string' || !value.description.trim()
      || typeof value.live_eligible !== 'boolean' || typeof value.egress_expected !== 'boolean') {
    fail(`case ${expectedId} has invalid metadata`);
  }
  validateEvidence(value.evidence, value.category);
  validateExpected(value.expected, value.evidence, value.egress_expected);
  if (!value.live_eligible && value.egress_expected) fail(`case ${expectedId} cannot require egress when live_eligible is false`);
  return value;
}

export async function loadEvalCorpus(manifestFile = DEFAULT_CORPUS_MANIFEST) {
  const requested = path.resolve(manifestFile);
  const canonical = await realpath(requested).catch((error) => {
    if (error.code === 'ENOENT') fail('manifest is missing');
    throw error;
  });
  const root = await realpath(path.dirname(canonical));
  const manifest = await readPlainJson(canonical, 'manifest');
  exactKeys(manifest, ['schema_version', 'corpus_id', 'review_schema_version', 'cases'], 'manifest');
  if (manifest.schema_version !== '1' || !ID_PATTERN.test(manifest.corpus_id)
      || typeof manifest.review_schema_version !== 'string' || !Array.isArray(manifest.cases)
      || !manifest.cases.length || manifest.cases.length > MAX_CORPUS_CASES) {
    fail('manifest has invalid metadata');
  }
  const ids = new Set();
  const cases = [];
  for (const [index, entry] of manifest.cases.entries()) {
    exactKeys(entry, ['id', 'path', 'sha256'], `manifest case ${index}`);
    if (!ID_PATTERN.test(entry.id) || ids.has(entry.id) || !SHA256_PATTERN.test(entry.sha256)
        || typeof entry.path !== 'string' || path.isAbsolute(entry.path)) fail(`manifest case ${index} is invalid`);
    ids.add(entry.id);
    const caseFile = path.resolve(root, entry.path);
    const relative = path.relative(root, caseFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail(`manifest case ${entry.id} escapes the corpus root`);
    const canonicalCase = await realpath(caseFile).catch((error) => {
      if (error.code === 'ENOENT') fail(`case ${entry.id} is missing`);
      throw error;
    });
    const canonicalRelative = path.relative(root, canonicalCase);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      fail(`manifest case ${entry.id} escapes the canonical corpus root`);
    }
    if (canonicalCase !== caseFile) fail(`case ${entry.id} uses a symlinked path component`);
    const bytes = await readPlainFile(canonicalCase, `case ${entry.id}`);
    if (sha256(bytes) !== entry.sha256) fail(`case ${entry.id} digest does not match the manifest`);
    let raw;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail(`case ${entry.id} is not valid JSON`);
    }
    cases.push(validateCase(raw, entry.id));
  }
  const sorted = [...manifest.cases].sort((left, right) => left.id.localeCompare(right.id));
  if (manifest.cases.some((entry, index) => entry.id !== sorted[index].id)) fail('manifest cases must be sorted by id');
  for (const category of CATEGORIES) {
    if (!cases.some((item) => item.category === category)) fail(`corpus is missing required category ${category}`);
  }
  return { manifest, cases, manifestFile: canonical };
}

function validateFindingGrounding(finding, evidence, label) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) fail(`${label} must be an object`);
  if (!safeRepoPath(finding.path) || !['new', 'old'].includes(finding.line_side)
      || !Number.isInteger(finding.line_start) || !Number.isInteger(finding.line_end) || finding.line_end < finding.line_start) {
    fail(`${label} has invalid grounding fields`);
  }
  const transmitted = evidence.path_evidence.find(
    (item) => item.path === finding.path && item.disposition === 'complete' && item.transmitted
  );
  const ranges = evidence.hunk_ranges[finding.path] ?? [];
  if (!transmitted || !ranges.some((range) => (
    range.side === finding.line_side && finding.line_start >= range.start && finding.line_end <= range.end
  ))) fail(`${label} is not grounded in complete transmitted evidence`);
}

function scoreRun(run, evalCase) {
  if (!run || typeof run !== 'object' || run.case_id !== evalCase.id || !Number.isInteger(run.run) || run.run < 1
      || typeof run.provider_called !== 'boolean' || typeof run.outcome !== 'string') fail(`result run for ${evalCase.id} has invalid metadata`);
  const providerRequired = evalCase.expected.provider_call === 'required';
  const failures = [];
  if (run.provider_called !== providerRequired) failures.push('provider-call policy mismatch');
  if (!run.result || typeof run.result !== 'object') failures.push('missing validated result');
  else {
    if (!evalCase.expected.allowed_statuses.includes(run.result.status)) failures.push(`unexpected status ${run.result.status}`);
    if (!Array.isArray(run.result.findings)) failures.push('findings is not an array');
    else {
      if (run.result.findings.length < evalCase.expected.min_findings || run.result.findings.length > evalCase.expected.max_findings) {
        failures.push('finding count outside expected bounds');
      }
      for (const [index, finding] of run.result.findings.entries()) {
        try { validateFindingGrounding(finding, evalCase.evidence, `finding ${index + 1}`); } catch (error) { failures.push(error.message); }
      }
      for (const anchor of evalCase.expected.required_anchors) {
        if (!run.result.findings.some((finding) => finding.path === anchor.path && finding.line_side === anchor.line_side
          && finding.line_start <= anchor.start && finding.line_end >= anchor.end)) failures.push(`missing required anchor ${anchor.path}:${anchor.start}`);
      }
    }
  }
  return { case_id: evalCase.id, run: run.run, passed: failures.length === 0, failures };
}

export async function scoreEvalArtifact(artifact, corpus) {
  if (!artifact || typeof artifact !== 'object' || artifact.schema_version !== '1'
      || artifact.corpus_id !== corpus.manifest.corpus_id || !artifact.config || !Array.isArray(artifact.runs)) {
    fail('result artifact has an unsupported identity or schema');
  }
  const selected = artifact.config.cases;
  if (!Array.isArray(selected) || !selected.length || selected.length > MAX_CORPUS_CASES
      || !Number.isInteger(artifact.config.runs) || artifact.config.runs < 1 || artifact.config.runs > MAX_EVAL_RUNS) {
    fail('result artifact has an invalid case/run configuration');
  }
  const caseMap = new Map(corpus.cases.map((item) => [item.id, item]));
  if (selected.length > caseMap.size) fail('result artifact selects too many corpus cases');
  const selectedIds = new Set();
  for (const id of selected) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || selectedIds.has(id)) {
      fail('result artifact cases must be nonempty, unique, bounded corpus case ids');
    }
    selectedIds.add(id);
    if (!caseMap.has(id)) fail(`result artifact selects unknown case ${id}`);
  }
  const plannedRunCount = selected.length * artifact.config.runs;
  if (!Number.isSafeInteger(plannedRunCount) || plannedRunCount > MAX_PLANNED_RUNS
      || artifact.runs.length > plannedRunCount) {
    fail('result artifact planned run cardinality is invalid');
  }
  const expectedKeys = new Set();
  for (const id of selected) {
    for (let run = 1; run <= artifact.config.runs; run += 1) expectedKeys.add(`${id}:${run}`);
  }
  const scores = [];
  for (const record of artifact.runs) {
    const key = `${record.case_id}:${record.run}`;
    if (!expectedKeys.delete(key)) fail(`result artifact contains duplicate or unplanned run ${key}`);
    scores.push(scoreRun(record, caseMap.get(record.case_id)));
  }
  if (expectedKeys.size) fail(`result artifact is missing planned runs: ${[...expectedKeys].join(', ')}`);
  return {
    schema_version: '1',
    corpus_id: corpus.manifest.corpus_id,
    total: scores.length,
    passed: scores.filter((item) => item.passed).length,
    failed: scores.filter((item) => !item.passed).length,
    scores
  };
}
