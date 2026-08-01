import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { aggregateReviewOutcomes } from '../src/review-aggregate.mjs';
import { REVIEW_RESULT_SCHEMA } from '../src/review-schema.mjs';
import { preserveRejectedReviewerResponse } from '../src/rejected-response.mjs';
import { validateReviewResult } from '../src/result.mjs';
import { writePrivateJsonAtomic } from '../src/state.mjs';

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

async function assertPrivateMode(file) {
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
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
  await assertPrivateMode(file);
});

test('concurrent rejected reviewer responses retain every raw response', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'buddy-rejected-response-concurrent-'));
  temporaryPaths.push(dataDir);
  const error = Object.assign(new Error('synthetic parse error'), {
    failureCode: 'invalid_review_json'
  });
  const evidence = {
    repository_root: '/synthetic/workspace',
    review_id: 'synthetic-shared-review-id'
  };
  const files = await Promise.all([
    preserveRejectedReviewerResponse({
      response: { stdout: 'first raw response', reviewPayload: null },
      evidence,
      error,
      dataDir
    }),
    preserveRejectedReviewerResponse({
      response: { stdout: 'second raw response', reviewPayload: null },
      evidence,
      error,
      dataDir
    })
  ]);
  assert.notEqual(files[0], files[1]);
  const saved = await Promise.all(files.map(async (file) => {
    await assertPrivateMode(file);
    return JSON.parse(await readFile(file, 'utf8'));
  }));
  assert.deepEqual(
    new Set(saved.map((item) => item.raw_response)),
    new Set(['first raw response', 'second raw response'])
  );
});

test('rejected-response preservation refuses a review id that escapes its workspace directory', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'buddy-rejected-response-escape-'));
  temporaryPaths.push(dataDir);
  const escaped = path.join(dataDir, 'rejected-responses', 'escaped-review', 'response.json');
  await assert.rejects(
    preserveRejectedReviewerResponse({
      response: { stdout: '{not valid json', reviewPayload: null },
      evidence: {
        repository_root: '/synthetic/workspace',
        review_id: '../escaped-review'
      },
      error: Object.assign(new Error('synthetic parse error'), {
        failureCode: 'invalid_review_json'
      }),
      dataDir
    }),
    /review id is invalid/
  );
  await assert.rejects(stat(escaped), { code: 'ENOENT' });
});

test('rejected-response preservation refuses a data root inside the reviewed repository', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'buddy-rejected-response-repository-'));
  temporaryPaths.push(repositoryRoot);
  const dataDir = path.join(repositoryRoot, '.buddy-private');
  await assert.rejects(
    preserveRejectedReviewerResponse({
      response: { stdout: '{not valid json', reviewPayload: null },
      evidence: {
        repository_root: repositoryRoot,
        review_id: 'synthetic-contained-review'
      },
      error: Object.assign(new Error('synthetic parse error'), {
        failureCode: 'invalid_review_json'
      }),
      dataDir
    }),
    /rejected-response state directory must be outside the reviewed repository/
  );
  await assert.rejects(stat(dataDir), { code: 'ENOENT' });
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
  await assertPrivateMode(file);
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
  await assertPrivateMode(error.rawResponsePath);
  // The disk copy is now the only copy: no enumeration or inspection of the
  // propagating error may surface the raw bytes.
  assert.equal(Object.getOwnPropertyNames(error).includes('rawTransport'), false);
  assert.equal(Reflect.ownKeys(error).includes('rawTransport'), false);
  assert.doesNotMatch(inspect(error, { showHidden: true, depth: 4 }), /raw provider bytes/);
});

test('transport-failure cleanup strips an empty raw transport envelope', async () => {
  const { preserveTransportFailure } = await import('../src/cli.mjs');
  const error = new Error('The provider returned no transport output.');
  Object.defineProperty(error, 'rawTransport', {
    value: { stdout: '' }, enumerable: false, configurable: true
  });

  await preserveTransportFailure(error, {
    repository_root: '/synthetic/workspace',
    review_id: 'synthetic-empty-transport-id'
  });
  assert.equal(Object.getOwnPropertyNames(error).includes('rawTransport'), false);
  assert.equal(Reflect.ownKeys(error).includes('rawTransport'), false);
});

test('rejected-response preservation retries a directory removed before the atomic open', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'buddy-rejected-response-recreate-'));
  temporaryPaths.push(dataDir);
  const error = new Error('Synthetic rejected response.');
  error.failureCode = 'invalid_review_schema';
  let attempts = 0;

  const file = await preserveRejectedReviewerResponse({
    response: { stdout: '{"status":"no_findings"}', reviewPayload: null },
    evidence: {
      repository_root: '/synthetic/workspace',
      review_id: 'synthetic-directory-retry-id'
    },
    error,
    dataDir,
    writeJsonAtomic: async (target, value) => {
      attempts += 1;
      if (attempts === 1) {
        await rm(path.dirname(target), { recursive: true, force: true });
        const missing = new Error('synthetic directory removal');
        missing.code = 'ENOENT';
        throw missing;
      }
      return writePrivateJsonAtomic(target, value);
    }
  });

  assert.equal(attempts, 2);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).raw_response, '{"status":"no_findings"}');
  await assertPrivateMode(file);
});
