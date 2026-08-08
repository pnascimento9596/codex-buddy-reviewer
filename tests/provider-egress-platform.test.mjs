import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WINDOWS_PROVIDER_EGRESS_GATE_LIFTED,
  evaluateProviderEgressPlatformPolicy,
  providerEgressPlatformPolicy
} from '../src/provider-egress-platform.mjs';

const ROOTS = Object.freeze([
  Object.freeze({
    class: 'durable_data', path: 'C:\\Buddy\\data',
    filesystem_acl_capable: true, ensured: true, verified: true
  }),
  Object.freeze({
    class: 'runtime_data', path: 'C:\\Buddy\\runtime',
    filesystem_acl_capable: true, ensured: true, verified: true
  }),
  Object.freeze({
    class: 'provider_temp_parent', path: 'C:\\Temp\\codex-buddy-provider-v1-user',
    filesystem_acl_capable: true, ensured: true, verified: true
  })
]);

function goodVerification(overrides = {}) {
  return Object.freeze({
    schema_version: '1',
    platform: 'win32',
    arch: 'x64',
    ok: true,
    failure_code: null,
    message: null,
    helper: Object.freeze({
      verified: true,
      path: 'C:\\trusted\\buddy-job-supervisor.exe',
      arch: 'x64',
      sha256: 'a'.repeat(64),
      protocol_version: '2'
    }),
    filesystem_acl_capable: true,
    roots: ROOTS,
    operation: 'ensure_and_verify',
    ...overrides
  });
}

function badVerification(failureCode, message = 'verification failed') {
  return Object.freeze({
    ...goodVerification(),
    ok: false,
    failure_code: failureCode,
    message,
    filesystem_acl_capable: failureCode !== 'windows_private_state_filesystem_acl_unavailable'
  });
}

test('production Windows provider egress gate is lifted and allows complete verification', () => {
  assert.equal(WINDOWS_PROVIDER_EGRESS_GATE_LIFTED, true);
  const policy = providerEgressPlatformPolicy({
    platform: 'win32',
    arch: 'x64',
    verification: goodVerification(),
    env: {}
  });
  assert.equal(policy.allowed, true);
  assert.equal(policy.failureCode, null);
});

test('production Windows provider egress gate fails closed without verification', () => {
  const policy = providerEgressPlatformPolicy({
    platform: 'win32',
    arch: 'x64',
    verification: null,
    env: {}
  });
  assert.equal(policy.allowed, false);
  assert.equal(policy.failureCode, 'windows_private_state_acl_unavailable');
});

test('pure policy allows Windows only with the lifted gate and complete injected verification', () => {
  const policy = evaluateProviderEgressPlatformPolicy({
    platform: 'win32',
    arch: 'x64',
    verification: goodVerification(),
    gateLifted: true,
    env: {}
  });
  assert.equal(policy.allowed, true);
  assert.equal(policy.failureCode, null);
});

test('lifted-gate policy preserves distinct Windows private-state failures', async (t) => {
  const failures = [
    'windows_private_state_acl_unavailable',
    'windows_private_state_filesystem_acl_unavailable',
    'windows_private_state_helper_unavailable',
    'windows_private_state_helper_protocol_mismatch',
    'windows_private_state_wide_acl'
  ];
  for (const failureCode of failures) {
    await t.test(failureCode, () => {
      const policy = evaluateProviderEgressPlatformPolicy({
        platform: 'win32',
        arch: 'x64',
        verification: badVerification(failureCode),
        gateLifted: true,
        env: {}
      });
      assert.equal(policy.allowed, false);
      assert.equal(policy.failureCode, failureCode);
    });
  }
});

test('Windows ARM64 helper absence has a distinct failure', () => {
  const verification = badVerification(
    'windows_private_state_helper_arch_unavailable',
    'No verified Windows ARM64 private-state helper is packaged.'
  );
  const policy = evaluateProviderEgressPlatformPolicy({
    platform: 'win32',
    arch: 'arm64',
    verification,
    gateLifted: true,
    env: {}
  });
  assert.equal(policy.allowed, false);
  assert.equal(policy.failureCode, 'windows_private_state_helper_arch_unavailable');
  assert.match(policy.detail, /ARM64/u);
});

test('lifted-gate policy cannot accept an ARM64 or mismatched helper verification', () => {
  const arm64 = evaluateProviderEgressPlatformPolicy({
    platform: 'win32',
    arch: 'arm64',
    verification: goodVerification({
      arch: 'arm64',
      helper: Object.freeze({
        verified: true,
        path: 'C:\\trusted\\buddy-job-supervisor-arm64.exe',
        arch: 'arm64',
        sha256: 'b'.repeat(64),
        protocol_version: '2'
      })
    }),
    gateLifted: true,
    env: {}
  });
  assert.equal(arm64.allowed, false);
  assert.equal(arm64.failureCode, 'windows_private_state_helper_arch_unavailable');

  const mismatched = evaluateProviderEgressPlatformPolicy({
    platform: 'win32',
    arch: 'x64',
    verification: goodVerification({ arch: 'arm64' }),
    gateLifted: true,
    env: {}
  });
  assert.equal(mismatched.allowed, false);
  assert.equal(mismatched.failureCode, 'windows_private_state_helper_unavailable');
});

test('Windows kill-switch re-blocks an otherwise allowed verified configuration', () => {
  const policy = evaluateProviderEgressPlatformPolicy({
    platform: 'win32',
    arch: 'x64',
    verification: goodVerification(),
    gateLifted: true,
    env: { CODEX_BUDDY_WINDOWS_EGRESS_BLOCK: '1' }
  });
  assert.equal(policy.allowed, false);
  assert.equal(policy.failureCode, 'windows_private_state_kill_switch');
});

test('POSIX policy remains unchanged and ignores the Windows kill-switch', () => {
  const policy = providerEgressPlatformPolicy({
    platform: 'darwin',
    env: { CODEX_BUDDY_WINDOWS_EGRESS_BLOCK: '1' }
  });
  assert.equal(policy.allowed, true);
});
