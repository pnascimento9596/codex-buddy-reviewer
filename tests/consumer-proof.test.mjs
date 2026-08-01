import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const script = path.join(projectRoot, 'scripts', 'consumer-proof.mjs');
const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function runProof(root, cwd = projectRoot) {
  try {
    const result = await execFileAsync(process.execPath, [script, root], {
      cwd,
      encoding: 'utf8',
      windowsHide: true
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
}

test('consumer proof resolves a supplied relative root before loading modules', async () => {
  const result = await runProof('.');
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.root, projectRoot);
  assert.equal(output.fortyFindingComplete, true);
  assert.equal(output.reasoningTolerated, true);
  assert.equal(output.endTurnAccepted, true);
});

test('consumer proof rejects a nonexistent root with an explicit diagnostic', async () => {
  const missing = path.join(projectRoot, 'does-not-exist-consumer-proof-root');
  const result = await runProof(missing);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /consumer proof root does not exist/u);
});

test('consumer proof exits nonzero when any behavioral probe is not strictly true', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-buddy-consumer-proof-'));
  temporaryPaths.push(root);
  const source = path.join(root, 'src');
  const providers = path.join(source, 'providers');
  await mkdir(providers, { recursive: true });
  await writeFile(path.join(source, 'result.mjs'), `
export function validateReviewResult(result) {
  return { ...result, findings: result.findings.slice(0, 5) };
}
`);
  await writeFile(path.join(source, 'review-aggregate.mjs'), `
export function aggregateReviewOutcomes(reviews) {
  return { reviews };
}
`);
  await writeFile(path.join(providers, 'opencode.mjs'), `
export function parseOpenCodeTransport() {}
`);
  await writeFile(path.join(source, 'provider-contract.mjs'), `
export function parseGrokTransport() {}
`);

  const result = await runProof(root);
  assert.equal(result.code, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.fortyFindingComplete, false);
  assert.equal(output.reasoningTolerated, true);
  assert.equal(output.endTurnAccepted, true);
});
