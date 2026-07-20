import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  installPet,
  petStatus,
  reconcilePetTransactions,
  removePet,
  restorePet,
  updatePet
} from '../src/pet-catalog.mjs';
import {
  beginPetTransaction,
  readPetTransactions,
  recordPetTransactionStep
} from '../src/pet-transactions.mjs';

const temporaryPaths = [];
const definitions = [
  ['buddy-byte', 'Byte', 'public'],
  ['buddy-mochi', 'Mochi', 'public'],
  ['buddy-orbit', 'Orbit', 'public'],
  ['buddy-bella', 'Bella', 'public'],
  ['buddy-lupo', 'Lupo', 'public']
];

test.after(async () => {
  await Promise.all(temporaryPaths.map((item) => rm(item, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(target));
    else output.push(target);
  }
  return output;
}

async function fixtureCatalog() {
  const root = await temporaryDirectory('codex-buddy-pet-transactions-');
  const catalogRoot = path.join(root, 'catalog');
  const codexHome = path.join(root, 'codex');
  const dataDir = path.join(root, 'state');
  await mkdir(catalogRoot, { recursive: true });
  const sprite = Buffer.from('fixture-v2-spritesheet-v1');
  const pets = [];
  for (const [id, displayName, scope] of definitions) {
    const directory = path.join(catalogRoot, id);
    await mkdir(directory, { recursive: true });
    const description = `${displayName} fixture pet.`;
    const available = id === 'buddy-byte';
    const manifest = {
      id,
      displayName,
      description,
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp'
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(directory, 'pet.json'), manifestBytes);
    await writeJson(path.join(directory, 'provenance.json'), {
      schema_version: '1',
      pet_id: id,
      scope,
      status: available ? 'validated' : 'awaiting-v2-artwork',
      redistribution: scope === 'private' ? 'private-only' : available ? 'cleared' : 'not-cleared',
      binary_asset_present: available,
      notes: 'Test fixture.'
    });
    if (available) await writeFile(path.join(directory, 'spritesheet.webp'), sprite);
    pets.push({
      id,
      displayName,
      description,
      scope,
      spriteVersionNumber: 2,
      available,
      notReadyReason: available ? null : 'Fixture asset is not ready.',
      manifestPath: `./${id}/pet.json`,
      manifestSha256: hash(manifestBytes),
      spritesheetPath: `./${id}/spritesheet.webp`,
      provenancePath: `./${id}/provenance.json`,
      spritesheetSha256: available ? hash(sprite) : null
    });
  }
  const catalogFile = path.join(catalogRoot, 'catalog.json');
  await writeJson(catalogFile, { schema_version: '1', pets });
  return { root, catalogRoot, catalogFile, codexHome, dataDir, sprite };
}

async function replaceByteSprite(fixture, bytes) {
  await writeFile(path.join(fixture.catalogRoot, 'buddy-byte', 'spritesheet.webp'), bytes);
  const catalog = JSON.parse(await readFile(fixture.catalogFile, 'utf8'));
  catalog.pets.find((pet) => pet.id === 'buddy-byte').spritesheetSha256 = hash(bytes);
  await writeJson(fixture.catalogFile, catalog);
}

async function transactionDirectories(dataDir) {
  const files = await filesBelow(dataDir);
  const stepFiles = new Set([
    '00-intent.json',
    '10-filesystem-committed.json',
    '20-registry-committed.json',
    '30-complete.json'
  ]);
  return [...new Set(files
    .filter((file) => stepFiles.has(path.basename(file)))
    .map((file) => path.dirname(file)))].sort();
}

async function transactionForOperation(dataDir, operation) {
  for (const directory of await transactionDirectories(dataDir)) {
    const intentFile = path.join(directory, '00-intent.json');
    const intent = JSON.parse(await readFile(intentFile, 'utf8'));
    if (intent.payload.intent.operation === operation) return { directory, intent };
  }
  return null;
}

async function interruptUpdateAfterBackupMove(fixture, updatedSprite) {
  await installPet('buddy-byte', fixture);
  await replaceByteSprite(fixture, updatedSprite);
  const childFile = path.join(fixture.root, 'interrupt-update.mjs');
  const moduleUrl = new URL('../src/pet-catalog.mjs', import.meta.url).href;
  await writeFile(childFile, `
import { rename } from 'node:fs/promises';
import { updatePet } from ${JSON.stringify(moduleUrl)};
const options = JSON.parse(process.argv[2]);
let calls = 0;
await updatePet('buddy-byte', {
  ...options,
  renamePath: async (source, destination) => {
    calls += 1;
    const result = await rename(source, destination);
    if (calls === 1) process.exit(91);
    return result;
  }
});
`);
  const child = spawn(process.execPath, [childFile, JSON.stringify({
    catalogFile: fixture.catalogFile,
    codexHome: fixture.codexHome,
    dataDir: fixture.dataDir
  })], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 91, signal: null }, stderr);

  const staleClaims = (await filesBelow(fixture.dataDir)).filter(
    (file) => path.basename(path.dirname(file)) === 'installed.json.lock'
      && /^claim-.+\.json$/.test(path.basename(file))
  );
  assert.equal(staleClaims.length, 1);
  await utimes(staleClaims[0], new Date(0), new Date(0));

  const transaction = await transactionForOperation(fixture.dataDir, 'update');
  assert.ok(transaction);
  const intent = transaction.intent.payload.intent;
  await assert.rejects(access(intent.target));
  await access(intent.backup.path);
  return { transaction, intent };
}

test('transaction steps are immutable, ordered, and use exact step filenames', async () => {
  const root = await temporaryDirectory('codex-buddy-journal-');
  const homeDataDir = path.join(root, 'home');
  const transaction = await beginPetTransaction({ homeDataDir, intent: { operation: 'fixture' } });
  await assert.rejects(
    recordPetTransactionStep(transaction, 'registry_committed', { registry: '/fixture' }),
    /before filesystem_committed/
  );
  await recordPetTransactionStep(transaction, 'filesystem_committed', { target: '/target', backup: null });
  await recordPetTransactionStep(transaction, 'filesystem_committed', { target: '/target', backup: null });
  await assert.rejects(
    recordPetTransactionStep(transaction, 'filesystem_committed', { target: '/different', backup: null }),
    /immutable/
  );
  await recordPetTransactionStep(transaction, 'registry_committed', { registry: '/fixture' });
  await recordPetTransactionStep(transaction, 'complete', { outcome: 'complete', reason: 'fixture' });
  assert.deepEqual((await readdir(transaction.directory)).sort(), [
    '00-intent.json',
    '10-filesystem-committed.json',
    '20-registry-committed.json',
    '30-complete.json'
  ]);
  const [loaded] = await readPetTransactions({ homeDataDir });
  assert.equal(loaded.status, 'complete');
});

test('install writes all immutable transaction steps and preserves registry schema v1', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  const transaction = await transactionForOperation(fixture.dataDir, 'install');
  assert.ok(transaction);
  assert.deepEqual((await readdir(transaction.directory)).sort(), [
    '00-intent.json',
    '10-filesystem-committed.json',
    '20-registry-committed.json',
    '30-complete.json'
  ]);
  const registryFile = (await filesBelow(fixture.dataDir)).find(
    (file) => path.basename(file) === 'installed.json'
  );
  const registry = JSON.parse(await readFile(registryFile, 'utf8'));
  assert.equal(registry.schema_version, '1');
  assert.equal(registry.installed['buddy-byte'].spritesheet_sha256, hash(fixture.sprite));
});

test('exact filesystem hashes deterministically reconcile an interrupted install registry write', async () => {
  const fixture = await fixtureCatalog();
  await assert.rejects(
    installPet('buddy-byte', {
      ...fixture,
      writeRegistry: async () => { throw new Error('injected registry failure'); }
    }),
    /rerun install to reconcile/
  );
  const pending = await transactionForOperation(fixture.dataDir, 'install');
  assert.deepEqual((await readdir(pending.directory)).sort(), [
    '00-intent.json',
    '10-filesystem-committed.json'
  ]);
  const reconciled = await reconcilePetTransactions(fixture);
  assert.equal(reconciled.transactions.some((item) => item.outcome === 'complete'), true);
  assert.deepEqual((await readdir(pending.directory)).sort(), [
    '00-intent.json',
    '10-filesystem-committed.json',
    '20-registry-committed.json',
    '30-complete.json'
  ]);
  assert.equal((await petStatus(fixture)).pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'installed');
});

test('remove and restore reruns reconcile preserved exact packages without repeating filesystem moves', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  await assert.rejects(
    removePet('buddy-byte', {
      ...fixture,
      writeRegistry: async () => { throw new Error('injected remove registry failure'); }
    }),
    /recovery path/
  );
  const removed = await removePet('buddy-byte', fixture);
  assert.equal(removed.action, 'removed_to_backup');
  await assert.rejects(access(removed.target));
  assert.deepEqual(await readFile(path.join(removed.backup, 'spritesheet.webp')), fixture.sprite);

  await assert.rejects(
    restorePet(removed.backupId, {
      ...fixture,
      writeRegistry: async () => { throw new Error('injected restore registry failure'); }
    }),
    /restored package was preserved/
  );
  const restored = await restorePet(removed.backupId, fixture);
  assert.equal(restored.action, 'restored');
  assert.deepEqual(await readFile(path.join(restored.target, 'spritesheet.webp')), fixture.sprite);
  await assert.rejects(access(removed.backup));
});

test('ambiguous package state is terminalized as needs_attention and is never overwritten', async () => {
  const fixture = await fixtureCatalog();
  await assert.rejects(installPet('buddy-byte', {
    ...fixture,
    writeRegistry: async () => { throw new Error('injected registry failure'); }
  }));
  const target = path.join(fixture.codexHome, 'pets', 'buddy-byte');
  await writeFile(path.join(target, 'spritesheet.webp'), 'external modification');
  const reconciled = await reconcilePetTransactions(fixture);
  const result = reconciled.transactions.find((item) => item.operation === 'install');
  assert.equal(result.outcome, 'needs_attention');
  const transaction = await transactionForOperation(fixture.dataDir, 'install');
  const complete = JSON.parse(await readFile(path.join(transaction.directory, '30-complete.json'), 'utf8'));
  assert.equal(complete.payload.outcome, 'needs_attention');
  await assert.rejects(installPet('buddy-byte', fixture), /needs_attention/);
  assert.equal(await readFile(path.join(target, 'spritesheet.webp'), 'utf8'), 'external modification');
});

test('update publishes exact new hashes and keeps an exact rollback backup', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  const updatedSprite = Buffer.from('fixture-v2-spritesheet-v2');
  await replaceByteSprite(fixture, updatedSprite);
  const updated = await updatePet('buddy-byte', fixture);
  assert.equal(updated.action, 'updated');
  assert.deepEqual(
    await readFile(path.join(updated.target, 'spritesheet.webp')),
    updatedSprite
  );
  assert.deepEqual(await readFile(path.join(updated.backup, 'spritesheet.webp')), fixture.sprite);
  const status = await petStatus(fixture);
  assert.equal(status.pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'installed');
  assert.equal(status.backups.some((backup) => backup.backupId === updated.backupId), true);
  const transaction = await transactionForOperation(fixture.dataDir, 'update');
  assert.deepEqual((await readdir(transaction.directory)).sort(), [
    '00-intent.json',
    '10-filesystem-committed.json',
    '20-registry-committed.json',
    '30-complete.json'
  ]);
});

test('interrupted update registry write reconciles only when target and rollback hashes are exact', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  const updatedSprite = Buffer.from('fixture-v2-spritesheet-v3');
  await replaceByteSprite(fixture, updatedSprite);
  await assert.rejects(
    updatePet('buddy-byte', {
      ...fixture,
      writeRegistry: async () => { throw new Error('injected registry failure'); }
    }),
    /rollback backup.*rerun update to reconcile/
  );
  const recovered = await updatePet('buddy-byte', fixture);
  assert.equal(recovered.action, 'updated');
  assert.deepEqual(await readFile(path.join(recovered.target, 'spritesheet.webp')), updatedSprite);
  assert.deepEqual(await readFile(path.join(recovered.backup, 'spritesheet.webp')), fixture.sprite);
  assert.equal((await petStatus(fixture)).backups.some((backup) => backup.backupId === recovered.backupId), true);
});

test('update restores the original exact package when publication fails before commit', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  await replaceByteSprite(fixture, Buffer.from('fixture-v2-spritesheet-v4'));
  let calls = 0;
  const renamePath = async (source, destination) => {
    calls += 1;
    if (calls === 2) throw new Error('injected publish failure');
    return rename(source, destination);
  };
  await assert.rejects(
    updatePet('buddy-byte', { ...fixture, renamePath }),
    /original package was restored/
  );
  const target = path.join(fixture.codexHome, 'pets', 'buddy-byte');
  assert.deepEqual(await readFile(path.join(target, 'spritesheet.webp')), fixture.sprite);
  const transaction = await transactionForOperation(fixture.dataDir, 'update');
  assert.deepEqual((await readdir(transaction.directory)).sort(), [
    '00-intent.json',
    '30-complete.json'
  ]);
  const complete = JSON.parse(await readFile(path.join(transaction.directory, '30-complete.json'), 'utf8'));
  assert.equal(complete.payload.outcome, 'rolled_back');
  await access(target);
});

test('interrupted update reconciliation restores an exact backup through safe ancestors', async () => {
  const fixture = await fixtureCatalog();
  const { intent } = await interruptUpdateAfterBackupMove(
    fixture,
    Buffer.from('fixture-v2-spritesheet-safe-recovery')
  );

  const reconciled = await reconcilePetTransactions(fixture);
  const result = reconciled.transactions.find((item) => item.operation === 'update');
  assert.equal(result.outcome, 'rolled_back');
  assert.equal(result.reason, 'interrupted_update_exact_backup_restored');
  assert.deepEqual(await readFile(path.join(intent.target, 'spritesheet.webp')), fixture.sprite);
  await assert.rejects(access(intent.backup.path));
});

test('interrupted update reconciliation rejects a symlinked backup ancestor without moving the package', async () => {
  const fixture = await fixtureCatalog();
  const { transaction, intent } = await interruptUpdateAfterBackupMove(
    fixture,
    Buffer.from('fixture-v2-spritesheet-unsafe-recovery')
  );
  const backupsRoot = path.dirname(path.dirname(intent.backup.path));
  const externalRoot = path.join(fixture.root, 'external-backups');
  const relativeBackup = path.relative(backupsRoot, intent.backup.path);
  await rename(backupsRoot, externalRoot);
  await symlink(externalRoot, backupsRoot);
  const externalBackup = path.join(externalRoot, relativeBackup);
  const before = await readFile(path.join(externalBackup, 'spritesheet.webp'));

  const reconciled = await reconcilePetTransactions(fixture);
  const result = reconciled.transactions.find((item) => item.operation === 'update');
  assert.equal(result.outcome, 'needs_attention');
  assert.equal(result.reason, 'unsafe_transaction_paths');
  await assert.rejects(access(intent.target));
  assert.deepEqual(await readFile(path.join(externalBackup, 'spritesheet.webp')), before);
  const complete = JSON.parse(await readFile(path.join(transaction.directory, '30-complete.json'), 'utf8'));
  assert.equal(complete.payload.outcome, 'needs_attention');
  assert.equal(complete.payload.reason, 'unsafe_transaction_paths');
});

test('interrupted update reconciliation rejects a non-directory backup ancestor without moving the package', async () => {
  const fixture = await fixtureCatalog();
  const { transaction, intent } = await interruptUpdateAfterBackupMove(
    fixture,
    Buffer.from('fixture-v2-spritesheet-nondirectory-recovery')
  );
  const backupsRoot = path.dirname(path.dirname(intent.backup.path));
  const externalRoot = path.join(fixture.root, 'external-backups-nondirectory');
  const relativeBackup = path.relative(backupsRoot, intent.backup.path);
  await rename(backupsRoot, externalRoot);
  await writeFile(backupsRoot, 'not a directory');
  const externalBackup = path.join(externalRoot, relativeBackup);
  const before = await readFile(path.join(externalBackup, 'spritesheet.webp'));

  const reconciled = await reconcilePetTransactions(fixture);
  const result = reconciled.transactions.find((item) => item.operation === 'update');
  assert.equal(result.outcome, 'needs_attention');
  assert.equal(result.reason, 'unsafe_transaction_paths');
  await assert.rejects(access(intent.target));
  assert.deepEqual(await readFile(path.join(externalBackup, 'spritesheet.webp')), before);
  const complete = JSON.parse(await readFile(path.join(transaction.directory, '30-complete.json'), 'utf8'));
  assert.equal(complete.payload.outcome, 'needs_attention');
  assert.equal(complete.payload.reason, 'unsafe_transaction_paths');
});

test('transaction journals are isolated by canonical Codex home', async () => {
  const fixture = await fixtureCatalog();
  const alternate = { ...fixture, codexHome: path.join(fixture.root, 'alternate-codex') };
  await installPet('buddy-byte', fixture);
  await installPet('buddy-byte', alternate);
  const intentFiles = (await filesBelow(fixture.dataDir)).filter(
    (file) => path.basename(file) === '00-intent.json'
  );
  const homeRoots = new Set(intentFiles.map(
    (file) => path.dirname(path.dirname(path.dirname(file)))
  ));
  assert.equal(homeRoots.size, 2);
});
