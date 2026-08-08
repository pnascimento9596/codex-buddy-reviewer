import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  WINDOWS_DACL_PROTOCOL_VERSION,
  ensurePrivateDir,
  ensurePrivateFile,
  filesystemAclCapable,
  runWindowsDaclOp,
  verifyPrivateDir,
  verifyPrivateFile,
  verifyPrivateTree
} from '../src/windows-private-state.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const windowsSource = path.join(repositoryRoot, 'native', 'windows', 'job-supervisor.c');
const integrationEnabled = process.platform === 'win32'
  && typeof process.env.CODEX_BUDDY_TEST_WINDOWS_HELPER === 'string';
let integrationOptions = Object.freeze({
  platform: 'win32',
  helperManifestFile: process.env.CODEX_BUDDY_WINDOWS_HELPER_MANIFEST,
  helperRoot: process.env.CODEX_BUDDY_WINDOWS_HELPER_ROOT
});
const integrationPaths = [];

test.before(async () => {
  if (!integrationEnabled || (integrationOptions.helperManifestFile && integrationOptions.helperRoot)) return;
  const helper = await realpath(process.env.CODEX_BUDDY_TEST_WINDOWS_HELPER);
  const bytes = await readFile(helper);
  const manifestDirectory = await integrationRoot('codex-buddy-dacl-manifest-');
  const manifestFile = path.join(manifestDirectory, 'helpers.json');
  await writeFile(manifestFile, `${JSON.stringify({
    schema_version: '1',
    protocol_version: '2',
    helpers: {
      [`win32-${process.arch}`]: {
        status: 'verified',
        protocol_version: '2',
        path: path.basename(helper),
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    }
  }, null, 2)}\n`);
  integrationOptions = Object.freeze({
    platform: 'win32',
    helperManifestFile: manifestFile,
    helperRoot: path.dirname(helper)
  });
});

test.after(async () => {
  await Promise.all(integrationPaths.map((target) => rm(target, { recursive: true, force: true })));
});

async function integrationRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  integrationPaths.push(root);
  return root;
}

function fakeChild({ stdout = '', stderr = '', code = 0, signal = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  setImmediate(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', code, signal);
  });
  return child;
}

const protocol2Helper = Object.freeze({
  path: 'C:\\trusted\\buddy-job-supervisor.exe',
  protocolVersion: WINDOWS_DACL_PROTOCOL_VERSION
});

test('protocol 1 helpers fail DACL operations closed without spawning', async () => {
  let spawnCalls = 0;
  const result = await ensurePrivateDir('C:\\private', {
    platform: 'win32',
    resolveHelper: async () => ({ ...protocol2Helper, protocolVersion: '1' }),
    spawnImpl: () => {
      spawnCalls += 1;
      return fakeChild();
    }
  });

  assert.deepEqual(result, {
    ok: false,
    op: 'ensure_private_dir',
    path: 'C:\\private',
    code: 'protocol_mismatch',
    message: 'Windows helper capability protocol 1 does not provide DACL protocol 2',
    win32_error: 0,
    protocol: 2
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(spawnCalls, 0);
});

test('DACL JSON is bounded, singular, closed-schema, and terminal-control free', async (t) => {
  const cases = [
    ['malformed JSON', '{not-json}\n'],
    ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a])],
    ['oversized JSON', `${' '.repeat((256 * 1024) + 1)}\n`],
    ['multiple records', '{"ok":true}\n{"ok":true}\n'],
    ['unknown properties', '{"ok":true,"op":"protocol_info","protocol":2,"job_protocol":1,"dacl_protocol":2,"extra":true}\n'],
    ['terminal controls', '{"ok":false,"op":"ensure_private_dir","code":"open_failed","message":"bad\\u001b[2J","win32_error":5,"protocol":2}\n']
  ];

  for (const [name, stdout] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        runWindowsDaclOp('protocol_info', {
          platform: 'win32',
          resolveHelper: async () => protocol2Helper,
          spawnImpl: () => fakeChild({ stdout })
        }),
        /invalid DACL protocol response|exceeded its output limit/
      );
    });
  }
});

test('DACL helper false outcomes return frozen structured results', async () => {
  const response = {
    ok: false,
    op: 'verify_private_dir',
    path: 'C:\\private',
    code: 'wide_acl',
    message: 'DACL contains an unexpected principal',
    win32_error: 0,
    protocol: 2
  };
  const result = await runWindowsDaclOp('verify_private_dir', {
    path: response.path,
    platform: 'win32',
    resolveHelper: async () => protocol2Helper,
    spawnImpl: () => fakeChild({ stdout: `${JSON.stringify(response)}\n`, code: 1 })
  });

  assert.deepEqual(result, response);
  assert.equal(Object.isFrozen(result), true);
});

test('DACL wrapper sends the closed argv form and accepts a bound success object', async () => {
  let invocation;
  const response = {
    ok: true,
    op: 'ensure_private_dir',
    path: 'C:\\private',
    owner_sid: 'S-1-5-21-1-2-3-1001',
    protocol: 2
  };
  const result = await ensurePrivateDir(response.path, {
    platform: 'win32',
    resolveHelper: async () => protocol2Helper,
    spawnImpl: (...args) => {
      invocation = args;
      return fakeChild({ stdout: `${JSON.stringify(response)}\n` });
    }
  });

  assert.deepEqual(result, response);
  assert.deepEqual(invocation.slice(0, 2), [
    protocol2Helper.path,
    ['--protocol', '2', 'dacl', 'ensure_private_dir', '--path', response.path]
  ]);
  assert.equal(invocation[2].shell, false);
  assert.equal(Object.isFrozen(result), true);
});

test('native DACL source uses ACL authority APIs and leaves Job wire 1 isolated', async () => {
  const source = await readFile(windowsSource, 'utf8');
  assert.match(source, /wcscmp\(argv\[2\], CBD_PROTOCOL_W\)/u);
  assert.match(source, /return cbd_main\(argc, argv\);/u);
  assert.match(source, /#define CBJ_PROTOCOL_W L"1"/u);
  assert.match(source, /SetEntriesInAclW/u);
  assert.match(source, /SetNamedSecurityInfoW/u);
  assert.match(source, /GetNamedSecurityInfoW/u);
  assert.match(source, /CreateWellKnownSid/u);
  assert.match(source, /OpenProcessToken/u);
  assert.match(source, /GetTokenInformation/u);
  assert.match(source, /PROTECTED_DACL_SECURITY_INFORMATION/u);
  assert.match(source, /FILE_FLAG_OPEN_REPARSE_POINT/u);
  assert.match(source, /FILE_PERSISTENT_ACLS/u);
  assert.doesNotMatch(source, /icacls/iu);
});

test('Windows helper ensures and verifies a fresh directory idempotently', {
  skip: !integrationEnabled
}, async () => {
  const root = await integrationRoot('codex-buddy-dacl-dir-');
  const target = path.join(root, 'private');
  const first = await ensurePrivateDir(target, integrationOptions);
  const second = await ensurePrivateDir(target, integrationOptions);
  const verified = await verifyPrivateDir(target, integrationOptions);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(verified.ok, true);
  assert.equal(first.owner_sid, verified.owner_sid);
});

test('Windows verifier rejects explicit Users and Everyone access', {
  skip: !integrationEnabled
}, async (t) => {
  for (const [name, sid] of [
    ['Users', 'S-1-5-32-545'],
    ['Everyone', 'S-1-1-0']
  ]) {
    await t.test(name, async () => {
      const root = await integrationRoot(`codex-buddy-dacl-wide-${name.toLowerCase()}-`);
      const target = path.join(root, 'private');
      assert.equal((await ensurePrivateDir(target, integrationOptions)).ok, true);
      await execFileAsync('icacls.exe', [target, '/grant', `*${sid}:(F)`]);
      const verified = await verifyPrivateDir(target, integrationOptions);
      assert.equal(verified.ok, false);
      assert.equal(verified.code, 'wide_acl');
    });
  }
});

test('Windows verifier classifies explicit deny ACEs separately', {
  skip: !integrationEnabled
}, async () => {
  const root = await integrationRoot('codex-buddy-dacl-deny-');
  const target = path.join(root, 'private');
  assert.equal((await ensurePrivateDir(target, integrationOptions)).ok, true);
  await execFileAsync('icacls.exe', [target, '/deny', '*S-1-5-32-546:(R)']);
  const verified = await verifyPrivateDir(target, integrationOptions);
  assert.equal(verified.ok, false);
  assert.equal(verified.code, 'deny_ace');
});

test('Windows verifier rejects a constructible wrong owner', {
  skip: !integrationEnabled
}, async (t) => {
  const root = await integrationRoot('codex-buddy-dacl-owner-');
  const target = path.join(root, 'private');
  assert.equal((await ensurePrivateDir(target, integrationOptions)).ok, true);
  try {
    await execFileAsync('icacls.exe', [target, '/setowner', '*S-1-5-18']);
  } catch (error) {
    t.diagnostic(`wrong-owner fixture unavailable: ${error.message}`);
    return;
  }
  const verified = await verifyPrivateDir(target, integrationOptions);
  assert.equal(verified.ok, false);
  assert.equal(verified.code, 'owner_mismatch');
});

test('Windows helper rejects junction leaves and junction ancestors', {
  skip: !integrationEnabled
}, async () => {
  const root = await integrationRoot('codex-buddy-dacl-junction-');
  const target = path.join(root, 'target');
  const junction = path.join(root, 'junction');
  const leaf = path.join(target, 'leaf');
  await mkdir(target);
  await symlink(target, junction, 'junction');
  const rejectedLeaf = await ensurePrivateDir(junction, integrationOptions);
  assert.equal(rejectedLeaf.ok, false);
  assert.equal(rejectedLeaf.code, 'reparse_point');

  assert.equal((await ensurePrivateDir(leaf, integrationOptions)).ok, true);
  const rejectedTree = await verifyPrivateTree(
    path.join(junction, 'leaf'),
    root,
    integrationOptions
  );
  assert.equal(rejectedTree.ok, false);
  assert.equal(rejectedTree.code, 'ancestor_reparse');
});

test('Windows private directory survives concurrent same-parent rename writers', {
  skip: !integrationEnabled
}, async () => {
  const root = await integrationRoot('codex-buddy-dacl-renames-');
  const target = path.join(root, 'private');
  assert.equal((await ensurePrivateDir(target, integrationOptions)).ok, true);
  const finals = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const temporary = path.join(target, `.write-${index}.tmp`);
    const final = path.join(target, `receipt-${index}.json`);
    await writeFile(temporary, JSON.stringify({ index }));
    await rename(temporary, final);
    // Full leaf template requires ensure after create/rename (ADR 0002).
    assert.equal((await ensurePrivateFile(final, integrationOptions)).ok, true);
    return final;
  }));
  assert.equal((await verifyPrivateDir(target, integrationOptions)).ok, true);
  for (const final of finals) assert.equal((await verifyPrivateFile(final, integrationOptions)).ok, true);
});

test('Windows TEMP volume reports persistent ACLs', {
  skip: !integrationEnabled
}, async () => {
  const result = await filesystemAclCapable(os.tmpdir(), integrationOptions);
  assert.equal(result.ok, true);
  assert.equal(result.filesystem_acl_capable, true);
});

test('Windows helper ensures files; inheritance alone does not satisfy full verify', {
  skip: !integrationEnabled
}, async () => {
  const root = await integrationRoot('codex-buddy-dacl-files-');
  const parent = path.join(root, 'private');
  const ensuredFile = path.join(parent, 'ensured.json');
  const inheritedFile = path.join(parent, 'inherited.json');
  assert.equal((await ensurePrivateDir(parent, integrationOptions)).ok, true);
  assert.equal((await ensurePrivateFile(ensuredFile, integrationOptions)).ok, true);
  assert.equal((await verifyPrivateFile(ensuredFile, integrationOptions)).ok, true);
  await writeFile(inheritedFile, '{}');
  // OI|CI access boundary is not the full leaf template: unprotected/inherited
  // children must fail verify until ensure_private_file repairs owner+DACL.
  const inheritedVerify = await verifyPrivateFile(inheritedFile, integrationOptions);
  assert.equal(inheritedVerify.ok, false);
  assert.ok(
    inheritedVerify.code === 'inheritance_enabled'
      || inheritedVerify.code === 'owner_mismatch'
      || inheritedVerify.code === 'wide_acl'
      || inheritedVerify.code === 'missing_required_ace',
    inheritedVerify.code
  );
  assert.equal((await ensurePrivateFile(inheritedFile, integrationOptions)).ok, true);
  assert.equal((await verifyPrivateFile(inheritedFile, integrationOptions)).ok, true);
});

test('Windows helper rejects relative paths and reports both protocol capabilities', {
  skip: !integrationEnabled
}, async () => {
  await assert.rejects(
    ensurePrivateDir('C:\\private\0forged', integrationOptions),
    /without NUL bytes/
  );
  const relative = await ensurePrivateDir('relative\\private', integrationOptions);
  assert.equal(relative.ok, false);
  assert.equal(relative.code, 'path_not_absolute');
  const info = await runWindowsDaclOp('protocol_info', integrationOptions);
  assert.deepEqual(info, {
    ok: true,
    op: 'protocol_info',
    job_protocol: 1,
    dacl_protocol: 2,
    protocol: 2
  });
});

test('Windows private-tree verification binds the leaf beneath its anchor', {
  skip: !integrationEnabled
}, async () => {
  const root = await integrationRoot('codex-buddy-dacl-tree-');
  const parent = path.join(root, 'parent');
  const leaf = path.join(parent, 'leaf');
  await mkdir(parent);
  assert.equal((await ensurePrivateDir(leaf, integrationOptions)).ok, true);
  assert.equal((await verifyPrivateTree(leaf, root, integrationOptions)).ok, true);
  const escaped = await verifyPrivateTree(leaf, path.join(root, 'elsewhere'), integrationOptions);
  assert.equal(escaped.ok, false);
  assert.equal(escaped.code, 'ancestor_escape');
});

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return {
    n: samples.length,
    mean_ms: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    median_ms: median
  };
}

async function timed(operation) {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

test('Windows DACL helper microbenchmark emits non-gating evidence', {
  skip: !integrationEnabled
}, async (t) => {
  const root = await integrationRoot('codex-buddy-dacl-bench-');
  const directories = Array.from({ length: 50 }, (_, index) => path.join(root, `dir-${index}`));
  const files = directories.map((directory) => path.join(directory, 'state.json'));
  const ensureDirectories = [];
  const ensureFiles = [];
  const verifyDirectories = [];
  const inheritedWrites = [];
  const ensuredWrites = [];

  for (const directory of directories) {
    ensureDirectories.push(await timed(async () => {
      assert.equal((await ensurePrivateDir(directory, integrationOptions)).ok, true);
    }));
  }
  for (const file of files) {
    ensureFiles.push(await timed(async () => {
      assert.equal((await ensurePrivateFile(file, integrationOptions)).ok, true);
    }));
  }
  for (const directory of directories) {
    verifyDirectories.push(await timed(async () => {
      assert.equal((await verifyPrivateDir(directory, integrationOptions)).ok, true);
    }));
  }
  const inheritedParent = path.join(root, 'inheritance-only');
  const ensuredParent = path.join(root, 'ensure-per-write');
  assert.equal((await ensurePrivateDir(inheritedParent, integrationOptions)).ok, true);
  assert.equal((await ensurePrivateDir(ensuredParent, integrationOptions)).ok, true);
  for (let index = 0; index < 50; index += 1) {
    const inherited = path.join(inheritedParent, `state-${index}.json`);
    inheritedWrites.push(await timed(async () => {
      // Access-boundary path only: no helper round-trip (full verify must fail).
      await writeFile(inherited, '{}');
    }));
    const ensured = path.join(ensuredParent, `state-${index}.json`);
    ensuredWrites.push(await timed(async () => {
      await writeFile(ensured, '{}');
      assert.equal((await ensurePrivateFile(ensured, integrationOptions)).ok, true);
      assert.equal((await verifyPrivateFile(ensured, integrationOptions)).ok, true);
    }));
  }

  const report = {
    protocol: 2,
    ensure_private_dir: summarize(ensureDirectories),
    ensure_private_file: summarize(ensureFiles),
    verify_private_dir: summarize(verifyDirectories),
    inheritance_write_only_no_helper: summarize(inheritedWrites),
    write_then_ensure_and_verify_file: summarize(ensuredWrites)
  };
  const outputDirectory = path.join(repositoryRoot, 'build', 'windows-tests');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'dacl-bench.json'), `${JSON.stringify(report, null, 2)}\n`);
  t.diagnostic(`DACL benchmark ${JSON.stringify(report)}`);
});
