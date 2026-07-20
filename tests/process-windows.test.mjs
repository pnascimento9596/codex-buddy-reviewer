import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runProcess } from '../src/process.mjs';
import {
  WINDOWS_JOB_PROTOCOL_VERSION,
  buildWindowsCommandLine,
  createWindowsJobControlCredentials,
  parseWindowsJobControlBytes,
  parseWindowsJobControlLine,
  quoteWindowsArgument,
  resolveVerifiedWindowsJobHelper,
  runWindowsJobProcess,
  validateWindowsJobHelperClose
} from '../src/windows-job-supervisor.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const windowsSource = path.join(repositoryRoot, 'native', 'windows', 'job-supervisor.c');
const windowsSupervisorSource = path.join(repositoryRoot, 'src', 'windows-job-supervisor.mjs');
const initialManifest = path.join(repositoryRoot, 'native', 'windows', 'helpers.json');
const fixtures = path.join(repositoryRoot, 'tests', 'fixtures', 'windows');
const temporaryPaths = [];

test.after(async () => {
  await Promise.all(temporaryPaths.map((target) => rm(target, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function syntheticPe(machine) {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'binary');
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}

async function writeManifest(directory, record, overrides = {}) {
  const manifestFile = path.join(directory, 'helpers.json');
  await writeFile(manifestFile, `${JSON.stringify({
    schema_version: '1',
    protocol_version: WINDOWS_JOB_PROTOCOL_VERSION,
    helpers: { 'win32-x64': record },
    ...overrides
  }, null, 2)}\n`);
  return manifestFile;
}

async function verifiedFixture({ machine = 0x8664, expectedHash } = {}) {
  const root = await temporaryDirectory('codex-buddy-windows-helper-');
  const binaryDirectory = path.join(root, 'bin');
  await mkdir(binaryDirectory);
  const helper = path.join(binaryDirectory, 'buddy-job-supervisor.exe');
  const bytes = syntheticPe(machine);
  await writeFile(helper, bytes);
  const manifestFile = await writeManifest(root, {
    status: 'verified',
    protocol_version: WINDOWS_JOB_PROTOCOL_VERSION,
    path: path.join('bin', 'buddy-job-supervisor.exe'),
    sha256: expectedHash ?? sha256(bytes)
  });
  return { root, helper, manifestFile, bytes };
}

function parseMicrosoftCommandLine(commandLine) {
  const args = [];
  let index = 0;
  while (index < commandLine.length) {
    while (commandLine[index] === ' ' || commandLine[index] === '\t') index += 1;
    if (index >= commandLine.length) break;
    let value = '';
    let quoted = false;
    while (index < commandLine.length) {
      let backslashes = 0;
      while (commandLine[index] === '\\') {
        backslashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        value += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) value += '"';
        else quoted = !quoted;
        index += 1;
        continue;
      }
      value += '\\'.repeat(backslashes);
      if (index >= commandLine.length || (!quoted && [' ', '\t'].includes(commandLine[index]))) break;
      value += commandLine[index];
      index += 1;
    }
    args.push(value);
    while (commandLine[index] === ' ' || commandLine[index] === '\t') index += 1;
  }
  return args;
}

async function runtimeHelperOptions() {
  const configured = process.env.CODEX_BUDDY_TEST_WINDOWS_HELPER;
  assert.equal(typeof configured, 'string', 'Windows CI must set CODEX_BUDDY_TEST_WINDOWS_HELPER');
  const helper = await realpath(configured);
  const bytes = await readFile(helper);
  const root = path.dirname(helper);
  const manifestDirectory = await temporaryDirectory('codex-buddy-runtime-helper-manifest-');
  const manifestFile = await writeManifest(manifestDirectory, {
    status: 'verified',
    protocol_version: WINDOWS_JOB_PROTOCOL_VERSION,
    path: path.basename(helper),
    sha256: sha256(bytes)
  });
  return { helperManifestFile: manifestFile, helperRoot: root };
}

async function waitForJson(file, maximumMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < maximumMs) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function processIsGone(pid, maximumMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < maximumMs) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function forceFixtureCleanup(pids) {
  for (const pid of pids) {
    if (!Number.isInteger(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

test('initial Windows helper metadata is deliberately unavailable and fail closed', async () => {
  const manifest = JSON.parse(await readFile(initialManifest, 'utf8'));
  assert.equal(manifest.schema_version, '1');
  assert.equal(manifest.protocol_version, WINDOWS_JOB_PROTOCOL_VERSION);
  assert.match(manifest.build.x64, /cl\.exe .*job-supervisor\.c/);
  assert.equal(manifest.helpers['win32-x64'].status, 'unavailable');
  assert.equal(manifest.helpers['win32-arm64'].status, 'unavailable');
  await assert.rejects(
    resolveVerifiedWindowsJobHelper({ platform: 'win32', arch: 'x64' }),
    (error) => error.kind === 'helper_unavailable'
  );
});

test('helper selection requires a hash-pinned regular PE matching the requested architecture', async () => {
  const fixture = await verifiedFixture();
  const selected = await resolveVerifiedWindowsJobHelper({
    platform: 'win32',
    arch: 'x64',
    manifestFile: fixture.manifestFile,
    helperRoot: fixture.root
  });
  assert.equal(selected.path, await realpath(fixture.helper));
  assert.equal(selected.sha256, sha256(fixture.bytes));
  assert.equal(selected.protocolVersion, WINDOWS_JOB_PROTOCOL_VERSION);

  const mismatchedHash = await verifiedFixture({ expectedHash: '0'.repeat(64) });
  await assert.rejects(
    resolveVerifiedWindowsJobHelper({
      platform: 'win32', arch: 'x64',
      manifestFile: mismatchedHash.manifestFile, helperRoot: mismatchedHash.root
    }),
    (error) => error.kind === 'integrity_mismatch'
  );

  const wrongArchitecture = await verifiedFixture({ machine: 0xaa64 });
  await assert.rejects(
    resolveVerifiedWindowsJobHelper({
      platform: 'win32', arch: 'x64',
      manifestFile: wrongArchitecture.manifestFile, helperRoot: wrongArchitecture.root
    }),
    (error) => error.kind === 'architecture_mismatch'
  );
});

test('helper selection rejects protocol drift, path escape, symlinks, and unsupported platforms', async () => {
  const fixture = await verifiedFixture();
  const protocolManifest = await writeManifest(fixture.root, {
    status: 'verified', protocol_version: '2',
    path: path.join('bin', 'buddy-job-supervisor.exe'), sha256: sha256(fixture.bytes)
  });
  await assert.rejects(
    resolveVerifiedWindowsJobHelper({
      platform: 'win32', arch: 'x64', manifestFile: protocolManifest, helperRoot: fixture.root
    }),
    /metadata is invalid/
  );

  const escapeManifest = await writeManifest(fixture.root, {
    status: 'verified', protocol_version: WINDOWS_JOB_PROTOCOL_VERSION,
    path: path.join('..', 'outside.exe'), sha256: sha256(fixture.bytes)
  });
  await assert.rejects(
    resolveVerifiedWindowsJobHelper({
      platform: 'win32', arch: 'x64', manifestFile: escapeManifest, helperRoot: fixture.root
    }),
    /escapes/
  );

  if (process.platform !== 'win32') {
    const link = path.join(fixture.root, 'linked-helper.exe');
    await symlink(fixture.helper, link);
    const linkManifest = await writeManifest(fixture.root, {
      status: 'verified', protocol_version: WINDOWS_JOB_PROTOCOL_VERSION,
      path: 'linked-helper.exe', sha256: sha256(fixture.bytes)
    });
    await assert.rejects(
      resolveVerifiedWindowsJobHelper({
        platform: 'win32', arch: 'x64', manifestFile: linkManifest, helperRoot: fixture.root
      }),
      /regular non-symlink/
    );
  }

  await assert.rejects(resolveVerifiedWindowsJobHelper({ platform: 'darwin' }), (error) => (
    error.kind === 'unsupported_platform'
  ));
  await assert.rejects(
    resolveVerifiedWindowsJobHelper({ platform: 'win32', arch: 'ia32' }),
    (error) => error.kind === 'unsupported_architecture'
  );
});

test('Windows argv quoting round-trips empty, spaced, quoted, slash-heavy, and Unicode arguments', () => {
  const argv = [
    'C:\\Program Files\\Buddy\\provider.exe',
    '',
    'plain',
    'two words',
    'embedded"quote',
    'slashes\\\\before"quote',
    'trailing\\',
    '\\\\server\\share\\path with spaces\\',
    'snowman-☃-emoji-🙂'
  ];
  const commandLine = buildWindowsCommandLine(argv[0], argv.slice(1));
  assert.deepEqual(parseMicrosoftCommandLine(commandLine), argv);
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('trailing\\'), '"trailing\\\\"');
  assert.throws(() => buildWindowsCommandLine('provider', ['bad\0arg']), /NUL/);
  assert.throws(() => buildWindowsCommandLine('provider', ['x'.repeat(32_767)]), /32766/);
});

test('the control protocol is closed, authenticated, ASCII-only, and bounded', () => {
  const token = 'a'.repeat(64);
  assert.deepEqual(parseWindowsJobControlLine(`CBJ 1 HELLO ${token}`, token), { type: 'hello', token });
  assert.deepEqual(parseWindowsJobControlLine('CBJ 1 READY 123'), { type: 'ready', pid: 123 });
  assert.deepEqual(parseWindowsJobControlLine('CBJ 1 EXIT 4294967295'), {
    type: 'exit', code: 0xffff_ffff
  });
  assert.deepEqual(parseWindowsJobControlLine('CBJ 1 ERROR assign_job 5'), {
    type: 'error', stage: 'assign_job', win32Error: 5
  });
  assert.deepEqual(parseWindowsJobControlLine('CBJ 1 TERMINATED parent_death'), {
    type: 'terminated', reason: 'parent_death'
  });
  assert.throws(() => parseWindowsJobControlLine(`CBJ 1 HELLO ${'b'.repeat(64)}`, token), /token/);
  assert.throws(() => parseWindowsJobControlLine('CBJ 2 READY 1'), /version/);
  assert.throws(() => parseWindowsJobControlLine('CBJ 1 ERROR arbitrary_stage 5'), /unsupported/);
  assert.throws(() => parseWindowsJobControlLine(`CBJ 1 READY ${'1'.repeat(600)}`), /invalid/);
  assert.throws(() => parseWindowsJobControlLine('CBJ 1 READY 1\rforged'), /invalid/);
});

test('the discoverable control pipe address never embeds the HELLO authenticator', () => {
  const entropy = [Buffer.alloc(32, 0xaa), Buffer.alloc(32, 0xbb)];
  const credentials = createWindowsJobControlCredentials({
    randomBytesImpl: (size) => {
      assert.equal(size, 32);
      return entropy.shift();
    }
  });
  assert.equal(credentials.token, 'aa'.repeat(32));
  assert.match(credentials.pipeName, /bb{63}$/u);
  assert.equal(credentials.pipeName.includes(credentials.token), false);
  assert.throws(
    () => createWindowsJobControlCredentials({ randomBytesImpl: () => Buffer.alloc(32, 0xcc) }),
    /collided/
  );
});

test('the control pipe source derives its address from independent entropy', async () => {
  const source = await readFile(windowsSupervisorSource, 'utf8');
  assert.match(source, /const tokenBytes = randomBytesImpl\(32\);/u);
  assert.match(source, /const pipeIdentifierBytes = randomBytesImpl\(32\);/u);
  assert.match(source, /makePipeName\(pipeIdentifierBytes\.toString\('hex'\)\)/u);
  assert.doesNotMatch(source, /makePipeName\(token\)/u);
});

test('raw control bytes reject high-bit aliases and controls before ASCII decoding', () => {
  const highBitAlias = Buffer.concat([
    Buffer.from('CBJ 1 READY ', 'ascii'),
    Buffer.from([0xb1])
  ]);
  assert.equal(highBitAlias.toString('ascii'), 'CBJ 1 READY 1');
  assert.throws(() => parseWindowsJobControlBytes(highBitAlias), /invalid control record/);
  assert.throws(
    () => parseWindowsJobControlBytes(Buffer.from('CBJ 1 READY\t1', 'ascii')),
    /invalid control record/
  );
  assert.deepEqual(parseWindowsJobControlBytes(Buffer.from('CBJ 1 READY 1', 'ascii')), {
    type: 'ready', pid: 1
  });
});

test('terminal records resolve only after the helper closes with its matching process exit', () => {
  const providerSuccess = parseWindowsJobControlLine('CBJ 1 EXIT 0');
  const providerFailure = parseWindowsJobControlLine('CBJ 1 EXIT 7');
  const helperError = parseWindowsJobControlLine('CBJ 1 ERROR create_process 2');
  const terminated = parseWindowsJobControlLine('CBJ 1 TERMINATED timeout');

  assert.doesNotThrow(() => validateWindowsJobHelperClose(providerSuccess, 0, null));
  assert.doesNotThrow(() => validateWindowsJobHelperClose(providerFailure, 7, null));
  assert.doesNotThrow(() => validateWindowsJobHelperClose(helperError, 125, null));
  assert.doesNotThrow(() => validateWindowsJobHelperClose(terminated, 124, null));
  assert.throws(
    () => validateWindowsJobHelperClose(providerSuccess, 125, null),
    /close did not match/
  );
  assert.throws(
    () => validateWindowsJobHelperClose(providerSuccess, null, 'SIGKILL'),
    /close did not match/
  );
});

test('native source pins suspended pre-assignment launch, restricted inheritance, and Job close cleanup', async () => {
  const source = await readFile(windowsSource, 'utf8');
  assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(source, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(source, /CREATE_SUSPENDED/);
  assert.match(source, /cbj_is_absolute_application_path\(argv\[10\]\)/);
  assert.doesNotMatch(source, /cbj_is_unc_file_path|L"UNC\\\\"/);
  assert.match(source, /CreateProcessW\(\s*argv\[10\],/u);
  assert.doesNotMatch(source, /CreateProcessW\(\s*NULL,/u);
  assert.doesNotMatch(source, /CREATE_BREAKAWAY_FROM_JOB|JOB_OBJECT_LIMIT_(?:SILENT_)?BREAKAWAY_OK/);
  const create = source.indexOf('CreateProcessW(');
  const assign = source.indexOf('AssignProcessToJobObject(');
  const resume = source.indexOf('ResumeThread(');
  assert.ok(create !== -1 && assign > create && resume > assign);
});

async function windowsExecutableResolutionFixture() {
  const trusted = process.env.CODEX_BUDDY_TEST_WINDOWS_TRUSTED_EXECUTABLE;
  const decoy = process.env.CODEX_BUDDY_TEST_WINDOWS_DECOY_EXECUTABLE;
  assert.equal(typeof trusted, 'string', 'Windows CI must set CODEX_BUDDY_TEST_WINDOWS_TRUSTED_EXECUTABLE');
  assert.equal(typeof decoy, 'string', 'Windows CI must set CODEX_BUDDY_TEST_WINDOWS_DECOY_EXECUTABLE');
  const canonicalTrusted = await realpath(trusted);
  const canonicalDecoy = await realpath(decoy);
  const root = await temporaryDirectory('codex-buddy-windows-executable-resolution-');
  const searchedName = 'buddy-resolution-probe.exe';
  await copyFile(canonicalDecoy, path.join(root, searchedName));
  const marker = path.join(root, 'decoy-ran.txt');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH' && key.toUpperCase() !== 'PATHEXT')
  );
  env.PATH = path.dirname(canonicalTrusted);
  env.PATHEXT = '.CMD;.BAT;.PS1;.EXE';
  return { root, marker, env };
}

test('Windows direct spawn ignores a cwd executable collision and selects absolute PATH', {
  skip: process.platform !== 'win32'
}, async () => {
  const fixture = await windowsExecutableResolutionFixture();
  const result = await runProcess('buddy-resolution-probe', [fixture.marker], {
    cwd: fixture.root,
    env: fixture.env,
    protectFromParentDeath: false,
    timeoutMs: 10_000
  });
  assert.equal(result.stdout, 'trusted');
  await assert.rejects(access(fixture.marker));
});

test('Windows protected spawn pins provider identity before entering the Job helper', {
  skip: process.platform !== 'win32'
}, async () => {
  const fixture = await windowsExecutableResolutionFixture();
  const result = await runProcess('buddy-resolution-probe', [fixture.marker], {
    cwd: fixture.root,
    env: fixture.env,
    protectFromParentDeath: true,
    timeoutMs: 10_000
  });
  assert.equal(result.stdout, 'trusted');
  await assert.rejects(access(fixture.marker));
  await assert.rejects(
    runWindowsJobProcess('buddy-resolution-probe', [], { timeoutMs: 10_000 }),
    (error) => error.kind === 'invalid_arguments'
  );
});

test('runtime entrypoint rejects non-Windows hosts before creating a direct fallback', async () => {
  if (process.platform === 'win32') return;
  await assert.rejects(
    runWindowsJobProcess(process.execPath, ['--version']),
    (error) => error.kind === 'unsupported_platform'
  );
});

test('every provider adapter requires descendant containment for every external process', async () => {
  const expectedCalls = new Map([['claude', 1], ['grok', 2], ['ollama', 1], ['opencode', 1]]);
  for (const [provider, count] of expectedCalls) {
    const source = await readFile(path.join(repositoryRoot, 'src', 'providers', `${provider}.mjs`), 'utf8');
    assert.equal((source.match(/protectFromParentDeath:\s*true/gu) ?? []).length, count, provider);
    assert.doesNotMatch(source, /protectFromParentDeath:\s*false/, provider);
  }
});

test('Windows helper preserves exact argv, stdin, stdout, stderr, and provider exit code', {
  skip: process.platform !== 'win32'
}, async () => {
  const helperOptions = await runtimeHelperOptions();
  const argumentsToEcho = ['', 'two words', 'embedded"quote', 'trailing\\', 'snowman-☃'];
  const result = await runWindowsJobProcess(process.execPath, [
    path.join(fixtures, 'echo-provider.mjs'), ...argumentsToEcho
  ], {
    ...helperOptions,
    input: 'exact stdin\0with a NUL',
    timeoutMs: 10_000,
    acceptedExitCodes: [7]
  });
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, 'fixture stderr');
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: argumentsToEcho,
    stdin: 'exact stdin\0with a NUL'
  });
});

test('Windows deadline terminates a detached provider descendant tree', {
  skip: process.platform !== 'win32'
}, async () => {
  const helperOptions = await runtimeHelperOptions();
  const root = await temporaryDirectory('codex-buddy-windows-timeout-');
  const pidFile = path.join(root, 'pids.json');
  let pids = {};
  try {
    await assert.rejects(
      runWindowsJobProcess(process.execPath, [
        path.join(fixtures, 'process-tree-provider.mjs'), pidFile, 'wait'
      ], { ...helperOptions, timeoutMs: 5_000 }),
      /exceeded its 5000 ms deadline/
    );
    pids = await waitForJson(pidFile);
    for (const pid of Object.values(pids)) assert.equal(await processIsGone(pid), true, `${pid} survived`);
  } finally {
    await forceFixtureCleanup(Object.values(pids));
  }
});

test('Windows output limits terminate the whole provider Job', {
  skip: process.platform !== 'win32'
}, async () => {
  const helperOptions = await runtimeHelperOptions();
  const root = await temporaryDirectory('codex-buddy-windows-output-limit-');
  const pidFile = path.join(root, 'pids.json');
  let pids = {};
  try {
    await assert.rejects(
      runWindowsJobProcess(process.execPath, [
        path.join(fixtures, 'process-tree-provider.mjs'), pidFile, 'flood'
      ], { ...helperOptions, timeoutMs: 10_000, maxOutputBytes: 1_024 }),
      /stdout exceeded 1024 bytes/
    );
    pids = await waitForJson(pidFile);
    for (const pid of Object.values(pids)) assert.equal(await processIsGone(pid), true, `${pid} survived`);
  } finally {
    await forceFixtureCleanup(Object.values(pids));
  }
});

test('Windows Job treats an intentional early stdin close as a controlled process result', {
  skip: process.platform !== 'win32'
}, async () => {
  const helperOptions = await runtimeHelperOptions();
  const result = await runWindowsJobProcess(process.execPath, ['-e', 'process.exit(0)'], {
    ...helperOptions,
    input: 'x'.repeat(8 * 1024 * 1024),
    timeoutMs: 10_000
  });
  assert.equal(result.code, 0);
});

test('Windows natural provider exit kills descendants instead of leaving stdout handles or work behind', {
  skip: process.platform !== 'win32'
}, async () => {
  const helperOptions = await runtimeHelperOptions();
  const root = await temporaryDirectory('codex-buddy-windows-leader-exit-');
  const pidFile = path.join(root, 'pids.json');
  let pids = {};
  try {
    const result = await runWindowsJobProcess(process.execPath, [
      path.join(fixtures, 'process-tree-provider.mjs'), pidFile, 'exit_after_tree'
    ], { ...helperOptions, timeoutMs: 10_000 });
    assert.equal(result.code, 0);
    pids = await waitForJson(pidFile);
    for (const pid of Object.values(pids)) assert.equal(await processIsGone(pid), true, `${pid} survived`);
  } finally {
    await forceFixtureCleanup(Object.values(pids));
  }
});

test('Windows non-catchable caller death closes control IPC and kills the provider Job', {
  skip: process.platform !== 'win32'
}, async () => {
  const helperOptions = await runtimeHelperOptions();
  const root = await temporaryDirectory('codex-buddy-windows-parent-death-');
  const pidFile = path.join(root, 'pids.json');
  const harness = spawn(process.execPath, [
    path.join(fixtures, 'parent-harness.mjs'),
    helperOptions.helperManifestFile,
    helperOptions.helperRoot,
    path.join(fixtures, 'process-tree-provider.mjs'),
    pidFile
  ], { stdio: 'ignore', windowsHide: true });
  let pids = {};
  try {
    pids = await waitForJson(pidFile);
    process.kill(harness.pid, 'SIGKILL');
    await new Promise((resolve) => harness.once('close', resolve));
    for (const pid of Object.values(pids)) assert.equal(await processIsGone(pid), true, `${pid} survived`);
  } finally {
    if (harness.exitCode === null && harness.signalCode === null) {
      try { process.kill(harness.pid, 'SIGKILL'); } catch {}
    }
    await forceFixtureCleanup(Object.values(pids));
  }
});

test('Windows helper death closes the last Job handle and kills every Job member', {
  skip: process.platform !== 'win32'
}, async () => {
  const helperOptions = await runtimeHelperOptions();
  const root = await temporaryDirectory('codex-buddy-windows-helper-death-');
  const pidFile = path.join(root, 'pids.json');
  let pids = {};
  const running = runWindowsJobProcess(process.execPath, [
    path.join(fixtures, 'process-tree-provider.mjs'), pidFile, 'wait'
  ], { ...helperOptions, timeoutMs: 60_000 });
  try {
    pids = await waitForJson(pidFile);
    process.kill(pids.supervisor, 'SIGKILL');
    await assert.rejects(running, /helper|control/i);
    for (const [name, pid] of Object.entries(pids)) {
      if (name === 'supervisor') continue;
      assert.equal(await processIsGone(pid), true, `${name} ${pid} survived`);
    }
  } finally {
    await running.catch(() => {});
    await forceFixtureCleanup(Object.values(pids));
  }
});

test('Windows Job refuses an explicit CREATE_BREAKAWAY_FROM_JOB child', {
  skip: process.platform !== 'win32'
}, async () => {
  const helperOptions = await runtimeHelperOptions();
  const probe = process.env.CODEX_BUDDY_TEST_WINDOWS_BREAKAWAY_PROBE;
  assert.equal(typeof probe, 'string', 'Windows CI must set CODEX_BUDDY_TEST_WINDOWS_BREAKAWAY_PROBE');
  await access(probe);
  const result = await runWindowsJobProcess(probe, [process.execPath], {
    ...helperOptions,
    timeoutMs: 10_000
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'breakaway_denied');
});
