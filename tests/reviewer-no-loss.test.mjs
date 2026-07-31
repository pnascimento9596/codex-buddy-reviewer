import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { aggregateReviewOutcomes } from '../src/review-aggregate.mjs';
import { REVIEW_RESULT_SCHEMA } from '../src/review-schema.mjs';
import { preserveRejectedReviewerResponse } from '../src/rejected-response.mjs';
import { validateReviewResult } from '../src/result.mjs';

const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

function finding(index) {
  return {
    severity: 'low',
    confidence: 0.99,
    title: `Finding ${index}`,
    body: 'Synthetic body.',
    impact: 'Synthetic impact.',
    path: 'src/app.js',
    line_side: 'new',
    line_start: 1,
    line_end: 1,
    evidence: 'Synthetic evidence.',
    recommendation: 'Synthetic recommendation.'
  };
}

function result(count) {
  return {
    schema_version: '2',
    status: 'findings',
    summary: `Synthetic review with ${count} findings.`,
    findings: Array.from({ length: count }, (_, index) => finding(index + 1)),
    comments: []
  };
}

function evidence() {
  return {
    changed_paths: ['src/app.js'],
    path_evidence: [{
      path: 'src/app.js',
      disposition: 'complete',
      transmitted: true,
      file_state: 'modified'
    }],
    hunk_ranges: { 'src/app.js': [{ start: 1, end: 1, side: 'new' }] },
    line_counts: { 'src/app.js': 1 },
    old_line_counts: { 'src/app.js': 1 },
    incomplete_paths: [],
    excluded_paths: [],
    sensitive_change_count: 0,
    ignored_change_count: 0
  };
}

test('review schema and local validation accept six and forty findings completely', () => {
  assert.equal(Object.hasOwn(REVIEW_RESULT_SCHEMA.properties.findings, 'maxItems'), false);
  for (const count of [6, 40]) {
    const validated = validateReviewResult(result(count), evidence());
    assert.equal(validated.findings.length, count);
    assert.deepEqual(validated.findings.map((item) => item.title), result(count).findings.map((item) => item.title));
  }
});

test('multi-review aggregation preserves the complete verbose source result', () => {
  const verbose = result(40);
  const aggregate = aggregateReviewOutcomes([{
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    result: verbose
  }]);
  assert.equal(aggregate.reviews[0].result.findings.length, 40);
  assert.equal(aggregate.result.findings.length, 5);
  assert.match(aggregate.result.summary, /5 of 40 unique findings are shown/);
});

test('malformed reviewer output is preserved privately with its parse error', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'buddy-rejected-response-'));
  temporaryPaths.push(dataDir);
  const error = new Error('synthetic parse error');
  error.failureCode = 'invalid_review_json';
  const file = await preserveRejectedReviewerResponse({
    response: { stdout: '{not valid json', reviewPayload: null },
    evidence: {
      repository_root: '/synthetic/workspace',
      review_id: 'synthetic-review-id'
    },
    error,
    dataDir
  });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.raw_response, '{not valid json');
  assert.equal(saved.parse_error, 'synthetic parse error');
  assert.equal(saved.failure_code, 'invalid_review_json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('a transport-envelope failure preserves the raw provider bytes privately', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'buddy-rejected-transport-'));
  temporaryPaths.push(dataDir);
  const error = new Error('The provider returned an invalid transport envelope.');
  error.failureCode = 'invalid_transport_envelope';
  const rawEnvelope = JSON.stringify({ text: 'partial preamble only', stopReason: 'cancelled' });
  const file = await preserveRejectedReviewerResponse({
    response: { stdout: rawEnvelope, reviewPayload: null },
    evidence: {
      repository_root: '/synthetic/workspace',
      review_id: 'synthetic-transport-id'
    },
    error,
    dataDir
  });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.raw_response, rawEnvelope);
  assert.equal(saved.failure_code, 'invalid_transport_envelope');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('transport-failure preservation strips raw bytes from the propagating error', async () => {
  const { preserveTransportFailure } = await import('../src/cli.mjs');
  const { inspect } = await import('node:util');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'buddy-transport-strip-'));
  temporaryPaths.push(dataDir);
  const rawEnvelope = JSON.stringify({ text: 'raw provider bytes', stopReason: 'cancelled' });
  const error = new Error('The provider returned an invalid transport envelope.');
  error.failureCode = 'invalid_transport_envelope';
  Object.defineProperty(error, 'rawTransport', {
    value: { stdout: rawEnvelope }, enumerable: false, configurable: true
  });
  await preserveTransportFailure(error, {
    repository_root: '/synthetic/workspace',
    review_id: 'synthetic-strip-id'
  }, dataDir);
  const saved = JSON.parse(await readFile(error.rawResponsePath, 'utf8'));
  assert.equal(saved.raw_response, rawEnvelope);
  assert.equal((await stat(error.rawResponsePath)).mode & 0o777, 0o600);
  // The disk copy is now the only copy: no enumeration or inspection of the
  // propagating error may surface the raw bytes.
  assert.equal(Object.getOwnPropertyNames(error).includes('rawTransport'), false);
  assert.equal(Reflect.ownKeys(error).includes('rawTransport'), false);
  assert.doesNotMatch(inspect(error, { showHidden: true, depth: 4 }), /raw provider bytes/);
});
