import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureWindowsPrivateStateRoots,
  reverifyWindowsPrivateStateRoots,
  windowsPrivateStateVerificationIsComplete
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

function directoryDetails({ symlink = false } = {}) {
  return Object.freeze({
    isSymbolicLink: () => symlink,
    isDirectory: () => !symlink
  });
}

function missingPath() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function runtimeEntry(path, origin) {
  return Object.freeze({ path, origin });
}

test('Windows root builder resolves protocol 2 once and ensures then verifies every root', async () => {
  const calls = [];
  let resolveCalls = 0;
  const verification = await ensureWindowsPrivateStateRoots({
    platform: 'win32',
    arch: 'x64',
    roots,
    env: {},
    enumerateRuntimeDataDirsImpl: async () => [],
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
    },
    verifyPrivateTreeImpl: async (path, ancestorsUntil) => {
      calls.push(['verify_private_tree', path, ancestorsUntil]);
      return success('verify_private_tree', path);
    }
  });

  assert.equal(resolveCalls, 1);
  assert.equal(verification.ok, true);
  assert.equal(Object.isFrozen(verification), true);
  assert.equal(Object.isFrozen(verification.roots), true);
  assert.deepEqual(calls, roots.flatMap((root) => [
    ['filesystem_acl_capable', root.path],
    ['ensure_private_dir', root.path],
    ['verify_private_dir', root.path],
    ['verify_private_tree', root.path, 'C:\\']
  ]));
});

test('Windows root builder rejects an ancestor reparse reported by the tree verifier', async () => {
  const verification = await ensureWindowsPrivateStateRoots({
    platform: 'win32',
    arch: 'x64',
    roots,
    env: {},
    enumerateRuntimeDataDirsImpl: async () => [],
    resolveHelper: async () => helper,
    filesystemAclCapableImpl: async (path) => success('filesystem_acl_capable', path),
    ensurePrivateDirImpl: async (path) => success('ensure_private_dir', path),
    verifyPrivateDirImpl: async (path) => success('verify_private_dir', path),
    verifyPrivateTreeImpl: async (path) => ({
      ok: false,
      op: 'verify_private_tree',
      path,
      code: 'ancestor_reparse',
      message: 'ancestor is a reparse point',
      win32_error: 0,
      protocol: 2
    })
  });
  assert.equal(verification.ok, false);
  assert.equal(verification.failure_code, 'windows_private_state_ancestor_reparse');
});

test('Windows root re-verification never repairs a failed root', async () => {
  const initial = await ensureWindowsPrivateStateRoots({
    platform: 'win32', arch: 'x64', roots, env: {}, enumerateRuntimeDataDirsImpl: async () => [],
    resolveHelper: async () => helper,
    filesystemAclCapableImpl: async (path) => success('filesystem_acl_capable', path),
    ensurePrivateDirImpl: async (path) => success('ensure_private_dir', path),
    verifyPrivateDirImpl: async (path) => success('verify_private_dir', path),
    verifyPrivateTreeImpl: async (path) => success('verify_private_tree', path)
  });
  let ensureCalls = 0;
  const failed = await reverifyWindowsPrivateStateRoots(initial, {
    platform: 'win32', env: {}, roots,
    enumerateRuntimeDataDirsImpl: async () => [],
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
      : success('verify_private_dir', path),
    verifyPrivateTreeImpl: async (path) => success('verify_private_tree', path)
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

test('default Windows inventory keeps one active root per class and assures non-active runtime paths', async () => {
  const visited = [];
  const activeRuntime = '/laneh/Buddy/active-runtime';
  const alternateRuntime = '/laneh/Buddy/alternate-runtime';
  const discoveredRuntime = '/laneh/Codex/plugins/data/codex-buddy-reviewer-discovered';
  const symlinkedRuntime = '/laneh/Codex/plugins/data/codex-buddy-reviewer-symlink';
  const verification = await ensureWindowsPrivateStateRoots({
    platform: 'win32',
    arch: 'x64',
    env: {
      CODEX_BUDDY_DATA_DIR: '/laneh/Buddy/data',
      PLUGIN_DATA: activeRuntime,
      CLAUDE_PLUGIN_DATA: alternateRuntime
    },
    codexHome: '/laneh/Codex',
    tempBase: '/laneh/Buddy/temp-base',
    readdirImpl: async (target) => target === '/laneh/Codex/plugins/data'
      ? [
          { name: 'codex-buddy-reviewer-discovered' },
          { name: 'codex-buddy-reviewer-symlink' },
          { name: 'other-plugin' }
        ]
      : target === discoveredRuntime ? ['turns'] : [],
    lstatImpl: async (target) => target === symlinkedRuntime
      ? directoryDetails({ symlink: true })
      : directoryDetails(),
    filesystemAclCapableImpl: async (path) => {
      visited.push(['filesystem_acl_capable', path]);
      return success('filesystem_acl_capable', path);
    },
    ensurePrivateDirImpl: async (path) => {
      visited.push(['ensure_private_dir', path]);
      return success('ensure_private_dir', path);
    },
    verifyPrivateDirImpl: async (path) => {
      visited.push(['verify_private_dir', path]);
      return success('verify_private_dir', path);
    },
    verifyPrivateTreeImpl: async (path) => {
      visited.push(['verify_private_tree', path]);
      return success('verify_private_tree', path);
    }
  });
  assert.equal(verification.ok, true);
  assert.equal(verification.schema_version, '2');
  assert.deepEqual(verification.roots.map((root) => root.class), [
    'durable_data',
    'runtime_data',
    'provider_temp_parent'
  ]);
  assert.deepEqual(verification.roots.filter((root) => root.class === 'runtime_data').map((root) => root.path), [
    activeRuntime
  ]);
  assert.deepEqual(verification.assured_paths.map(({ path, origin, exists, holds_buddy_content }) => ({
    path, origin, exists, holds_buddy_content
  })), [
    {
      path: alternateRuntime,
      origin: 'CLAUDE_PLUGIN_DATA',
      exists: true,
      holds_buddy_content: false
    },
    {
      path: discoveredRuntime,
      origin: 'discovered_plugin_data_sibling',
      exists: true,
      holds_buddy_content: true
    }
  ]);
  assert.equal(verification.assured_paths.every((entry) => entry.ensured && entry.verified), true);
  assert.equal(visited.some(([, path]) => path === symlinkedRuntime), false);
  assert.equal(visited.filter(([, path]) => path === '/laneh/Buddy/data').length, 4);
});

test('Windows root re-verification rejects a supplied active root-set mismatch', async () => {
  const initial = await ensureWindowsPrivateStateRoots({
    platform: 'win32', arch: 'x64', roots, env: {}, enumerateRuntimeDataDirsImpl: async () => [],
    resolveHelper: async () => helper,
    filesystemAclCapableImpl: async (path) => success('filesystem_acl_capable', path),
    ensurePrivateDirImpl: async (path) => success('ensure_private_dir', path),
    verifyPrivateDirImpl: async (path) => success('verify_private_dir', path),
    verifyPrivateTreeImpl: async (path) => success('verify_private_tree', path)
  });
  const failed = await reverifyWindowsPrivateStateRoots(initial, {
    platform: 'win32',
    roots: roots.map((root) => ({ ...root, path: root.path.replace('Buddy', 'Other') })),
    env: {},
    resolveHelper: async () => helper,
    filesystemAclCapableImpl: async (path) => success('filesystem_acl_capable', path),
    verifyPrivateDirImpl: async (path) => success('verify_private_dir', path),
    verifyPrivateTreeImpl: async (path) => success('verify_private_tree', path)
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.failure_code, 'windows_private_state_root_set_changed');
});

test('assured runtime paths record absent as a no-op and ensure present paths', async () => {
  const activeRuntime = roots.find((root) => root.class === 'runtime_data').path;
  const absentRuntime = 'C:\\Buddy\\absent-runtime';
  const presentRuntime = 'C:\\Buddy\\present-runtime';
  const calls = [];
  const verification = await ensureWindowsPrivateStateRoots({
    platform: 'win32', arch: 'x64', roots, env: {},
    resolveHelper: async () => helper,
    enumerateRuntimeDataDirsImpl: async () => [
      runtimeEntry(activeRuntime, 'runtime_data_dir'),
      runtimeEntry(absentRuntime, 'CLAUDE_PLUGIN_DATA'),
      runtimeEntry(presentRuntime, 'discovered_plugin_data_sibling')
    ],
    lstatImpl: async (target) => {
      if (target === absentRuntime) throw missingPath();
      return directoryDetails();
    },
    readdirImpl: async () => [],
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
    },
    verifyPrivateTreeImpl: async (path) => {
      calls.push(['verify_private_tree', path]);
      return success('verify_private_tree', path);
    }
  });
  assert.equal(verification.ok, true);
  assert.deepEqual(verification.assured_paths.map((entry) => ({
    path: entry.path,
    exists: entry.exists,
    ensured: entry.ensured,
    verified: entry.verified
  })), [
    { path: absentRuntime, exists: false, ensured: false, verified: false },
    { path: presentRuntime, exists: true, ensured: true, verified: true }
  ]);
  assert.equal(calls.some(([, path]) => path === absentRuntime), false);
  assert.equal(calls.filter(([, path]) => path === presentRuntime).length, 4);
});

test('assured path with Buddy content fails closed when DACL verification fails', async () => {
  const assuredRuntime = 'C:\\Buddy\\content-runtime';
  const verification = await ensureWindowsPrivateStateRoots({
    platform: 'win32', arch: 'x64', roots, env: {},
    resolveHelper: async () => helper,
    enumerateRuntimeDataDirsImpl: async () => [runtimeEntry(assuredRuntime, 'PLUGIN_DATA')],
    lstatImpl: async () => directoryDetails(),
    readdirImpl: async () => ['turns'],
    filesystemAclCapableImpl: async (path) => success('filesystem_acl_capable', path),
    ensurePrivateDirImpl: async (path) => success('ensure_private_dir', path),
    verifyPrivateDirImpl: async (path) => path === assuredRuntime
      ? {
          ok: false,
          op: 'verify_private_dir',
          path,
          code: 'wide_acl',
          message: 'unexpected principal',
          win32_error: 0,
          protocol: 2
        }
      : success('verify_private_dir', path),
    verifyPrivateTreeImpl: async (path) => success('verify_private_tree', path)
  });
  assert.equal(verification.ok, false);
  assert.equal(verification.failure_code, 'windows_private_state_wide_acl');
  assert.deepEqual(verification.operation, {
    assured_path: assuredRuntime,
    origin: 'PLUGIN_DATA',
    name: 'verify_private_dir',
    helper_code: 'wide_acl'
  });
});

test('schema v1 verification proofs are rejected because they never covered assured paths', async () => {
  const current = await ensureWindowsPrivateStateRoots({
    platform: 'win32', arch: 'x64', roots, env: {},
    resolveHelper: async () => helper,
    enumerateRuntimeDataDirsImpl: async () => [],
    filesystemAclCapableImpl: async (path) => success('filesystem_acl_capable', path),
    ensurePrivateDirImpl: async (path) => success('ensure_private_dir', path),
    verifyPrivateDirImpl: async (path) => success('verify_private_dir', path),
    verifyPrivateTreeImpl: async (path) => success('verify_private_tree', path)
  });
  const legacy = { ...current, schema_version: '1' };
  assert.equal(windowsPrivateStateVerificationIsComplete(legacy), false);
  const rejected = await reverifyWindowsPrivateStateRoots(legacy, {
    platform: 'win32', arch: 'x64', roots, env: {}
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.schema_version, '2');
  assert.equal(rejected.failure_code, 'windows_private_state_schema_unsupported');
  assert.match(rejected.message, /assured paths/u);
});

test('Windows root re-verification rejects an assured-path set mismatch', async () => {
  const assuredA = runtimeEntry('C:\\Buddy\\runtime-a', 'PLUGIN_DATA');
  const assuredB = runtimeEntry('C:\\Buddy\\runtime-b', 'PLUGIN_DATA');
  const common = {
    platform: 'win32', arch: 'x64', roots, env: {}, enumerateRuntimeDataDirsImpl: async () => [],
    resolveHelper: async () => helper,
    lstatImpl: async () => directoryDetails(),
    readdirImpl: async () => [],
    filesystemAclCapableImpl: async (path) => success('filesystem_acl_capable', path),
    ensurePrivateDirImpl: async (path) => success('ensure_private_dir', path),
    verifyPrivateDirImpl: async (path) => success('verify_private_dir', path),
    verifyPrivateTreeImpl: async (path) => success('verify_private_tree', path)
  };
  const initial = await ensureWindowsPrivateStateRoots({
    ...common,
    enumerateRuntimeDataDirsImpl: async () => [assuredA]
  });
  const rejected = await reverifyWindowsPrivateStateRoots(initial, {
    ...common,
    enumerateRuntimeDataDirsImpl: async () => [assuredB]
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.failure_code, 'windows_private_state_root_set_changed');
});

test('default durable/runtime fallback may alias one path while preserving one root per class', async () => {
  const shared = '/fixture/Buddy/data';
  const verification = await ensureWindowsPrivateStateRoots({
    platform: 'win32', arch: 'x64', env: {},
    dataDir: shared,
    runtimeDataDir: shared,
    tempBase: '/fixture/Buddy/temp',
    home: '/fixture/home',
    codexHome: '/fixture/Codex',
    enumerateRuntimeDataDirsImpl: async () => [],
    resolveHelper: async () => helper,
    filesystemAclCapableImpl: async (target) => success('filesystem_acl_capable', target),
    ensurePrivateDirImpl: async (target) => success('ensure_private_dir', target),
    verifyPrivateDirImpl: async (target) => success('verify_private_dir', target),
    verifyPrivateTreeImpl: async (target) => success('verify_private_tree', target)
  });
  assert.equal(verification.ok, true);
  assert.equal(verification.roots[0].path, shared);
  assert.equal(verification.roots[1].path, shared);
  assert.equal(windowsPrivateStateVerificationIsComplete(verification), true);
});

test('assured-path identity is stable across enumeration order changes', async () => {
  const assuredA = runtimeEntry('C:\\Buddy\\runtime-a', 'PLUGIN_DATA');
  const assuredB = runtimeEntry('C:\\Buddy\\runtime-b', 'CLAUDE_PLUGIN_DATA');
  const common = {
    platform: 'win32', arch: 'x64', roots, env: {},
    resolveHelper: async () => helper,
    lstatImpl: async () => directoryDetails(),
    readdirImpl: async () => [],
    filesystemAclCapableImpl: async (target) => success('filesystem_acl_capable', target),
    ensurePrivateDirImpl: async (target) => success('ensure_private_dir', target),
    verifyPrivateDirImpl: async (target) => success('verify_private_dir', target),
    verifyPrivateTreeImpl: async (target) => success('verify_private_tree', target)
  };
  const initial = await ensureWindowsPrivateStateRoots({
    ...common,
    enumerateRuntimeDataDirsImpl: async () => [assuredA, assuredB]
  });
  const current = await reverifyWindowsPrivateStateRoots(initial, {
    ...common,
    enumerateRuntimeDataDirsImpl: async () => [assuredB, assuredA]
  });
  assert.equal(initial.ok, true);
  assert.equal(current.ok, true);
  assert.equal(windowsPrivateStateVerificationIsComplete(current), true);
});

test('reverification fails closed when a previously absent assured path becomes present', async () => {
  const assuredRuntime = 'C:\\Buddy\\later-runtime';
  let present = false;
  let assuredEnsureCalls = 0;
  const common = {
    platform: 'win32', arch: 'x64', roots, env: {},
    enumerateRuntimeDataDirsImpl: async () => [runtimeEntry(assuredRuntime, 'CLAUDE_PLUGIN_DATA')],
    resolveHelper: async () => helper,
    lstatImpl: async (target) => {
      if (target === assuredRuntime && !present) throw missingPath();
      return directoryDetails();
    },
    readdirImpl: async () => [],
    filesystemAclCapableImpl: async (target) => success('filesystem_acl_capable', target),
    ensurePrivateDirImpl: async (target) => {
      if (target === assuredRuntime) assuredEnsureCalls += 1;
      return success('ensure_private_dir', target);
    },
    verifyPrivateDirImpl: async (target) => success('verify_private_dir', target),
    verifyPrivateTreeImpl: async (target) => success('verify_private_tree', target)
  };
  const initial = await ensureWindowsPrivateStateRoots(common);
  assert.equal(initial.ok, true);
  assert.equal(initial.assured_paths[0].exists, false);
  present = true;
  const current = await reverifyWindowsPrivateStateRoots(initial, common);
  assert.equal(current.ok, false);
  assert.equal(current.failure_code, 'windows_private_state_root_set_changed');
  assert.equal(current.operation.name, 'assured_path_became_present');
  assert.equal(assuredEnsureCalls, 0);
  assert.equal(windowsPrivateStateVerificationIsComplete(current, { requireEnsured: false }), false);
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
        enumerateRuntimeDataDirsImpl: async () => [],
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
