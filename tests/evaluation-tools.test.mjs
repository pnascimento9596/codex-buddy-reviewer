import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { runEvalCommand } from '../scripts/buddy-eval.mjs';
import { parseLiveEvalArgs, runLiveEval as runLiveEvalImpl } from '../scripts/buddy-live-eval.mjs';
import { loadEvalCorpus, scoreEvalArtifact } from '../scripts/lib/eval-corpus.mjs';
import { inspectWebpStructure, validatePetAtlases } from '../scripts/validate-pet-atlases.mjs';
import {
  MACHINE_HOST_GATES,
  MANUAL_HOST_GATES,
  MANUAL_VISUAL_GATES,
  collectHostEvidenceV2,
  decodeHostEvidenceBundleSecret,
  parseHostE2eArgs,
  validateHostEvidenceBundle,
  validateHostE2eReport
} from '../scripts/verify-host-e2e.mjs';
import { inspectApprovedProviderReviewRequest } from '../src/provider-registry.mjs';
import { REVIEW_RESULT_SCHEMA } from '../src/review-schema.mjs';
import { canonicalJson, opaqueKey, workspaceKey } from '../src/state.mjs';

const temporaryPaths = [];
const runLiveEval = (argv, overrides = {}) => runLiveEvalImpl(argv, {
  platform: 'linux',
  ...overrides
});
const publicPetIds = [
  'buddy-byte',
  'buddy-mochi',
  'buddy-orbit',
  'buddy-bella',
  'buddy-lupo'
];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function hostEvidenceFixture(options = {}) {
  const root = await temporaryDirectory('codex-buddy-host-evidence-');
  const artifactRoot = path.join(root, 'artifact');
  const installedSnapshotRoot = path.join(root, 'installed');
  const workspaceRoot = path.join(root, 'workspace');
  const runtimeDataDir = path.join(root, 'runtime');
  const codexHome = path.join(root, 'codex-home');
  const petIds = options.petIds ?? ['buddy-byte'];
  const petId = options.petId ?? petIds[0];
  const petAssets = new Map(petIds.map((id) => [id, {
    manifest: Buffer.from(`${JSON.stringify({ id, schema_version: '1' })}\n`),
    atlas: Buffer.from(`test-pet-atlas:${id}`)
  }]));
  const plugin = { name: 'codex-buddy-reviewer', version: '0.5.0' };
  const hooks = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node hooks/stop.mjs' }] }] } };
  const catalog = {
    schema_version: '1',
    pets: petIds.map((id) => ({
      id,
      scope: 'public',
      available: true,
      manifestSha256: sha256(petAssets.get(id).manifest),
      spritesheetSha256: sha256(petAssets.get(id).atlas)
    }))
  };
  const artifactFiles = new Map([
    ['.codex-plugin/plugin.json', Buffer.from(`${JSON.stringify(plugin, null, 2)}\n`)],
    ['assets/pets/catalog.json', Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`)],
    ['hooks/hooks.json', Buffer.from(`${JSON.stringify(hooks, null, 2)}\n`)]
  ]);
  for (const [id, assets] of petAssets) {
    artifactFiles.set(`assets/pets/${id}/pet.json`, assets.manifest);
    artifactFiles.set(`assets/pets/${id}/spritesheet.webp`, assets.atlas);
  }
  for (const [relative, bytes] of artifactFiles) {
    const target = path.join(artifactRoot, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeJson(path.join(artifactRoot, 'release-manifest.json'), {
    schema_version: '1',
    package_name: plugin.name,
    version: plugin.version,
    source_commit: options.sourceCommit ?? 'a'.repeat(40),
    public_pet_ids: petIds,
    files: [...artifactFiles.entries()].map(([relative, bytes]) => ({
      path: relative,
      bytes: bytes.length,
      mode: '0644',
      sha256: sha256(bytes)
    })).sort((left, right) => left.path.localeCompare(right.path))
  });
  await cp(artifactRoot, installedSnapshotRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  for (const [id, assets] of petAssets) {
    const installedPetRoot = path.join(codexHome, 'pets', id);
    await mkdir(installedPetRoot, { recursive: true });
    await writeFile(path.join(installedPetRoot, 'pet.json'), assets.manifest);
    await writeFile(path.join(installedPetRoot, 'spritesheet.webp'), assets.atlas);
  }

  const sessionId = 'host-session-id';
  const turnId = 'host-turn-id';
  const workspaceId = workspaceKey(await realpath(workspaceRoot));
  const sessionKey = opaqueKey(sessionId);
  const turnKey = opaqueKey(turnId);
  const reviewKey = 'b'.repeat(64);
  const receipt = {
    schema_version: '1',
    review_key: reviewKey,
    terminal_status: 'no_findings',
    provider: 'claude+opencode',
    model: 'claude-opus-4-8+openai/gpt-5.6',
    baseline_tree: 'c'.repeat(40),
    final_tree: 'd'.repeat(40),
    patch_hash: 'e'.repeat(64),
    changed_path_count: 1,
    result: {
      schema_version: '2',
      status: 'no_findings',
      summary: 'No validated defects.',
      findings: [],
      comments: []
    },
    reviewer_runs: [
      {
        source_index: 0,
        provider: 'claude',
        model: 'claude-opus-4-8',
        status: 'succeeded',
        result: {
          schema_version: '2', status: 'no_findings', summary: 'Claude found no validated defects.',
          findings: [], comments: []
        },
        failure: null,
        summary_claim_advisory: null,
        provider_run: null,
        egress_capability: null
      },
      {
        source_index: 1,
        provider: 'opencode',
        model: 'openai/gpt-5.6',
        status: 'succeeded',
        result: {
          schema_version: '2', status: 'no_findings', summary: 'GPT found no validated defects.',
          findings: [], comments: []
        },
        failure: null,
        summary_claim_advisory: null,
        provider_run: null,
        egress_capability: null
      }
    ],
    created_at: '2026-07-18T12:02:00.000Z'
  };
  await writeJson(
    path.join(runtimeDataDir, 'automatic-reviews', workspaceId, `${reviewKey}.json`),
    receipt
  );
  await writeJson(path.join(runtimeDataDir, 'turns', workspaceId, sessionKey, turnKey, 'completed.json'), {
    schema_version: '1',
    review_key: reviewKey,
    terminal_status: 'no_findings',
    completed_at: '2026-07-18T12:03:00.000Z',
    presentation_status: 'observed',
    presentation_observed_at: '2026-07-18T12:04:00.000Z'
  });
  const event = {
    schema_version: '2',
    event_type: 'review_completed',
    event_id: null,
    sequence: 1,
    workspace_key: workspaceId,
    session_key: sessionKey,
    turn_key: turnKey,
    review_key: reviewKey,
    presentation_state: 'success',
    occurred_at: '2026-07-18T12:03:30.000Z',
    payload: {
      headline: 'Buddy review completed',
      detail: 'No validated defects.',
      worker_summary: null,
      review: {
        status: 'no_findings',
        summary: 'No validated defects.',
        findings: [],
        comments: [],
        provider: 'claude+opencode',
        model: 'claude-opus-4-8+openai/gpt-5.6'
      },
      reviews: [
        {
          source_index: 0,
          provider: 'claude',
          model: 'claude-opus-4-8',
          status: 'succeeded',
          result: { status: 'no_findings', summary: 'Claude found no validated defects.', findings: [], comments: [] },
          failure: null
        },
        {
          source_index: 1,
          provider: 'opencode',
          model: 'openai/gpt-5.6',
          status: 'succeeded',
          result: { status: 'no_findings', summary: 'GPT found no validated defects.', findings: [], comments: [] },
          failure: null
        }
      ],
      summary_advisory: null,
      companion: null
    }
  };
  event.event_id = sha256(Buffer.from(canonicalJson({
    schema_version: '1',
    event_type: event.event_type,
    workspace_key: event.workspace_key,
    session_key: event.session_key,
    turn_key: event.turn_key,
    review_key: event.review_key,
    presentation_state: event.presentation_state,
    payload: event.payload
  })));
  const outboxFile = path.join(runtimeDataDir, 'outbox', workspaceId, sessionKey, `${event.event_id}.json`);
  await writeJson(outboxFile, event);

  return {
    collectOptions: {
      artifactRoot,
      installedSnapshotRoot,
      workspaceRoot,
      runtimeDataDir,
      codexHome,
      petId,
      sessionId,
      turnId,
      taskReference: 'private-host-task-1',
      startedAt: '2026-07-18T12:00:00.000Z',
      now: () => new Date('2026-07-18T12:05:00.000Z')
    },
    artifactRoot,
    installedSnapshotRoot,
    outboxFile
  };
}

function attestHostEvidence(report) {
  for (const id of MANUAL_HOST_GATES) report.manual_host_gates[id] = {
    status: 'manual_pass',
    observer: 'Test Observer',
    observed_at: '2026-07-18T12:04:30.000Z',
    notes: `Observed host gate ${id}.`
  };
  for (const id of MANUAL_VISUAL_GATES) report.manual_visual_gates[id] = {
    status: 'manual_pass',
    observer: 'Test Observer',
    observed_at: '2026-07-18T12:04:30.000Z',
    notes: `Observed visual gate ${id}.`
  };
  return report;
}

function runScript(script, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(script), ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

function defectResult() {
  return {
    schema_version: '2',
    status: 'findings',
    summary: 'The subtraction operands are reversed.',
    findings: [{
      severity: 'high',
      confidence: 0.99,
      title: 'Remaining capacity is inverted',
      body: 'Used capacity is subtracted in the wrong direction.',
      impact: 'Callers receive zero while capacity remains and a positive value after the limit is exceeded.',
      path: 'src/quota.js',
      line_side: 'new',
      line_start: 2,
      line_end: 2,
      evidence: 'The changed expression is used - limit instead of limit - used.',
      recommendation: 'Restore Math.max(0, limit - used).'
    }],
    comments: []
  };
}

test('offline corpus validation covers every required category with hash-pinned fixtures', async () => {
  const output = await runEvalCommand(['validate', '--json']);
  assert.equal(output.result.case_count, 5);
  assert.deepEqual(output.result.categories, ['abstain', 'clean', 'defect', 'deletion', 'privacy']);
  assert.equal(output.result.cases.filter((item) => item.egress_expected).length, 3);
});

test('custom corpus rejects intermediate and final case symlinks before reading case bytes', async () => {
  const sourceRoot = path.resolve('evals/corpus');
  const manifest = await readFile(path.join(sourceRoot, 'manifest.json'), 'utf8');

  const intermediateRoot = await temporaryDirectory('codex-buddy-eval-intermediate-link-');
  await cp(path.join(sourceRoot, 'cases'), path.join(intermediateRoot, 'real-cases'), { recursive: true });
  await symlink('real-cases', path.join(intermediateRoot, 'cases'), 'dir');
  await writeFile(path.join(intermediateRoot, 'manifest.json'), manifest);
  await assert.rejects(
    loadEvalCorpus(path.join(intermediateRoot, 'manifest.json')),
    /uses a symlinked path component/
  );

  const finalRoot = await temporaryDirectory('codex-buddy-eval-final-link-');
  await cp(path.join(sourceRoot, 'cases'), path.join(finalRoot, 'cases'), { recursive: true });
  const firstCase = JSON.parse(manifest).cases[0].path;
  const original = path.join(finalRoot, firstCase);
  const target = path.join(finalRoot, 'case-target.json');
  await cp(original, target);
  await rm(original);
  await symlink(path.relative(path.dirname(original), target), original);
  await writeFile(path.join(finalRoot, 'manifest.json'), manifest);
  await assert.rejects(
    loadEvalCorpus(path.join(finalRoot, 'manifest.json')),
    /uses a symlinked path component/
  );
});

test('offline scorer enforces provider policy, grounded anchors, and complete planned runs', async () => {
  const corpus = await loadEvalCorpus();
  const artifact = {
    schema_version: '1',
    corpus_id: corpus.manifest.corpus_id,
    config: { cases: ['defect-reversed-subtraction', 'privacy-sensitive-aggregate'], runs: 1 },
    runs: [
      {
        case_id: 'defect-reversed-subtraction', run: 1, provider_called: true,
        outcome: 'completed', result: defectResult()
      },
      {
        case_id: 'privacy-sensitive-aggregate', run: 1, provider_called: false,
        outcome: 'local_no_egress',
        result: { schema_version: '2', status: 'abstain', summary: 'No egress.', findings: [], comments: [] }
      }
    ]
  };
  const scored = await scoreEvalArtifact(artifact, corpus);
  assert.equal(scored.passed, 2);
  const violated = structuredClone(artifact);
  violated.runs[1].provider_called = true;
  assert.equal((await scoreEvalArtifact(violated, corpus)).failed, 1);

  for (const config of [
    { cases: [], runs: 1 },
    { cases: ['defect-reversed-subtraction', 'defect-reversed-subtraction'], runs: 1 },
    { cases: ['defect-reversed-subtraction'], runs: 11 },
    { cases: ['defect-reversed-subtraction'], runs: 1_000_000_000 }
  ]) {
    await assert.rejects(
      scoreEvalArtifact({ ...artifact, config, runs: [] }, corpus),
      /case\/run configuration|nonempty, unique, bounded/
    );
  }
});

test('live eval requires explicit pinned budgets and makes one injected call with no retry or fallback', async () => {
    assert.throws(() => parseLiveEvalArgs(['live']), /--live acknowledgement/);
    for (const provider of ['claude', 'grok', 'ollama', 'opencode']) {
      assert.equal(parseLiveEvalArgs([
        'live', '--live', '--provider', provider, '--model', 'provider/model', '--effort', 'high',
        '--cases', 'grounded-defect', '--runs', '1', '--timeout-seconds', '1', '--max-calls', '1',
        '--max-prompt-bytes', '4096', '--max-total-seconds', '1', '--confidence', '0.75',
        '--output', path.join(process.cwd(), `${provider}-not-created.json`)
      ]).provider, provider);
    }
  assert.throws(() => parseLiveEvalArgs([
    'live', '--live', '--provider', 'ollama', '--model', 'glm-5.2:cloud', '--effort', 'xhigh',
    '--cases', 'grounded-defect', '--runs', '1', '--timeout-seconds', '1', '--max-calls', '1',
    '--max-prompt-bytes', '4096', '--max-total-seconds', '1', '--confidence', '0.75',
    '--output', path.join(process.cwd(), 'invalid-effort-not-created.json')
  ]), /ollama review effort must be one of/);
  const root = await temporaryDirectory('codex-buddy-live-eval-');
  const output = path.join(root, 'result.json');
  let calls = 0;
  const args = [
    'live', '--live', '--provider', 'ollama', '--model', 'glm-5.2:cloud', '--effort', 'high',
    '--cases', 'defect-reversed-subtraction,privacy-sensitive-aggregate', '--runs', '1',
    '--timeout-seconds', '10', '--max-calls', '1', '--max-prompt-bytes', '65536',
    '--max-total-seconds', '10', '--confidence', '0.75', '--output', output
  ];
  const result = await runLiveEval(args, {
    root,
    reviewWithOllama: async ({ model }) => {
      calls += 1;
      return { provider: 'ollama', model, stdout: JSON.stringify(defectResult()), stderr: '' };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.artifact.config.fallback, false);
  assert.equal(result.artifact.config.retry, false);
  assert.equal(result.artifact.runs.length, 2);
  assert.equal(result.artifact.runs.find((item) => item.case_id === 'privacy-sensitive-aggregate').provider_called, false);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result.artifact);
  await assert.rejects(runLiveEval(args, { root, reviewWithOllama: async () => { throw new Error('must not overwrite'); } }), /EEXIST/);
  assert.equal(calls, 1);
});

test('live eval preflights every egress prompt before output creation or provider spend', async () => {
  const root = await temporaryDirectory('codex-buddy-live-eval-preflight-');
  const output = path.join(root, 'result.json');
  let providerCalls = 0;
  await assert.rejects(runLiveEval([
    'live', '--live', '--provider', 'ollama', '--model', 'glm-5.2:cloud', '--effort', 'high',
    '--cases', 'defect-reversed-subtraction,clean-extract-local', '--runs', '1',
    '--timeout-seconds', '10', '--max-calls', '2', '--max-prompt-bytes', '4096',
    '--max-total-seconds', '10', '--confidence', '0.75', '--output', output
  ], {
    root,
    monotonicNow: () => 0,
    buildReviewPrompt: (evidence) => evidence.review_id === 'eval-clean-extract-local'
      ? 'x'.repeat(4_097)
      : 'bounded technical evidence',
    reviewWithOllama: async () => {
      providerCalls += 1;
      throw new Error('provider must not run before every prompt passes preflight');
    }
  }), /clean-extract-local prompt exceeds the explicit 4096-byte budget/);
  assert.equal(providerCalls, 0);
  await assert.rejects(access(output));
});

test('live eval approves the exact production request before provider dispatch', async () => {
  const root = await temporaryDirectory('codex-buddy-live-eval-approved-');
  const output = path.join(root, 'result.json');
  let dispatchCalls = 0;
  const args = [
    'live', '--live', '--provider', 'grok', '--model', 'grok-4.5', '--effort', 'high',
    '--cases', 'defect-reversed-subtraction', '--runs', '1',
    '--timeout-seconds', '10', '--max-calls', '1', '--max-prompt-bytes', '65536',
    '--max-total-seconds', '10', '--confidence', '0.75', '--output', output
  ];
  const result = await runLiveEval(args, {
    root,
    monotonicNow: () => 0,
    dispatchProviderReview: async (handle, options) => {
      dispatchCalls += 1;
      const approval = inspectApprovedProviderReviewRequest(handle);
      assert.equal(approval.purpose, 'technical_review');
      assert.equal(approval.rootSha256, sha256(root));
      assert.equal(approval.provider, 'grok');
      assert.equal(approval.model, 'grok-4.5');
      assert.equal(approval.effort, 'high');
      assert.equal(approval.timeoutMs, 10_000);
      assert.equal(approval.responseSchemaSha256, sha256(canonicalJson(REVIEW_RESULT_SCHEMA)));
      assert.deepEqual(approval.channelInventory, ['technical_evidence']);
      assert.equal(approval.summaryConsentRevision, null);
      assert.equal(approval.summaryReviewKey, null);
      assert.equal(approval.summarySha256, null);
      assert.equal(approval.summaryPacketSha256, null);
      assert.deepEqual(options, { platform: 'linux' });
      return {
        provider: 'grok',
        model: 'grok-4.5',
        stdout: JSON.stringify(defectResult()),
        stderr: ''
      };
    }
  });
  assert.equal(dispatchCalls, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.artifact.runs[0].outcome, 'completed');

  const rejectedOutput = path.join(root, 'approval-rejected.json');
  const rejected = await runLiveEval([...args.slice(0, -1), rejectedOutput], {
    root,
    monotonicNow: () => 0,
    approveProviderReviewRequest: () => {
      throw new Error('approval rejected before provider dispatch');
    },
    dispatchProviderReview: async () => {
      assert.fail('dispatch must not run after approval rejection');
    }
  });
  assert.equal(rejected.failed, 1);
  assert.equal(rejected.artifact.runs[0].provider_called, false);
});

test('live eval blocks Windows provider contact before creating an output artifact', async () => {
  const root = await temporaryDirectory('codex-buddy-live-eval-windows-');
  const output = path.join(root, 'result.json');
  let calls = 0;
  await assert.rejects(runLiveEvalImpl([
    'live', '--live', '--provider', 'ollama', '--model', 'glm-5.2:cloud', '--effort', 'high',
    '--cases', 'defect-reversed-subtraction', '--runs', '1',
    '--timeout-seconds', '10', '--max-calls', '1', '--max-prompt-bytes', '65536',
    '--max-total-seconds', '10', '--confidence', '0.75', '--output', output
  ], {
    root,
    platform: 'win32',
    reviewWithOllama: async () => {
      calls += 1;
      throw new Error('Windows privacy gate must run first');
    }
  }), /Live reviewer contact is disabled on Windows/);
  assert.equal(calls, 0);
  await assert.rejects(access(output));
});

test('live eval enforces one monotonic aggregate deadline and passes only the remaining budget', async () => {
  const root = await temporaryDirectory('codex-buddy-live-eval-deadline-');
  const output = path.join(root, 'result.json');
  let nowMs = 0;
  let calls = 0;
  const result = await runLiveEval([
    'live', '--live', '--provider', 'ollama', '--model', 'glm-5.2:cloud', '--effort', 'high',
    '--cases', 'defect-reversed-subtraction', '--runs', '2',
    '--timeout-seconds', '10', '--max-calls', '2', '--max-prompt-bytes', '65536',
    '--max-total-seconds', '2', '--confidence', '0.75', '--output', output
  ], {
    root,
    monotonicNow: () => {
      const sample = nowMs;
      if (nowMs === 0) nowMs = 600;
      return sample;
    },
    reviewWithOllama: async ({ model, timeoutMs }) => {
      calls += 1;
      assert.equal(timeoutMs, 1_400);
      nowMs = 2_001;
      return { provider: 'ollama', model, stdout: JSON.stringify(defectResult()), stderr: '' };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.artifact.runs[0].outcome, 'completed');
  assert.equal(result.artifact.runs[1].outcome, 'failed');
  assert.equal(result.artifact.runs[1].provider_called, false);
});

test('operator CLI diagnostics escape literal terminal controls and remain one line', async () => {
  const malicious = '--bad\u001b\nforged';
  for (const script of [
    'scripts/buddy-eval.mjs',
    'scripts/buddy-live-eval.mjs',
    'scripts/verify-host-e2e.mjs',
    'scripts/validate-pet-atlases.mjs'
  ]) {
    const result = await runScript(script, [malicious]);
    assert.equal(result.code, 2, script);
    assert.equal(result.signal, null, script);
    assert.match(result.stderr, /\\u\{001b\}/, script);
    assert.match(result.stderr, /\\n/, script);
    assert.doesNotMatch(result.stderr, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028-\u202E\u2066-\u2069]/u, script);
    assert.equal(result.stderr.trimEnd().split('\n').length, 1, script);
  }
});

test('host evidence v2 binds release, installation, pet, workspace, receipt, outbox, and completion', async () => {
  const fixture = await hostEvidenceFixture();
  const report = await collectHostEvidenceV2(fixture.collectOptions);
  const collected = validateHostE2eReport(report);
  assert.equal(collected.machine_complete, true, JSON.stringify(report.machine_checks, null, 2));
  assert.equal(collected.machine_passed, MACHINE_HOST_GATES.length);
  assert.equal(collected.complete, false);
  assert.deepEqual(collected.manual_host_pending, [...MANUAL_HOST_GATES]);
  assert.deepEqual(collected.manual_visual_pending, [...MANUAL_VISUAL_GATES]);
  assert.equal(report.installed_snapshot.snapshot_sha256, report.release.artifact_sha256);
  assert.equal(report.installed_snapshot.plugin_manifest_sha256, report.release.plugin_manifest_sha256);
  assert.equal(report.installed_snapshot.hooks_sha256, report.release.hooks_sha256);
  assert.equal(report.turn.review_key, 'b'.repeat(64));

  attestHostEvidence(report);
  const accepted = validateHostE2eReport(report);
  assert.equal(accepted.complete, true);
  assert.equal(accepted.manual_host_attested_passed, MANUAL_HOST_GATES.length);
  assert.equal(accepted.manual_visual_attested_passed, MANUAL_VISUAL_GATES.length);

  report.manual_host_gates.hook_trust_completed.status = 'pass';
  assert.throws(() => validateHostE2eReport(report), /manual_pass/);
});

test('host evidence v2 rejects v1 reports and machine-evidence edits', async () => {
  const fixture = await hostEvidenceFixture();
  const report = await collectHostEvidenceV2(fixture.collectOptions);
  report.schema_version = '1';
  assert.throws(() => validateHostE2eReport(report), /strict schema version 2/);

  report.schema_version = '2';
  report.host.node_version = 'v0.0.0-tampered';
  assert.throws(() => validateHostE2eReport(report), /machine digest/);
});

test('host evidence v2 records bounded machine failures without manufacturing acceptance', async () => {
  const snapshotFixture = await hostEvidenceFixture();
  await writeFile(
    path.join(snapshotFixture.installedSnapshotRoot, '.codex-plugin', 'plugin.json'),
    '{"name":"tampered"}\n'
  );
  const snapshotReport = await collectHostEvidenceV2(snapshotFixture.collectOptions);
  const snapshotResult = validateHostE2eReport(snapshotReport);
  assert.equal(snapshotReport.machine_checks.installed_snapshot.status, 'fail');
  assert.equal(snapshotReport.machine_checks.installed_snapshot.failure_code, 'installed_snapshot_mismatch');
  assert.equal(snapshotResult.machine_complete, false);

  const outboxFixture = await hostEvidenceFixture();
  await rm(outboxFixture.outboxFile);
  const outboxReport = await collectHostEvidenceV2(outboxFixture.collectOptions);
  const outboxResult = validateHostE2eReport(outboxReport);
  assert.equal(outboxReport.machine_checks.review_completed_outbox.status, 'fail');
  assert.equal(
    outboxReport.machine_checks.review_completed_outbox.failure_code,
    'review_completed_outbox_cardinality',
    JSON.stringify(outboxReport.machine_checks, null, 2)
  );
  assert.equal(outboxResult.machine_complete, false);
});

async function completeReportsForFixture(fixture, petIds) {
  const reports = [];
  for (const petId of petIds) {
    const report = attestHostEvidence(await collectHostEvidenceV2({
      ...fixture.collectOptions,
      petId,
      taskReference: `private-host-task-${petId}`
    }));
    assert.equal(validateHostE2eReport(report).complete, true);
    reports.push(report);
  }
  return reports;
}

test('host evidence bundle accepts exactly one complete artifact-bound report for every public pet', async () => {
  const petIds = publicPetIds;
  const fixture = await hostEvidenceFixture({ petIds });
  const reports = await completeReportsForFixture(fixture, petIds);
  const bundle = { schema_version: '1', reports };
  const result = await validateHostEvidenceBundle(bundle, fixture.artifactRoot);
  assert.deepEqual(result, {
    schema_version: '1',
    complete: true,
    report_count: 5,
    public_pet_ids: petIds
  });
  const bundleFile = path.join(path.dirname(fixture.artifactRoot), 'bundle.json');
  await writeJson(bundleFile, bundle);
  const cli = await runScript('scripts/verify-host-e2e.mjs', [
    'validate-bundle', '--artifact', fixture.artifactRoot, '--bundle', bundleFile, '--json'
  ]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), result);
});

test('host evidence bundle rejects a missing public pet report', async () => {
  const petIds = publicPetIds;
  const fixture = await hostEvidenceFixture({ petIds });
  const reports = await completeReportsForFixture(fixture, petIds);
  await assert.rejects(
    validateHostEvidenceBundle({ schema_version: '1', reports: reports.slice(0, -1) }, fixture.artifactRoot),
    /missing reports for buddy-lupo/
  );
});

test('host evidence bundle rejects duplicate and unknown public pet reports', async () => {
  const petIds = publicPetIds;
  const fixture = await hostEvidenceFixture({ petIds });
  const reports = await completeReportsForFixture(fixture, petIds);
  await assert.rejects(
    validateHostEvidenceBundle({ schema_version: '1', reports: [...reports, reports[0]] }, fixture.artifactRoot),
    /duplicate report for buddy-byte/
  );

  const unknown = structuredClone(reports);
  unknown[0].pet.id = 'buddy-private-fixture';
  await assert.rejects(
    validateHostEvidenceBundle({ schema_version: '1', reports: unknown }, fixture.artifactRoot),
    /unknown public pet id buddy-private-fixture/
  );
});

test('host evidence bundle rejects individually valid evidence from a different artifact', async () => {
  const expected = await hostEvidenceFixture({ sourceCommit: 'a'.repeat(40) });
  const other = await hostEvidenceFixture({ sourceCommit: 'f'.repeat(40) });
  const reports = await completeReportsForFixture(other, ['buddy-byte']);
  await assert.rejects(
    validateHostEvidenceBundle({ schema_version: '1', reports }, expected.artifactRoot),
    /not bound to this exact public artifact/
  );
});

test('host evidence bundle requires every report to be complete and fully attested', async () => {
  const petIds = publicPetIds;
  const fixture = await hostEvidenceFixture({ petIds });
  const reports = await completeReportsForFixture(fixture, petIds);
  reports[1].manual_visual_gates.pet_running_during_review = {
    status: 'pending', observer: null, observed_at: null, notes: 'Pending human visual observation.'
  };
  await assert.rejects(
    validateHostEvidenceBundle({ schema_version: '1', reports }, fixture.artifactRoot),
    /report for buddy-mochi is not complete/
  );
});

test('host evidence bundle secret decoder enforces canonical base64 and one bounded gzip member', async () => {
  const payload = Buffer.from('{"schema_version":"1","reports":[]}\n');
  const compressed = gzipSync(payload, { level: 9 });
  const encoded = compressed.toString('base64');
  assert.deepEqual(decodeHostEvidenceBundleSecret(encoded), payload);

  assert.throws(
    () => decodeHostEvidenceBundleSecret('A'.repeat((48 * 1024) + 4)),
    /exceeds the 48 KiB base64 limit/
  );
  assert.throws(() => decodeHostEvidenceBundleSecret(`${encoded}\n`), /canonical single-line base64/);
  assert.throws(
    () => decodeHostEvidenceBundleSecret(Buffer.from('not a gzip stream').toString('base64')),
    /must contain one gzip stream/
  );
  assert.throws(
    () => decodeHostEvidenceBundleSecret(Buffer.concat([compressed, Buffer.from([0])]).toString('base64')),
    /trailing data or multiple members/
  );
  assert.throws(
    () => decodeHostEvidenceBundleSecret(Buffer.concat([compressed, compressed]).toString('base64')),
    /trailing data or multiple members/
  );
  const corruptTrailer = Buffer.from(compressed);
  corruptTrailer[corruptTrailer.length - 8] ^= 1;
  assert.throws(
    () => decodeHostEvidenceBundleSecret(corruptTrailer.toString('base64')),
    /gzip trailer is invalid/
  );
  assert.throws(
    () => decodeHostEvidenceBundleSecret(
      gzipSync(Buffer.alloc((128 * 1024) + 1, 0x61), { level: 9 }).toString('base64')
    ),
    /exceeds 128 KiB/
  );

  const output = path.join(await temporaryDirectory('codex-buddy-host-secret-'), 'bundle.json');
  const cli = await runScript(
    'scripts/verify-host-e2e.mjs',
    ['decode-bundle-secret', '--output', output],
    { input: encoded }
  );
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(await readFile(output), payload);
  const overwrite = await runScript(
    'scripts/verify-host-e2e.mjs',
    ['decode-bundle-secret', '--output', output],
    { input: encoded }
  );
  assert.equal(overwrite.code, 2);
  assert.match(overwrite.stderr, /EEXIST/);
});

test('host evidence v2 CLI exposes collection, validation, bundle validation, and secret decoding', () => {
  assert.deepEqual(parseHostE2eArgs(['validate', '--report', 'report.json', '--json']), {
    action: 'validate',
    json: true,
    report: path.resolve('report.json')
  });
  assert.deepEqual(parseHostE2eArgs([
    'validate-bundle', '--bundle', 'bundle.json', '--artifact', 'artifact', '--json'
  ]), {
    action: 'validate-bundle',
    json: true,
    bundle: path.resolve('bundle.json'),
    artifactRoot: path.resolve('artifact')
  });
  assert.deepEqual(parseHostE2eArgs([
    'decode-bundle-secret', '--output', 'bundle.json'
  ]), {
    action: 'decode-bundle-secret',
    json: false,
    output: path.resolve('bundle.json')
  });
  assert.throws(
    () => parseHostE2eArgs(['template', '--output', 'report.json']),
    /collect, validate, validate-bundle, or decode-bundle-secret/
  );
  assert.throws(() => parseHostE2eArgs(['collect', '--artifact', 'artifact']), /requires installedSnapshotRoot/);
});

test('atlas structural gate validates checked-in RIFF boundaries without claiming a full pixel decode', async () => {
  const result = await validatePetAtlases();
  assert.equal(result.pet_count, 5);
  assert.equal(result.full_pixel_decode, false);
  assert.ok(result.pets.every((pet) => pet.width === 1536 && pet.height === 2288 && pet.image_encoding === 'VP8L'));
  const bytes = await readFile('assets/pets/buddy-byte/spritesheet.webp');
  const corrupt = Buffer.concat([bytes, Buffer.from([0])]);
  assert.throws(() => inspectWebpStructure(corrupt), /RIFF length/);
});

function webpChunk(type, payload, options = {}) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  const padding = payload.length % 2 && options.omitPadding !== true ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([header, payload, padding]);
}

function webpContainer(chunks, trailing = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks, trailing]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function vp8lPayload({ width = 1, height = 1, signature = 0x2f } = {}) {
  const payload = Buffer.alloc(5);
  payload[0] = signature;
  payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return payload;
}

function vp8xPayload({ width = 1, height = 1, animated = false } = {}) {
  const payload = Buffer.alloc(10);
  if (animated) payload[0] |= 0x02;
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return payload;
}

test('atlas parser rejects ambiguous, animated, inconsistent, and truncated WebP containers', () => {
  const image = webpChunk('VP8L', vp8lPayload());
  const cases = [
    [webpContainer([image, image]), /one image bitstream/],
    [webpContainer([webpChunk('ANIM', Buffer.alloc(6)), image]), /animated WebP containers/],
    [webpContainer([webpChunk('VP8X', vp8xPayload({ animated: true })), image]), /animated VP8X/],
    [webpContainer([webpChunk('VP8X', vp8xPayload({ width: 2 })), image]), /dimensions disagree/],
    [webpContainer([], Buffer.alloc(9)), /truncated WebP chunk header/],
    [webpContainer([webpChunk('VP8L', vp8lPayload(), { omitPadding: true })]), /exceeds the RIFF boundary/],
    [webpContainer([webpChunk('VP8L', vp8lPayload({ signature: 0 }))]), /invalid signature/]
  ];
  for (const [fixture, expected] of cases) {
    assert.throws(() => inspectWebpStructure(fixture), expected);
  }
});
