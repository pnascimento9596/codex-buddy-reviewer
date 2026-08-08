import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureWindowsPrivateStateRoots,
  reverifyWindowsPrivateStateRoots
} from '../src/windows-private-state-roots.mjs';

const roots = Object.freeze([
  Object.freeze({ class: 'durable_data', path: 'C:\\Buddy\\data' }),
  Object.freeze({ class: 'runtime_data', path: 'C:\\Buddy\\runtime' }),
  Object.freeze({ class: 'provider_temp_parent', path: 'C:\\Buddy\\temp' })
]);

const helper = Object.freeze({
  path: 'C:\\trusted\\buddy-job-supervisor.exe',
  arch: 'x64',
  sha256: 'a'.repeat(64),
  protocolVersion: '2'
});

function success(op, path) {
  return Object.freeze({
    ok: true,
    op,
    path,
    ...(op === 'filesystem_acl_capable'
      ? { filesystem_acl_capable: true }
      : { owner_sid: 'S-1-5-21-1-2-3-1001' }),
    protocol: 2
  });
}

test('Windows root builder resolves protocol 2 once and ensures then verifies every root', async () => {
  const calls = [];
  let resolveCalls = 0;
  const verification = await ensureWindowsPrivateStateRoots({
    platform: 'win32',
    arch: 'x64',
    roots,
    env: {},
    resolveHelper: async () => {
      resolveCalls += 1;
      return helper;
    },
    filesystemAclCapableImpl: async (path) => {
      calls.push(['filesystem_acl_capable', path]);
      return success('filesystem_acl_capable', path);
    },
    ensurePrivateDirImpl: async (path) => {
      calls.push(['ensure_private_dir', path]);
      return success('ensure_private_dir', path);
    },
    verifyPrivateDirImpl: async (path) => {
      calls.push(['verify_private_dir', path]);
      return success('verify_private_dir', path);
    }
  });

  assert.equal(resolveCalls, 1);
  assert.equal(verification.ok, true);
  assert.equal(Object.isFrozen(verification), true);
  assert.equal(Object.isFrozen(verification.roots), true);
  assert.deepEqual(calls, roots.flatMap((root) => [
    ['filesystem_acl_capable', root.path],
    ['ensure_private_dir', root.path],
    ['verify_private_dir', root.path]
  ]));
});

test('Windows root re-verification never repairs a failed root', async () => {
  const initial = await ensureWindowsPrivateStateRoots({
    platform: 'win32', arch: 'x64', roots, env: {},
    resolveHelper: async () => helper,
    filesystemAclCapableImpl: async (path) => success('filesystem_acl_capable', path),
    ensurePrivateDirImpl: async (path) => success('ensure_private_dir', path),
    verifyPrivateDirImpl: async (path) => success('verify_private_dir', path)
  });
  let ensureCalls = 0;
  const failed = await reverifyWindowsPrivateStateRoots(initial, {
    platform: 'win32', env: {},
    resolveHelper: async () => helper,
    filesystemAclCapableImpl: async (path) => success('filesystem_acl_capable', path),
    ensurePrivateDirImpl: async () => {
      ensureCalls += 1;
      throw new Error('must not repair during TOCTOU verification');
    },
    verifyPrivateDirImpl: async (path) => path === roots[1].path
      ? Object.freeze({
          ok: false,
          op: 'verify_private_dir',
          path,
          code: 'wide_acl',
          message: 'unexpected principal',
          win32_error: 0,
          protocol: 2
        })
      : success('verify_private_dir', path)
  });
  assert.equal(ensureCalls, 0);
  assert.equal(failed.ok, false);
  assert.equal(failed.failure_code, 'windows_private_state_wide_acl');
  assert.deepEqual(failed.operation, {
    root_class: 'runtime_data',
    name: 'verify_private_dir',
    helper_code: 'wide_acl'
  });
});

test('protocol 1, non-ACL filesystem, missing helper, and ARM64 remain distinct', async (t) => {
  const cases = [
    {
      name: 'protocol 1',
      overrides: { resolveHelper: async () => ({ ...helper, protocolVersion: '1' }) },
      code: 'windows_private_state_helper_protocol_mismatch'
    },
    {
      name: 'non-ACL filesystem',
      overrides: {
        resolveHelper: async () => helper,
        filesystemAclCapableImpl: async (path) => ({
          ok: false, op: 'filesystem_acl_capable', path,
          code: 'filesystem_acl_unavailable', message: 'no persistent ACLs',
          win32_error: 0, protocol: 2
        })
      },
      code: 'windows_private_state_filesystem_acl_unavailable'
    },
    {
      name: 'missing x64 helper',
      overrides: {
        resolveHelper: async () => {
          throw Object.assign(new Error('missing'), { kind: 'helper_unavailable' });
        }
      },
      code: 'windows_private_state_helper_unavailable'
    },
    {
      name: 'missing ARM64 helper',
      arch: 'arm64',
      overrides: {
        resolveHelper: async () => {
          throw Object.assign(new Error('missing'), { kind: 'helper_unavailable' });
        }
      },
      code: 'windows_private_state_helper_arch_unavailable'
    }
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const verification = await ensureWindowsPrivateStateRoots({
        platform: 'win32',
        arch: fixture.arch ?? 'x64',
        roots,
        env: {},
        filesystemAclCapableImpl: async (path) => success('filesystem_acl_capable', path),
        ensurePrivateDirImpl: async (path) => success('ensure_private_dir', path),
        verifyPrivateDirImpl: async (path) => success('verify_private_dir', path),
        ...fixture.overrides
      });
      assert.equal(verification.ok, false);
      assert.equal(verification.failure_code, fixture.code);
    });
  }
});
