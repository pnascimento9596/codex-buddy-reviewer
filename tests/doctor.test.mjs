import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { explicitProviderCheck, parseDoctorArgs } from '../src/doctor-cli.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { modeFile } from '../src/mode.mjs';
import { beginPetTransaction, recordPetTransactionStep } from '../src/pet-transactions.mjs';
import {
  approveProviderReviewRequest,
  inspectApprovedProviderReviewRequest
} from '../src/provider-registry.mjs';
import { workspaceKey } from '../src/state.mjs';
import { summaryClaimGuardConsentFile } from '../src/summary-claim-guard.mjs';

const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);
const temporaryPaths = [];

test('doctor CLI keeps provider use explicit and bounds its deadline', () => {
  assert.equal(parseDoctorArgs([]).includeProviderCheck, false);
  assert.equal(parseDoctorArgs(['--provider-check', '--timeout-seconds', '120']).includeProviderCheck, true);
  assert.equal(parseDoctorArgs(['--provider-check', '--timeout-seconds', '120']).timeoutMs, 120_000);
  assert.throws(() => parseDoctorArgs(['--timeout-seconds', '121']), /between 1 and 120/);
  assert.throws(() => parseDoctorArgs(['--timeout-seconds', '30']), /requires --provider-check/);
  assert.throws(() => parseDoctorArgs(['--provider']), /unknown doctor argument/);
});

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function homeKey(codexHome) {
  return createHash('sha256').update(Buffer.from(path.resolve(codexHome))).digest('hex').slice(0, 32);
}

function check(result, id) {
  return result.checks.find((item) => item.id === id);
}

function validIssuedEgressRecord(root, overrides = {}) {
  const issuedAtMs = Date.now() - 1_000;
  return {
    capability_id: 'a'.repeat(64),
    token_sha256: 'b'.repeat(64),
    workspace_key: workspaceKey(root),
    session_key: 'c'.repeat(24),
    turn_key: 'd'.repeat(24),
    review_key: 'e'.repeat(64),
    mode_revision: 1,
    provider: 'ollama',
    model: 'fixture-model',
    effort: 'high',
    timeout_ms: 30_000,
    configuration_sha256: 'f'.repeat(64),
    approval_sha256: '0'.repeat(64),
    content_policy_version: '1',
    channel_inventory_sha256: '4'.repeat(64),
    prompt_sha256: '1'.repeat(64),
    prompt_bytes: 128,
    response_schema_sha256: '2'.repeat(64),
    summary_consent_revision: null,
    summary_sha256: null,
    summary_packet_sha256: null,
    owner_pid: process.pid,
    owner_nonce: '3'.repeat(32),
    issued_at: new Date(issuedAtMs).toISOString(),
    spend_deadline_at: new Date(issuedAtMs + 30_000).toISOString(),
    deadline_at: null,
    state: 'issued',
    consumed_at: null,
    ...overrides
  };
}

function modeFixture(root, overrides = {}) {
  return {
    schema_version: '1',
    policy_version: '2',
    workspace_root: root,
    config_revision: 1,
    enabled: false,
    scope: 'workspace',
    provider: 'ollama',
    model: 'glm-5.2:cloud',
    effort: 'high',
    secondary_provider: null,
    secondary_model: null,
    secondary_effort: null,
    min_confidence: 0.75,
    max_patch_bytes: 256 * 1024,
    timeout_ms: 60_000,
    consented_at: null,
    updated_at: null,
    ...overrides
  };
}

async function writeModeFixture(root, dataDir, enabled, overrides = {}) {
  const file = modeFile(root, dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(modeFixture(root, { enabled, ...overrides })));
}

test('default doctor is read-only, does not call a provider, and leaves manual host states unknown', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-');
  const workspace = path.join(root, 'workspace');
  const codexHome = path.join(root, 'missing-codex-home');
  const dataDir = path.join(root, 'missing-state');
  let providerCalls = 0;
  const result = await runDoctor({
    root: workspace,
    resolveRoot: async (value) => value,
    codexHome,
    dataDir,
    pluginRoot: repositoryRoot,
    providerCheck: async () => {
      providerCalls += 1;
      return { status: 'pass', summary: 'must not run' };
    }
  });
  assert.equal(providerCalls, 0);
  await assert.rejects(access(codexHome));
  await assert.rejects(access(dataDir));
  assert.equal(check(result, 'provider').status, 'unknown');
  assert.equal(check(result, 'host_hook_trust').status, 'unknown');
  assert.equal(check(result, 'host_command_discovery').status, 'unknown');
  assert.equal(check(result, 'host_pet_selection_wake').status, 'unknown');
  assert.equal(check(result, 'mode_state').status, 'warn');
  assert.equal(check(result, 'egress_registry').status, 'pass');
  assert.equal(check(result, 'egress_registry').active_count, 0);
  assert.equal(new Set(result.checks.map((item) => item.id)).size, result.checks.length);
});

test('POSIX process containment diagnostic reports lifecycle cleanup without claiming an OS sandbox', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-posix-');
  let resolverCalls = 0;
  const result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir: path.join(root, 'state'),
    pluginRoot: repositoryRoot,
    platform: 'linux',
    resolveWindowsHelper: async () => {
      resolverCalls += 1;
      throw new Error('must not resolve a Windows helper on POSIX');
    }
  });
  assert.equal(resolverCalls, 0);
  assert.equal(check(result, 'process_containment').status, 'pass');
  assert.match(check(result, 'process_containment').summary, /POSIX process-group cleanup/);
  assert.match(check(result, 'process_containment').detail, /not an OS sandbox/);
});

test('Windows process containment diagnostic uses CI helper overrides but labels metadata-only proof', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-windows-verified-');
  const manifestFile = path.join(root, 'runtime-helpers.json');
  const helperRoot = path.join(root, 'helper-root');
  let resolverArguments = null;
  const result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir: path.join(root, 'state'),
    pluginRoot: repositoryRoot,
    platform: 'win32',
    arch: 'x64',
    env: {
      CODEX_BUDDY_WINDOWS_HELPER_MANIFEST: manifestFile,
      CODEX_BUDDY_WINDOWS_HELPER_ROOT: helperRoot
    },
    resolveWindowsHelper: async (options) => {
      resolverArguments = options;
      return {
        path: path.join(helperRoot, 'job-supervisor.exe'),
        arch: 'x64',
        sha256: 'a'.repeat(64),
        protocolVersion: '1'
      };
    }
  });
  assert.deepEqual(resolverArguments, {
    platform: 'win32',
    arch: 'x64',
    manifestFile,
    helperRoot
  });
  assert.equal(check(result, 'process_containment').status, 'pass');
  assert.match(check(result, 'process_containment').summary, /metadata passed hash and architecture verification/);
  assert.match(check(result, 'process_containment').detail, /did not execute the helper/);
  assert.match(check(result, 'process_containment').detail, /not an OS sandbox/);
  assert.equal(check(result, 'provider_egress_privacy').status, 'warn');
  assert.equal(check(result, 'provider_egress_privacy').failure_code, 'windows_private_state_acl_unavailable');
  assert.match(check(result, 'provider_egress_privacy').detail, /current-user-only DACLs/);
});

test('Windows process containment fails for an enabled mode and warns for a disabled mode when unverified', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-windows-unavailable-');
  const canonicalRoot = await realpath(root);
  const disabledDataDir = path.join(root, 'disabled-state');
  const enabledDataDir = path.join(root, 'enabled-state');
  const unavailable = async () => {
    throw new Error('fixture helper is unavailable');
  };

  const disabled = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir: disabledDataDir,
    pluginRoot: repositoryRoot,
    platform: 'win32',
    arch: 'x64',
    env: {},
    resolveWindowsHelper: unavailable
  });
  assert.equal(check(disabled, 'mode_state').status, 'warn');
  assert.equal(check(disabled, 'process_containment').status, 'warn');
  assert.equal(check(disabled, 'provider_egress_privacy').status, 'warn');
  assert.equal(check(disabled, 'process_containment').mode_enabled, false);
  assert.match(check(disabled, 'process_containment').summary, /fail closed/);

  await writeModeFixture(canonicalRoot, enabledDataDir, true);
  const enabled = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir: enabledDataDir,
    pluginRoot: repositoryRoot,
    platform: 'win32',
    arch: 'x64',
    env: {},
    resolveWindowsHelper: unavailable
  });
  assert.equal(check(enabled, 'mode_state').status, 'pass');
  assert.equal(check(enabled, 'process_containment').status, 'fail');
  assert.equal(check(enabled, 'provider_egress_privacy').status, 'fail');
  assert.equal(check(enabled, 'process_containment').mode_enabled, true);
  assert.match(check(enabled, 'process_containment').detail, /fixture helper is unavailable/);
});

test('doctor surfaces unresolved active egress records through a bounded read-only snapshot', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-egress-active-');
  const canonicalRoot = await realpath(root);
  const dataDir = path.join(root, 'state');
  const registryFile = path.join(dataDir, 'egress', workspaceKey(canonicalRoot), 'active.json');
  const record = validIssuedEgressRecord(canonicalRoot);
  await mkdir(path.dirname(registryFile), { recursive: true });
  await writeFile(registryFile, JSON.stringify({
    schema_version: '2',
    workspace_key: workspaceKey(canonicalRoot),
    active: [record]
  }));

  const before = await readFile(registryFile, 'utf8');
  const result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir,
    pluginRoot: repositoryRoot,
    platform: 'linux'
  });
  const after = await readFile(registryFile, 'utf8');
  assert.equal(after, before);
  assert.deepEqual(await readdir(path.dirname(registryFile)), ['active.json']);
  assert.equal(check(result, 'egress_registry').status, 'warn');
  assert.equal(check(result, 'egress_registry').active_count, 1);
  assert.equal(check(result, 'egress_registry').issued_count, 1);
  assert.equal(check(result, 'egress_registry').consumed_count, 0);
  assert.match(check(result, 'egress_registry').summary, /1 unresolved egress capability record/);
});

test('doctor accepts egress records for every supported adapter', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-egress-providers-');
  const canonicalRoot = await realpath(root);
  const dataDir = path.join(root, 'state');
  const registryFile = path.join(dataDir, 'egress', workspaceKey(canonicalRoot), 'active.json');
  const providers = ['claude', 'grok', 'ollama', 'opencode'];
  const records = providers.map((provider, index) => validIssuedEgressRecord(canonicalRoot, {
    capability_id: String(index + 1).repeat(64),
    token_sha256: String(index + 5).repeat(64),
    provider,
    model: `${provider}-fixture-model`
  }));
  await mkdir(path.dirname(registryFile), { recursive: true });
  await writeFile(registryFile, JSON.stringify({
    schema_version: '2',
    workspace_key: workspaceKey(canonicalRoot),
    active: records
  }));
  const result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir,
    pluginRoot: repositoryRoot,
    platform: 'linux'
  });
  assert.equal(check(result, 'egress_registry').status, 'warn');
  assert.equal(check(result, 'egress_registry').active_count, 4);
  assert.equal(check(result, 'egress_registry').issued_count, 4);
});

test('doctor rejects a symlinked egress registry instead of following it', {
  skip: process.platform === 'win32' ? 'symlink creation is not reliably available on Windows CI' : false
}, async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-egress-symlink-');
  const canonicalRoot = await realpath(root);
  const dataDir = path.join(root, 'state');
  const registryFile = path.join(dataDir, 'egress', workspaceKey(canonicalRoot), 'active.json');
  const target = path.join(root, 'outside-registry.json');
  await mkdir(path.dirname(registryFile), { recursive: true });
  await writeFile(target, JSON.stringify({
    schema_version: '1',
    workspace_key: workspaceKey(canonicalRoot),
    active: []
  }));
  await symlink(target, registryFile);

  const result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir,
    pluginRoot: repositoryRoot,
    platform: 'linux'
  });
  assert.equal(check(result, 'egress_registry').status, 'fail');
  assert.match(check(result, 'egress_registry').detail, /regular non-symlink file/);
});

test('doctor enumerates the four supported adapters and both configured reviewer connections offline', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-connections-');
  const canonicalRoot = await realpath(root);
  const dataDir = path.join(root, 'state');
  await writeModeFixture(canonicalRoot, dataDir, true, {
    provider: 'claude',
    model: 'claude-opus-4-8',
    secondary_provider: 'opencode',
    secondary_model: 'openai/gpt-5.6',
    secondary_effort: 'high'
  });
  const result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir,
    pluginRoot: repositoryRoot,
    platform: 'linux'
  });
  const state = check(result, 'mode_state');
  assert.equal(state.status, 'pass');
  assert.equal(state.configured_reviewer_count, 2);
  assert.deepEqual(state.supported_providers, ['claude', 'grok', 'ollama', 'opencode']);
  assert.deepEqual(state.configured_reviewers, [
    { role: 'primary', provider: 'claude', model: 'claude-opus-4-8', effort: 'high' },
    { role: 'secondary', provider: 'opencode', model: 'openai/gpt-5.6', effort: 'high' }
  ]);
  assert.equal(check(result, 'provider').status, 'unknown');
});

test('doctor rejects credential-shaped stored model identifiers without echoing them', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-model-guard-');
  const canonicalRoot = await realpath(root);
  const dataDir = path.join(root, 'state');
  const model = ['xai-', 'A9_bC7-dE5_fG3-hJ1_kL8'].join('');
  await writeModeFixture(canonicalRoot, dataDir, true, { provider: 'grok', model });
  const result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir,
    pluginRoot: repositoryRoot,
    platform: 'linux'
  });
  assert.equal(check(result, 'mode_state').status, 'fail');
  assert.match(check(result, 'mode_state').detail, /Invalid Buddy mode model/);
  assert.equal(JSON.stringify(result).includes(model), false);
});

test('doctor rejects credential-shaped automatic receipt models without echoing them', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-receipt-model-');
  const canonicalRoot = await realpath(root);
  const dataDir = path.join(root, 'state');
  const runtimeDataDir = path.join(root, 'runtime');
  const model = ['sk', '-ant', '-api', '03-', 'A9_bC7', '-dE5_fG', '3-hJ1_k', 'L8mN6pQ'].join('');
  const receiptDirectory = path.join(runtimeDataDir, 'automatic-reviews', workspaceKey(canonicalRoot));
  await mkdir(receiptDirectory, { recursive: true });
  await writeFile(path.join(receiptDirectory, 'fixture.json'), JSON.stringify({
    schema_version: '1',
    terminal_status: 'no_findings',
    provider: 'claude',
    model,
    result: { schema_version: '1', status: 'no_findings', summary: 'Fixture.', findings: [], comments: [] },
    created_at: new Date().toISOString()
  }));
  const result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir,
    runtimeDataDir,
    pluginRoot: repositoryRoot,
    platform: 'linux'
  });
  assert.equal(check(result, 'receipt_state').status, 'fail');
  assert.match(check(result, 'receipt_state').detail, /invalid model identifier/);
  assert.equal(JSON.stringify(result).includes(model), false);
});

test('doctor reports summary advisory consent as primary-only in a dual reviewer configuration', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-summary-primary-');
  const canonicalRoot = await realpath(root);
  const dataDir = path.join(root, 'state');
  await writeModeFixture(canonicalRoot, dataDir, true, {
    provider: 'claude',
    model: 'claude-opus-4-8',
    secondary_provider: 'grok',
    secondary_model: 'grok-4.5',
    secondary_effort: 'high'
  });
  const consentFile = summaryClaimGuardConsentFile(canonicalRoot, dataDir);
  await mkdir(path.dirname(consentFile), { recursive: true });
  await writeFile(consentFile, JSON.stringify({
    schema_version: '1',
    policy_version: '1',
    scope: 'worker_summary_claim_advisory',
    enabled: true,
    provider: 'claude',
    model: 'claude-opus-4-8',
    consented_at: new Date().toISOString(),
    configuration_revision: 1
  }));
  const result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir,
    pluginRoot: repositoryRoot,
    platform: 'linux'
  });
  const summary = check(result, 'summary_claim_guard');
  assert.equal(summary.status, 'pass');
  assert.equal(summary.primary_reviewer_only, true);
  assert.equal(summary.secondary_summary_egress, false);
  assert.match(summary.summary, /primary reviewer claude\/claude-opus-4-8/);
  assert.match(summary.summary, /secondary reviewer receives technical evidence only/);
});

test('explicit provider health dispatch supports every registered adapter without repository evidence', async () => {
  const root = '/fixture/workspace';
  const providers = [
    ['claude', 'claude-opus-4-8'],
    ['grok', 'grok-4.5'],
    ['ollama', 'glm-5.2:cloud'],
    ['opencode', 'openai/gpt-5.6']
  ];
  for (const [provider, model] of providers) {
    const calls = [];
    const result = await explicitProviderCheck({
      root,
      mode: modeFixture(root, { provider, model })
    }, { timeoutMs: 5_000 }, {
      platform: 'linux',
      approveProviderReviewRequest: (actualProvider, options, approval) => {
        calls.push({ provider: actualProvider, options, approval });
        return approveProviderReviewRequest(actualProvider, options, approval);
      },
      dispatchProviderReview: async (approvedRequest) => {
        const metadata = inspectApprovedProviderReviewRequest(approvedRequest);
        return { provider: metadata.provider, model, reviewPayload: { status: 'ok' } };
      }
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.summary, '1/1 configured reviewer health checks passed.');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, provider);
    assert.equal(calls[0].options.root, root);
    assert.equal(calls[0].options.model, model);
    assert.equal(calls[0].options.timeoutMs, 5_000);
    assert.deepEqual(calls[0].options.responseSchema.required, ['status']);
    assert.deepEqual(Object.keys(calls[0].options.responseSchema.properties), ['status']);
    assert.doesNotMatch(calls[0].options.prompt, /fixture\/workspace/);
    assert.equal(calls[0].approval.purpose, 'health_check');
  }
});

test('Windows provider health check reports the privacy blocker without approving or dispatching', async () => {
  const root = '/fixture/workspace';
  let approvalCalls = 0;
  let dispatchCalls = 0;
  const result = await explicitProviderCheck({
    root,
    mode: modeFixture(root, { provider: 'claude', model: 'claude-opus-4-8' })
  }, { timeoutMs: 5_000 }, {
    platform: 'win32',
    approveProviderReviewRequest: () => {
      approvalCalls += 1;
      throw new Error('Windows privacy gate must run first');
    },
    dispatchProviderReview: async () => {
      dispatchCalls += 1;
      throw new Error('Windows privacy gate must run first');
    }
  });
  assert.equal(approvalCalls, 0);
  assert.equal(dispatchCalls, 0);
  assert.equal(result.status, 'fail');
  assert.equal(result.configured_count, 1);
  assert.equal(result.passed_count, 0);
  assert.match(result.summary, /disabled on Windows/);
  assert.match(result.detail, /current-user-only DACLs/);
  assert.equal(result.reviewer_checks[0].failure_code, 'windows_private_state_acl_unavailable');
});

test('dual provider health reports exact all, partial, and zero success without fallback', async () => {
  const root = '/fixture/workspace';
  const mode = modeFixture(root, {
    provider: 'claude',
    model: 'claude-opus-4-8',
    secondary_provider: 'grok',
    secondary_model: 'grok-4.5',
    secondary_effort: 'high'
  });
  const cases = [
    { passing: new Set(['claude', 'grok']), status: 'pass', count: 2 },
    { passing: new Set(['claude']), status: 'warn', count: 1 },
    { passing: new Set(), status: 'fail', count: 0 }
  ];
  for (const fixture of cases) {
    const calls = [];
    const result = await explicitProviderCheck({ root, mode }, { timeoutMs: 5_000 }, {
      platform: 'linux',
      dispatchProviderReview: async (approvedRequest) => {
        const { provider } = inspectApprovedProviderReviewRequest(approvedRequest);
        calls.push(provider);
        if (!fixture.passing.has(provider)) {
          const error = new Error('secret provider stderr must not be reported');
          error.failureCode = 'transport_exit';
          throw error;
        }
        return { provider, reviewPayload: { status: 'ok' } };
      }
    });
    assert.deepEqual(calls.sort(), ['claude', 'grok']);
    assert.equal(result.status, fixture.status);
    assert.equal(result.configured_count, 2);
    assert.equal(result.passed_count, fixture.count);
    assert.match(result.summary, new RegExp(`^${fixture.count}/2 configured reviewer health checks passed`));
    assert.equal(result.reviewer_checks.length, 2);
    assert.equal(JSON.stringify(result).includes('secret provider stderr'), false);
    for (const item of result.reviewer_checks.filter((entry) => entry.status === 'fail')) {
      assert.equal(item.failure_code, 'transport_exit');
    }
  }
});

test('explicit provider health exposes only allowlisted bounded failure codes', async () => {
  const root = '/fixture/workspace';
  const result = await explicitProviderCheck({
    root,
    mode: modeFixture(root, { provider: 'claude', model: 'claude-opus-4-8' })
  }, { timeoutMs: 5_000 }, {
    platform: 'linux',
    dispatchProviderReview: async () => {
      const error = new Error('provider error contains credential material');
      error.failureCode = 'api_key_secret_value';
      throw error;
    }
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.reviewer_checks[0].failure_code, 'health_check_failed');
  assert.equal(JSON.stringify(result).includes('credential material'), false);
  assert.equal(JSON.stringify(result).includes('api_key_secret_value'), false);
});

test('explicit provider health fails closed on an unsupported reviewer without making a call', async () => {
  let calls = 0;
  const root = '/fixture/workspace';
  const result = await explicitProviderCheck({
    root,
    mode: modeFixture(root, { provider: 'kimi', model: 'kimi-for-coding' })
  }, { timeoutMs: 5_000 }, {
    dispatchProviderReview: async () => {
      calls += 1;
      return { reviewPayload: { status: 'ok' } };
    }
  });
  assert.equal(calls, 0);
  assert.equal(result.status, 'fail');
  assert.equal(result.configured_count, 0);
  assert.match(result.summary, /invalid or unsupported/);
});

test('provider execution occurs only through an explicitly enabled provider-check hook', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-provider-');
  let calls = 0;
  const result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir: path.join(root, 'state'),
    pluginRoot: repositoryRoot,
    includeProviderCheck: true,
    providerCheck: async ({ mode }) => {
      calls += 1;
      assert.equal(mode.enabled, false);
      return { status: 'pass', summary: 'Explicit fixture provider check passed.' };
    }
  });
  assert.equal(calls, 1);
  assert.equal(check(result, 'provider').status, 'pass');
  assert.match(check(result, 'provider').summary, /Explicit fixture/);
});

test('doctor inspects home-scoped pet transactions without reconciling or mutating them', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-transactions-');
  const codexHome = path.join(root, 'codex');
  const dataDir = path.join(root, 'state');
  await mkdir(codexHome, { recursive: true });
  const homeDataDir = path.join(dataDir, 'pets', 'homes', homeKey(await realpath(codexHome)));
  const transaction = await beginPetTransaction({
    homeDataDir,
    intent: { schema_version: '1', operation: 'install', pet_id: 'buddy-byte' }
  });
  let result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome,
    dataDir,
    pluginRoot: repositoryRoot
  });
  assert.equal(check(result, 'pet_transactions').status, 'warn');
  assert.equal(check(result, 'pet_transactions').pending_count, 1);
  assert.deepEqual(await recordPetTransactionStep(transaction, 'complete', {
    outcome: 'needs_attention', reason: 'fixture'
  }).then((record) => record.payload), { outcome: 'needs_attention', reason: 'fixture' });
  result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome,
    dataDir,
    pluginRoot: repositoryRoot
  });
  assert.equal(check(result, 'pet_transactions').status, 'fail');
  assert.equal(check(result, 'pet_transactions').needs_attention_count, 1);
});

test('doctor returns stable fail or unknown records when plugin source validation is unavailable', async () => {
  const root = await temporaryDirectory('codex-buddy-doctor-invalid-plugin-');
  const result = await runDoctor({
    root,
    resolveRoot: async (value) => value,
    codexHome: path.join(root, 'codex'),
    dataDir: path.join(root, 'state'),
    pluginRoot: path.join(root, 'missing-plugin')
  });
  assert.equal(check(result, 'plugin_manifest').status, 'fail');
  assert.equal(check(result, 'hook_definition').status, 'unknown');
  assert.equal(check(result, 'command_skill_source').status, 'unknown');
  assert.equal(result.overall, 'fail');
});
