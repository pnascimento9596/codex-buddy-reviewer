import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupProviderTempRun,
  createProviderTempRun,
  providerTempIdentitiesMatch,
  providerTempParent,
  purgeWorkspaceProviderTempRuns,
  PROVIDER_TEMP_TREE_ENTRY_LIMIT,
  PROVIDER_TEMP_TTL_MS,
  sweepStaleProviderTempRuns,
  workspaceProviderTempStatus
} from '../src/providers/temp-state.mjs';
import { workspaceKey } from '../src/state.mjs';

const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryBase(name) {
  const base = await mkdtemp(path.join(os.tmpdir(), `codex-buddy-temp-${name}-`));
  temporaryPaths.push(base);
  return base;
}

function deterministicRandom(...bytes) {
  let index = 0;
  return (size) => {
    const value = bytes[index] ?? (index + 1);
    index += 1;
    return Buffer.alloc(size, value);
  };
}

const DEFAULT_ROOT = '/private/test/provider-temp-workspace';

test('provider temporary identity strengthens stable birth-time platforms without rejecting Linux filesystems', () => {
  const identity = { dev: 1n, ino: 2n, birthtimeNs: 3n };
  assert.equal(providerTempIdentitiesMatch(identity, { ...identity }, 'darwin'), true);
  assert.equal(providerTempIdentitiesMatch(identity, { ...identity, birthtimeNs: 4n }, 'darwin'), false);
  assert.equal(providerTempIdentitiesMatch(identity, { ...identity, birthtimeNs: 0n }, 'win32'), false);
  assert.equal(providerTempIdentitiesMatch({ ...identity, birthtimeNs: 0n }, identity, 'freebsd'), false);

  assert.equal(providerTempIdentitiesMatch(identity, { ...identity, birthtimeNs: 4n }, 'linux'), true);
  assert.equal(providerTempIdentitiesMatch(
    { ...identity, birthtimeNs: 0n },
    { ...identity, birthtimeNs: 0n },
    'linux'
  ), true);
  assert.equal(providerTempIdentitiesMatch(identity, { dev: 1n, ino: 2n }, 'linux'), true);
  assert.equal(providerTempIdentitiesMatch(identity, { ...identity, ino: 5n }, 'linux'), false);
  assert.equal(providerTempIdentitiesMatch(identity, { ino: 2n }, 'linux'), false);
});

function createTempRun(options = {}) {
  return createProviderTempRun({
    root: DEFAULT_ROOT,
    provider: 'claude',
    ...options
  });
}

async function writeEmptyFiles(directory, count, prefix) {
  const batchSize = 128;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(count, start + batchSize);
    await Promise.all(Array.from({ length: end - start }, (_, offset) => (
      writeFile(path.join(directory, `${prefix}-${start + offset}`), '')
    )));
  }
}

test('provider temporary runs use a private parent, minimal marker, and injected normal cleanup', async () => {
  const tempBase = await temporaryBase('normal');
  const createdAt = Date.UTC(2026, 6, 19, 12, 0, 0);
  const run = await createTempRun({
    tempBase,
    nowMs: createdAt,
    pid: 4321,
    randomBytesImpl: deterministicRandom(0x11)
  });
  const parentStat = await lstat(run.parent);
  const runStat = await lstat(run.directory);
  assert.equal(run.parent, providerTempParent(tempBase));
  assert.equal(run.directory, path.join(run.parent, `run-${'11'.repeat(16)}`));
  assert.equal(parentStat.isDirectory(), true);
  assert.equal(runStat.isDirectory(), true);
  if (process.platform !== 'win32') {
    assert.equal(parentStat.mode & 0o777, 0o700);
    assert.equal(runStat.mode & 0o777, 0o700);
  }
  const marker = JSON.parse(await readFile(path.join(run.directory, '.codex-buddy-owner.json'), 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), [
    'created_at', 'pid', 'provider', 'run_id', 'schema', 'workspace_key', 'workspace_sha256'
  ]);
  assert.deepEqual(marker, {
    schema: 'codex-buddy-provider-temp-v2',
    run_id: '11'.repeat(16),
    pid: 4321,
    created_at: new Date(createdAt).toISOString(),
    workspace_key: workspaceKey(path.resolve(DEFAULT_ROOT)),
    workspace_sha256: createHash('sha256').update(path.resolve(DEFAULT_ROOT)).digest('hex'),
    provider: 'claude'
  });

  let observed;
  await cleanupProviderTempRun(run, {
    cleanupImpl: async (target, options) => {
      observed = { target, options };
      await rm(target, options);
    }
  });
  assert.equal(observed.target, run.directory);
  assert.deepEqual(observed.options, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50
  });
  await assert.rejects(access(run.directory));
});

test('a new provider run removes only stale marked runs owned by a dead PID', async () => {
  const tempBase = await temporaryBase('stale');
  const nowMs = Date.UTC(2026, 6, 19, 12, 0, 0);
  const stale = await createTempRun({
    tempBase,
    nowMs: nowMs - PROVIDER_TEMP_TTL_MS - 1,
    pid: 1234,
    randomBytesImpl: deterministicRandom(0x21)
  });
  const current = await createTempRun({
    tempBase,
    nowMs,
    pid: 5678,
    processAliveImpl: () => false,
    randomBytesImpl: deterministicRandom(0x31, 0x32)
  });
  if (process.platform === 'win32') {
    await access(stale.directory);
  } else {
    await assert.rejects(access(stale.directory));
  }
  await access(current.directory);
  await cleanupProviderTempRun(current);
});

test('normal cleanup refuses a replacement directory even when its name and marker are copied', async () => {
  const tempBase = await temporaryBase('replacement');
  const run = await createTempRun({
    tempBase,
    pid: 2201,
    randomBytesImpl: deterministicRandom(0x35)
  });
  const marker = await readFile(path.join(run.directory, '.codex-buddy-owner.json'), 'utf8');
  await rm(run.directory, { recursive: true, force: true });
  await mkdir(run.directory, { mode: 0o700 });
  await writeFile(path.join(run.directory, '.codex-buddy-owner.json'), marker, { mode: 0o600 });
  const sentinel = path.join(run.directory, 'replacement-must-survive');
  await writeFile(sentinel, 'not Buddy issued state\n');
  await assert.rejects(
    cleanupProviderTempRun(run),
    /ownership proof changed/
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'not Buddy issued state\n');
});

test('failed creation cleanup preserves a directory replacement instead of deleting by name', async () => {
  const tempBase = await temporaryBase('failed-creation-replacement');
  const runId = '36'.repeat(16);
  let replacement;
  await assert.rejects(
    createTempRun({
      tempBase,
      randomBytesImpl: deterministicRandom(0x36),
      openImpl: async (markerFile) => {
        replacement = path.dirname(markerFile);
        await rm(replacement, { recursive: true, force: true });
        await mkdir(replacement, { mode: 0o700 });
        await writeFile(path.join(replacement, 'replacement-must-survive'), 'preserve\n');
        throw new Error('simulated marker-open failure after directory replacement');
      }
    }),
    /simulated marker-open failure/
  );
  assert.equal(path.basename(replacement), `run-${runId}`);
  assert.equal(
    await readFile(path.join(replacement, 'replacement-must-survive'), 'utf8'),
    'preserve\n'
  );
});

test('stale cleanup preserves live owners and preserves dead owners through the strict TTL boundary', async () => {
  const tempBase = await temporaryBase('preserve');
  const nowMs = Date.UTC(2026, 6, 19, 12, 0, 0);
  const live = await createTempRun({
    tempBase,
    nowMs: nowMs - PROVIDER_TEMP_TTL_MS - 1,
    pid: 2468,
    randomBytesImpl: deterministicRandom(0x41)
  });
  const fresh = await createTempRun({
    tempBase,
    nowMs: nowMs - PROVIDER_TEMP_TTL_MS,
    pid: 1357,
    processAliveImpl: (pid) => pid === 2468,
    randomBytesImpl: deterministicRandom(0x42)
  });

  const summary = await sweepStaleProviderTempRuns({
    tempBase,
    nowMs,
    processAliveImpl: (pid) => pid === 2468,
    randomBytesImpl: deterministicRandom(0x43)
  });
  assert.equal(summary.removed, 0);
  await access(live.directory);
  await access(fresh.directory);

  const later = await sweepStaleProviderTempRuns({
    tempBase,
    nowMs: nowMs + 1,
    processAliveImpl: (pid) => pid === 2468,
    randomBytesImpl: deterministicRandom(0x44)
  });
  assert.equal(later.removed, process.platform === 'win32' ? 0 : 1);
  await access(live.directory);
  if (process.platform === 'win32') {
    await access(fresh.directory);
    await cleanupProviderTempRun(fresh);
  } else {
    await assert.rejects(access(fresh.directory));
  }
  await cleanupProviderTempRun(live);
});

test('stale cleanup refuses symlinks and malformed ownership markers without following them', {
  skip: process.platform === 'win32'
}, async () => {
  const tempBase = await temporaryBase('refuse');
  const nowMs = Date.UTC(2026, 6, 19, 12, 0, 0);
  const seed = await createTempRun({
    tempBase,
    nowMs,
    randomBytesImpl: deterministicRandom(0x51)
  });
  await cleanupProviderTempRun(seed);

  const outside = path.join(tempBase, 'outside-must-survive');
  await mkdir(outside, { mode: 0o700 });
  await writeFile(path.join(outside, 'sentinel'), 'preserve me\n', { mode: 0o600 });
  const symlinkRun = path.join(seed.parent, `run-${'61'.repeat(16)}`);
  await symlink(outside, symlinkRun);

  const malformedRun = path.join(seed.parent, `run-${'62'.repeat(16)}`);
  await mkdir(malformedRun, { mode: 0o700 });
  await writeFile(
    path.join(malformedRun, '.codex-buddy-owner.json'),
    JSON.stringify({ schema: 'codex-buddy-provider-temp-v1', unexpected: true }),
    { mode: 0o600 }
  );

  const nested = await createTempRun({
    tempBase,
    nowMs,
    pid: 7777,
    randomBytesImpl: deterministicRandom(0x64)
  });
  await symlink(outside, path.join(nested.directory, 'outside-link'));

  const summary = await sweepStaleProviderTempRuns({
    tempBase,
    nowMs: nowMs + PROVIDER_TEMP_TTL_MS + 1,
    processAliveImpl: () => false,
    randomBytesImpl: deterministicRandom(0x63)
  });
  assert.equal(summary.removed, 1);
  assert.equal(summary.refused >= 2, true);
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'preserve me\n');
  await assert.rejects(access(nested.directory));
  assert.equal((await lstat(symlinkRun)).isSymbolicLink(), true);
  assert.equal((await lstat(malformedRun)).isDirectory(), true);
});

test('provider temporary creation fails closed when the dedicated parent is a symlink', {
  skip: process.platform === 'win32'
}, async () => {
  const tempBase = await temporaryBase('root-symlink');
  const outside = path.join(tempBase, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, providerTempParent(tempBase));
  await assert.rejects(
    createTempRun({ tempBase }),
    /not a secured owned directory/
  );
});

test('workspace status attributes provider bytes without storing raw roots and purge removes only dead exact-workspace runs', {
  skip: process.platform === 'win32'
}, async () => {
  const tempBase = await temporaryBase('workspace-purge');
  const firstRoot = '/private/test/provider-temp-first-workspace';
  const secondRoot = '/private/test/provider-temp-second-workspace';
  const dead = await createProviderTempRun({
    root: firstRoot,
    provider: 'claude',
    tempBase,
    pid: 4101,
    randomBytesImpl: deterministicRandom(0x71)
  });
  const live = await createProviderTempRun({
    root: firstRoot,
    provider: 'opencode',
    tempBase,
    pid: 4102,
    processAliveImpl: () => true,
    randomBytesImpl: deterministicRandom(0x72)
  });
  const other = await createProviderTempRun({
    root: secondRoot,
    provider: 'grok',
    tempBase,
    pid: 4103,
    processAliveImpl: () => true,
    randomBytesImpl: deterministicRandom(0x73)
  });
  await writeFile(path.join(dead.directory, 'selected-auth.json'), 'private transient bytes\n');
  await writeFile(path.join(live.directory, 'review-prompt.txt'), 'private prompt bytes\n');

  const status = await workspaceProviderTempStatus({
    root: firstRoot,
    tempBase,
    processAliveImpl: (pid) => pid === 4102
  });
  assert.equal(status.complete, true);
  assert.equal(status.attributed_runs, 2);
  assert.equal(status.live_runs, 1);
  assert.equal(status.removable_runs, 1);
  assert.deepEqual(status.providers.map((item) => item.provider), ['claude', 'opencode']);
  assert.equal(status.files >= 4, true);
  assert.equal(status.bytes > 0, true);
  assert.equal(JSON.stringify(status).includes(firstRoot), false);
  assert.equal(JSON.stringify(status).includes(secondRoot), false);
  const firstMarker = await readFile(path.join(dead.directory, '.codex-buddy-owner.json'), 'utf8');
  assert.equal(firstMarker.includes(firstRoot), false);

  const result = await purgeWorkspaceProviderTempRuns({
    root: firstRoot,
    tempBase,
    processAliveImpl: (pid) => pid === 4102,
    randomBytesImpl: deterministicRandom(0x74)
  });
  assert.equal(result.removed_runs, 1);
  assert.equal(result.retained_live_runs, 1);
  assert.equal(result.removed_files >= 2, true);
  await assert.rejects(access(dead.directory));
  await access(live.directory);
  await access(other.directory);
  await cleanupProviderTempRun(live);
  await cleanupProviderTempRun(other);
});

test('legacy v1 markers remain unattributed to workspace purge but retain safe stale-cleanup compatibility', {
  skip: process.platform === 'win32'
}, async () => {
  const tempBase = await temporaryBase('legacy');
  const nowMs = Date.UTC(2026, 6, 19, 12, 0, 0);
  const seed = await createTempRun({ tempBase, randomBytesImpl: deterministicRandom(0x81) });
  await cleanupProviderTempRun(seed);
  const runId = '82'.repeat(16);
  const legacy = path.join(seed.parent, `run-${runId}`);
  await mkdir(legacy, { mode: 0o700 });
  await writeFile(path.join(legacy, '.codex-buddy-owner.json'), `${JSON.stringify({
    schema: 'codex-buddy-provider-temp-v1',
    run_id: runId,
    pid: 4201,
    created_at: new Date(nowMs - PROVIDER_TEMP_TTL_MS - 1).toISOString()
  })}\n`, { mode: 0o600 });

  const status = await workspaceProviderTempStatus({
    root: DEFAULT_ROOT,
    tempBase,
    processAliveImpl: () => false
  });
  assert.equal(status.attributed_runs, 0);
  assert.equal(status.legacy_unattributed_runs, 1);
  const purged = await purgeWorkspaceProviderTempRuns({
    root: DEFAULT_ROOT,
    tempBase,
    processAliveImpl: () => false
  });
  assert.equal(purged.removed_runs, 0);
  await access(legacy);
  const swept = await sweepStaleProviderTempRuns({
    tempBase,
    nowMs,
    processAliveImpl: () => false,
    randomBytesImpl: deterministicRandom(0x83)
  });
  assert.equal(swept.removed, 1);
  await assert.rejects(access(legacy));
});

test('workspace purge refuses an attributed run with a symlinked descendant before any deletion', {
  skip: process.platform === 'win32'
}, async () => {
  const tempBase = await temporaryBase('attributed-symlink');
  const outside = path.join(tempBase, 'outside');
  await mkdir(outside, { mode: 0o700 });
  const sentinel = path.join(outside, 'sentinel');
  await writeFile(sentinel, 'must survive\n');
  const run = await createTempRun({
    tempBase,
    pid: 4251,
    randomBytesImpl: deterministicRandom(0x85)
  });
  await symlink(outside, path.join(run.directory, 'outside-link'));
  const status = await workspaceProviderTempStatus({
    root: DEFAULT_ROOT,
    tempBase,
    processAliveImpl: () => false
  });
  assert.equal(status.complete, false);
  assert.equal(status.refused_attributed_runs, 1);
  await assert.rejects(
    purgeWorkspaceProviderTempRuns({
      root: DEFAULT_ROOT,
      tempBase,
      processAliveImpl: () => false
    }),
    /bounded ownership inventory is incomplete/
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'must survive\n');
  await access(run.directory);
  await cleanupProviderTempRun(run);
  assert.equal(await readFile(sentinel, 'utf8'), 'must survive\n');
});

test('Windows attribution is visible but ACL-unverified runs are never swept or explicitly purged', async () => {
  const tempBase = await temporaryBase('windows-unverified');
  const run = await createTempRun({
    tempBase,
    pid: 4301,
    platform: 'win32',
    randomBytesImpl: deterministicRandom(0x91)
  });
  const status = await workspaceProviderTempStatus({
    root: DEFAULT_ROOT,
    tempBase,
    platform: 'win32',
    processAliveImpl: () => false
  });
  assert.equal(status.attributed_runs, 1);
  assert.equal(status.ownership_assurance, 'windows_acl_unverified');
  assert.equal(status.purge_supported, false);
  await assert.rejects(
    purgeWorkspaceProviderTempRuns({
      root: DEFAULT_ROOT,
      tempBase,
      platform: 'win32',
      processAliveImpl: () => false
    }),
    /Windows ACL ownership is not verified/
  );
  const swept = await sweepStaleProviderTempRuns({
    tempBase,
    nowMs: Date.now() + PROVIDER_TEMP_TTL_MS + 1,
    platform: 'win32',
    processAliveImpl: () => false
  });
  assert.equal(swept.removed, 0);
  assert.equal(swept.refused, 1);
  await access(run.directory);
  await cleanupProviderTempRun(run);
});

test('bounded workspace inventory reports incomplete and purge refuses deep, oversized, and deadline-exhausted trees', async () => {
  const tempBase = await temporaryBase('bounded');
  const run = await createTempRun({
    tempBase,
    pid: 4401,
    randomBytesImpl: deterministicRandom(0xa1)
  });
  let nested = run.directory;
  for (let depth = 0; depth <= 33; depth += 1) {
    nested = path.join(nested, `d${depth}`);
    await mkdir(nested, { mode: 0o700 });
  }
  const deep = await workspaceProviderTempStatus({
    root: DEFAULT_ROOT,
    tempBase,
    processAliveImpl: () => false
  });
  assert.equal(deep.complete, false);
  assert.equal(deep.limited, true);
  await assert.rejects(
    purgeWorkspaceProviderTempRuns({
      root: DEFAULT_ROOT,
      tempBase,
      processAliveImpl: () => false
    }),
    /bounded ownership inventory is incomplete/
  );
  await rm(path.join(run.directory, 'd0'), { recursive: true, force: true });
  const oversized = path.join(run.directory, 'oversized.bin');
  await writeFile(oversized, 'x');
  await truncate(oversized, 64 * 1024 * 1024 + 1);
  const large = await workspaceProviderTempStatus({
    root: DEFAULT_ROOT,
    tempBase,
    processAliveImpl: () => false
  });
  assert.equal(large.complete, false);
  assert.equal(large.limited, true);
  await rm(oversized);

  let tick = 0;
  const deadline = await workspaceProviderTempStatus({
    root: DEFAULT_ROOT,
    tempBase,
    processAliveImpl: () => false,
    monotonicNowImpl: () => {
      tick += 2_000;
      return tick;
    }
  });
  assert.equal(deadline.complete, false);
  assert.equal(deadline.limited, true);
  assert.equal(PROVIDER_TEMP_TREE_ENTRY_LIMIT > 0, true);
  await cleanupProviderTempRun(run);
});

test('provider inventory entry budget is aggregate across several attributed runs', async () => {
  const tempBase = await temporaryBase('aggregate-entry-budget');
  const first = await createProviderTempRun({
    root: DEFAULT_ROOT,
    provider: 'claude',
    tempBase,
    pid: 4501,
    randomBytesImpl: deterministicRandom(0xb1)
  });
  const second = await createProviderTempRun({
    root: DEFAULT_ROOT,
    provider: 'ollama',
    tempBase,
    pid: 4502,
    processAliveImpl: () => true,
    randomBytesImpl: deterministicRandom(0xb2)
  });
  const perRun = Math.floor(PROVIDER_TEMP_TREE_ENTRY_LIMIT / 2) + 32;
  await writeEmptyFiles(first.directory, perRun, 'first');
  await writeEmptyFiles(second.directory, perRun, 'second');
  const status = await workspaceProviderTempStatus({
    root: DEFAULT_ROOT,
    tempBase,
    processAliveImpl: () => false,
    monotonicNowImpl: () => 0
  });
  assert.equal(status.complete, false);
  assert.equal(status.limited, true);
  await assert.rejects(
    purgeWorkspaceProviderTempRuns({
      root: DEFAULT_ROOT,
      tempBase,
      processAliveImpl: () => false,
      monotonicNowImpl: () => 0
    }),
    /bounded ownership inventory is incomplete/
  );
  await access(first.directory);
  await access(second.directory);
  await cleanupProviderTempRun(first);
  await cleanupProviderTempRun(second);
});
