import assert from 'node:assert/strict';
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
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  installPet,
  listPets,
  loadPetCatalog,
  petStatus,
  PUBLIC_PET_LICENSE_GRANT,
  removePet,
  restorePet,
  validatePetProvenance
} from '../src/pet-catalog.mjs';
import { parsePetArgs, renderPetCommand, runPetCommand } from '../src/pet-cli.mjs';

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

function fixturePublicRights(id, spritesheetSha256) {
  return {
    rights: {
      basis: 'original-project-asset',
      rights_holder_role: 'project-owner',
      authorization: {
        status: 'recorded',
        date: null,
        date_status: 'not-recorded',
        source: 'project-original-asset-record',
        source_reference: 'docs/PROVENANCE.md#pet-asset-rights-records'
      },
      license: {
        spdx_expression: 'Apache-2.0',
        repository_license_file: 'LICENSE',
        grant: PUBLIC_PET_LICENSE_GRANT
      }
    },
    asset_lineage: {
      source_asset: {
        description: `${id} fixture source asset.`,
        sha256: null,
        sha256_status: 'not-recorded'
      },
      transformation: {
        method: 'Test fixture atlas assembly',
        tool: null,
        tool_status: 'not-recorded',
        date: null,
        date_status: 'not-recorded',
        first_repository_recorded_on: '2026-07-18'
      },
      derived_asset: {
        path: 'spritesheet.webp',
        sha256: spritesheetSha256
      }
    }
  };
}

function webpDimensions(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + length > bytes.length) return null;
    if (type === 'VP8X' && length >= 10) {
      return {
        width: 1 + bytes.readUIntLE(payload + 4, 3),
        height: 1 + bytes.readUIntLE(payload + 7, 3)
      };
    }
    if (type === 'VP8L' && length >= 5 && bytes[payload] === 0x2f) {
      return {
        width: 1 + bytes[payload + 1] + ((bytes[payload + 2] & 0x3f) << 8),
        height:
          1 +
          (bytes[payload + 2] >> 6) +
          (bytes[payload + 3] << 2) +
          ((bytes[payload + 4] & 0x0f) << 10)
      };
    }
    if (
      type === 'VP8 ' &&
      length >= 10 &&
      bytes[payload + 3] === 0x9d &&
      bytes[payload + 4] === 0x01 &&
      bytes[payload + 5] === 0x2a
    ) {
      return {
        width: bytes.readUInt16LE(payload + 6) & 0x3fff,
        height: bytes.readUInt16LE(payload + 8) & 0x3fff
      };
    }
    offset += 8 + length + (length % 2);
  }
  return null;
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

async function fixtureCatalog(options = {}) {
  const root = await temporaryDirectory('codex-buddy-pets-');
  const catalogRoot = path.join(root, 'catalog');
  const codexHome = path.join(root, 'codex');
  const dataDir = path.join(root, 'state');
  await mkdir(catalogRoot, { recursive: true });
  const sprite = Buffer.from('fixture-v2-spritesheet-bytes');
  const availableId = options.availableId ?? 'buddy-byte';
  const pets = [];
  for (const [id, displayName, scope] of definitions) {
    const directory = path.join(catalogRoot, id);
    await mkdir(directory, { recursive: true });
    const description = `${displayName} fixture pet.`;
    const available = id === availableId;
    const manifest = {
      id,
      displayName,
      description,
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp'
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const spritesheetSha256 = available ? hash(sprite) : null;
    await writeFile(path.join(directory, 'pet.json'), manifestBytes);
    await writeJson(path.join(directory, 'provenance.json'), {
      schema_version: '1',
      pet_id: id,
      scope,
      status: available ? 'validated' : 'awaiting-v2-artwork',
      redistribution: scope === 'private' ? 'private-only' : available ? 'cleared' : 'not-cleared',
      binary_asset_present: available,
      ...(scope === 'public' && available ? fixturePublicRights(id, spritesheetSha256) : {}),
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
      spritesheetSha256
    });
  }
  const catalogFile = path.join(catalogRoot, 'catalog.json');
  await writeJson(catalogFile, { schema_version: '1', pets });
  return { root, catalogRoot, catalogFile, codexHome, dataDir, sprite };
}

test('checked-in catalog exposes exactly five public, validated V2 entries with cleared provenance', async () => {
  const pets = await listPets();
  const catalog = await loadPetCatalog();
  assert.deepEqual(pets.map((pet) => pet.id), definitions.map(([id]) => id));
  assert.equal(pets.every((pet) => pet.spriteVersionNumber === 2), true);
  assert.equal(pets.every((pet) => pet.available === true && pet.notReadyReason === null), true);
  assert.equal(pets.every((pet) => pet.scope === 'public'), true);
  assert.equal(catalog.pets.every((pet) => pet.provenance.redistribution === 'cleared'), true);
  assert.equal(catalog.pets.every((pet) => pet.provenance.rights.license.grant === PUBLIC_PET_LICENSE_GRANT), true);
  assert.equal(catalog.pets.every((pet) => (
    pet.provenance.asset_lineage.derived_asset.sha256 === pet.spritesheetSha256
  )), true);

  for (const pet of catalog.pets) {
    const lineage = pet.provenance.asset_lineage;
    assert.equal(lineage.source_asset.sha256, null, pet.id);
    assert.equal(lineage.source_asset.sha256_status, 'not-recorded', pet.id);
    assert.equal(lineage.transformation.tool, null, pet.id);
    assert.equal(lineage.transformation.tool_status, 'not-recorded', pet.id);
    assert.equal(lineage.transformation.date, null, pet.id);
    assert.equal(lineage.transformation.date_status, 'not-recorded', pet.id);
    assert.equal(lineage.transformation.first_repository_recorded_on, '2026-07-18', pet.id);
  }

  for (const id of ['buddy-bella', 'buddy-lupo']) {
    const provenance = catalog.pets.find((pet) => pet.id === id).provenance;
    assert.equal(provenance.rights.basis, 'source-asset-owner-attestation', id);
    assert.equal(provenance.rights.rights_holder_role, 'project-owner-and-source-asset-owner', id);
    assert.equal(provenance.rights.authorization.source, 'project-owner-attestation', id);
    assert.equal(provenance.rights.authorization.date, '2026-07-19', id);
  }
});

test('checked-in Byte package installs without claiming native selection or wake control', async () => {
  const root = await temporaryDirectory('codex-buddy-checked-in-');
  const result = await installPet('buddy-byte', {
    codexHome: path.join(root, 'codex'),
    dataDir: path.join(root, 'state')
  });
  assert.equal(result.action, 'installed');
  const output = await runPetCommand(['list']);
  assert.match(renderPetCommand(output), /No pet was selected or woken/);
});

test('checked-in spritesheets are exact 1536x2288 extended WebP atlases', async () => {
  const catalog = await loadPetCatalog();
  for (const pet of catalog.pets) {
    const bytes = await readFile(pet.spritesheetFile);
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF', pet.id);
    assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP', pet.id);
    assert.deepEqual(webpDimensions(bytes), { width: 1536, height: 2288 }, pet.id);
  }
});

test('catalog rejects path escapes before reading an external file', async () => {
  const fixture = await fixtureCatalog();
  const raw = JSON.parse(await readFile(fixture.catalogFile, 'utf8'));
  raw.pets[0].manifestPath = '../outside.json';
  await writeJson(fixture.catalogFile, raw);
  await assert.rejects(loadPetCatalog({ catalogFile: fixture.catalogFile }), /escapes the catalog root/);
});

test('catalog refuses an available public asset without cleared provenance', async () => {
  const fixture = await fixtureCatalog();
  const provenanceFile = path.join(fixture.catalogRoot, 'buddy-byte', 'provenance.json');
  const provenance = JSON.parse(await readFile(provenanceFile, 'utf8'));
  provenance.redistribution = 'not-cleared';
  await writeJson(provenanceFile, provenance);
  await assert.rejects(
    loadPetCatalog({ catalogFile: fixture.catalogFile }),
    /available public asset provenance redistribution must be cleared/
  );
});

test('catalog rejects tampered public pet rights and derived-asset evidence', async (t) => {
  await t.test('unsupported catalog scope cannot bypass public rights', () => {
    assert.throws(
      () => validatePetProvenance({ schema_version: '1' }, {
        id: 'buddy-byte',
        scope: 'shared',
        available: true
      }, { requirePublicRights: true }),
      /entry scope must be public or private/
    );
  });

  await t.test('exact Apache-2.0 grant', async () => {
    const fixture = await fixtureCatalog();
    const provenanceFile = path.join(fixture.catalogRoot, 'buddy-byte', 'provenance.json');
    const provenance = JSON.parse(await readFile(provenanceFile, 'utf8'));
    provenance.rights.license.grant = 'Public redistribution allowed.';
    await writeJson(provenanceFile, provenance);
    await assert.rejects(
      loadPetCatalog({ catalogFile: fixture.catalogFile }),
      /rights license grant does not match the public grant/
    );
  });

  await t.test('catalog-bound derived atlas hash', async () => {
    const fixture = await fixtureCatalog();
    const provenanceFile = path.join(fixture.catalogRoot, 'buddy-byte', 'provenance.json');
    const provenance = JSON.parse(await readFile(provenanceFile, 'utf8'));
    provenance.asset_lineage.derived_asset.sha256 = '0'.repeat(64);
    await writeJson(provenanceFile, provenance);
    await assert.rejects(
      loadPetCatalog({ catalogFile: fixture.catalogFile }),
      /derived_asset SHA-256 does not match the catalog/
    );
  });

  await t.test('owner attestation date', async () => {
    const fixture = await fixtureCatalog();
    const provenanceFile = path.join(fixture.catalogRoot, 'buddy-byte', 'provenance.json');
    const provenance = JSON.parse(await readFile(provenanceFile, 'utf8'));
    provenance.rights.basis = 'source-asset-owner-attestation';
    provenance.rights.rights_holder_role = 'project-owner-and-source-asset-owner';
    provenance.rights.authorization.source = 'project-owner-attestation';
    await writeJson(provenanceFile, provenance);
    await assert.rejects(
      loadPetCatalog({ catalogFile: fixture.catalogFile }),
      /source-asset owner authorization date must be recorded/
    );
  });

  for (const basis of ['__proto__', 'constructor', 'unknown-rights-basis']) {
    await t.test(`unsupported rights basis ${basis}`, async () => {
      const fixture = await fixtureCatalog();
      const provenanceFile = path.join(fixture.catalogRoot, 'buddy-byte', 'provenance.json');
      const provenance = JSON.parse(await readFile(provenanceFile, 'utf8'));
      provenance.rights.basis = basis;
      await writeJson(provenanceFile, provenance);
      await assert.rejects(
        loadPetCatalog({ catalogFile: fixture.catalogFile }),
        /rights basis is unsupported/
      );
    });
  }

  await t.test('unknown identity field', async () => {
    const fixture = await fixtureCatalog();
    const provenanceFile = path.join(fixture.catalogRoot, 'buddy-byte', 'provenance.json');
    const provenance = JSON.parse(await readFile(provenanceFile, 'utf8'));
    provenance.rights.owner_identity = 'private-owner';
    await writeJson(provenanceFile, provenance);
    await assert.rejects(
      loadPetCatalog({ catalogFile: fixture.catalogFile }),
      /rights contains unsupported field owner_identity/
    );
  });

  await t.test('unknown root identity field', async () => {
    const fixture = await fixtureCatalog();
    const provenanceFile = path.join(fixture.catalogRoot, 'buddy-byte', 'provenance.json');
    const provenance = JSON.parse(await readFile(provenanceFile, 'utf8'));
    provenance.owner_identity = 'private-owner';
    await writeJson(provenanceFile, provenance);
    await assert.rejects(
      loadPetCatalog({ catalogFile: fixture.catalogFile }),
      /provenance contains unsupported field owner_identity/
    );
  });

  for (const localPath of ['/private/example-source.png', 'D:\\example-source.png']) {
    await t.test(`unknown local path field ${localPath[0]}`, async () => {
      const fixture = await fixtureCatalog();
      const provenanceFile = path.join(fixture.catalogRoot, 'buddy-byte', 'provenance.json');
      const provenance = JSON.parse(await readFile(provenanceFile, 'utf8'));
      provenance.asset_lineage.source_asset.local_path = localPath;
      await writeJson(provenanceFile, provenance);
      await assert.rejects(
        loadPetCatalog({ catalogFile: fixture.catalogFile }),
        /source_asset contains unsupported field local_path/
      );
    });
  }
});

test('catalog rejects package files reached through a symlinked directory', async () => {
  const fixture = await fixtureCatalog();
  const packageDirectory = path.join(fixture.catalogRoot, 'buddy-byte');
  const external = path.join(fixture.root, 'external-byte');
  await rename(packageDirectory, external);
  await symlink(external, packageDirectory);
  await assert.rejects(loadPetCatalog({ catalogFile: fixture.catalogFile }), /must not use symlinked path components/);
});

test('catalog pins and closes the exact manifest bytes', async () => {
  const fixture = await fixtureCatalog();
  const manifestFile = path.join(fixture.catalogRoot, 'buddy-byte', 'pet.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.unexpected = true;
  await writeJson(manifestFile, manifest);
  await assert.rejects(loadPetCatalog({ catalogFile: fixture.catalogFile }), /unsupported or missing fields/);
});

test('install is atomic and idempotent and leaves non-Buddy pets untouched', async () => {
  const fixture = await fixtureCatalog();
  const unrelated = path.join(fixture.codexHome, 'pets', 'bella');
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, 'owner.txt'), 'user-owned');

  const first = await installPet('buddy-byte', fixture);
  assert.equal(first.action, 'installed');
  const target = path.join(fixture.codexHome, 'pets', 'buddy-byte');
  assert.deepEqual((await readdir(target)).sort(), ['pet.json', 'spritesheet.webp']);
  assert.deepEqual(await readFile(path.join(target, 'spritesheet.webp')), fixture.sprite);

  const second = await installPet('buddy-byte', fixture);
  assert.equal(second.action, 'already_installed');
  assert.equal(await readFile(path.join(unrelated, 'owner.txt'), 'utf8'), 'user-owned');
});

test('one data directory keeps ownership isolated across alternate Codex homes', async () => {
  const fixture = await fixtureCatalog();
  const alternateHome = path.join(fixture.root, 'alternate-codex');
  const alternate = { ...fixture, codexHome: alternateHome };
  await installPet('buddy-byte', fixture);
  await installPet('buddy-byte', alternate);
  assert.equal((await petStatus(fixture)).pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'installed');
  assert.equal((await petStatus(alternate)).pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'installed');
  await removePet('buddy-byte', fixture);
  assert.equal((await petStatus(fixture)).pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'not_installed');
  assert.equal((await petStatus(alternate)).pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'installed');
  assert.deepEqual(
    await readFile(path.join(alternateHome, 'pets', 'buddy-byte', 'spritesheet.webp')),
    fixture.sprite
  );
});

test('symlink aliases of one Codex home share one ownership registry and lock domain', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  const aliasHome = path.join(fixture.root, 'codex-alias');
  await symlink(fixture.codexHome, aliasHome);
  const alias = { ...fixture, codexHome: aliasHome };
  const reconciled = await installPet('buddy-byte', alias);
  assert.equal(reconciled.action, 'already_installed');
  assert.equal(
    (await filesBelow(path.join(fixture.dataDir, 'pets', 'homes')))
      .filter((file) => file.endsWith('/installed.json')).length,
    1
  );
  await removePet('buddy-byte', alias);
  assert.equal((await petStatus(fixture)).pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'not_installed');
  assert.equal((await petStatus(alias)).pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'not_installed');
});

test('install preserves its published package when registry persistence fails', async () => {
  const fixture = await fixtureCatalog();
  await assert.rejects(
    installPet('buddy-byte', {
      ...fixture,
      writeRegistry: async () => { throw new Error('injected registry failure'); }
    }),
    /installed package was preserved.*rerun install/
  );
  const target = path.join(fixture.codexHome, 'pets', 'buddy-byte');
  assert.deepEqual(await readFile(path.join(target, 'spritesheet.webp')), fixture.sprite);
  const reconciled = await installPet('buddy-byte', fixture);
  assert.equal(reconciled.action, 'already_installed');
  assert.equal((await petStatus(fixture)).pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'installed');
});

test('install rejects a differing target without overwriting it', async () => {
  const fixture = await fixtureCatalog();
  const target = path.join(fixture.codexHome, 'pets', 'buddy-byte');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'pet.json'), 'different manifest');
  await writeFile(path.join(target, 'spritesheet.webp'), 'different sprite');
  await assert.rejects(installPet('buddy-byte', fixture), /refusing to overwrite differing target/);
  assert.equal(await readFile(path.join(target, 'spritesheet.webp'), 'utf8'), 'different sprite');
});

test('install rejects a symlink target and never follows it', async () => {
  const fixture = await fixtureCatalog();
  const petsRoot = path.join(fixture.codexHome, 'pets');
  const outside = path.join(fixture.root, 'outside');
  await mkdir(petsRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'marker'), 'safe');
  await symlink(outside, path.join(petsRoot, 'buddy-byte'));
  await assert.rejects(installPet('buddy-byte', fixture), /symbolic link/);
  assert.equal(await readFile(path.join(outside, 'marker'), 'utf8'), 'safe');
});

test('installer rejects a symlinked private-state directory', async () => {
  const fixture = await fixtureCatalog();
  const outside = path.join(fixture.root, 'outside-state');
  await mkdir(fixture.dataDir, { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(fixture.dataDir, 'pets'));
  await assert.rejects(
    installPet('buddy-byte', fixture),
    /private-state path must be a non-symlink directory/
  );
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(access(path.join(fixture.codexHome, 'pets', 'buddy-byte')));
});

test('owned remove creates a recoverable backup and restore is hash-safe', async () => {
  const fixture = await fixtureCatalog();
  const unrelated = path.join(fixture.codexHome, 'pets', 'custom-cat');
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, 'marker'), 'untouched');
  await installPet('buddy-byte', fixture);

  const removed = await removePet('buddy-byte', fixture);
  await assert.rejects(access(removed.target));
  assert.deepEqual(await readFile(path.join(removed.backup, 'spritesheet.webp')), fixture.sprite);
  assert.equal(await readFile(path.join(unrelated, 'marker'), 'utf8'), 'untouched');

  const restored = await restorePet(removed.backupId, fixture);
  assert.equal(restored.id, 'buddy-byte');
  assert.deepEqual(await readFile(path.join(restored.target, 'spritesheet.webp')), fixture.sprite);
  assert.equal(await readFile(path.join(unrelated, 'marker'), 'utf8'), 'untouched');
});

test('remove and restore preserve explicit recovery paths when registry persistence fails', async () => {
  const removeFixture = await fixtureCatalog();
  await installPet('buddy-byte', removeFixture);
  let removeError;
  try {
    await removePet('buddy-byte', {
      ...removeFixture,
      writeRegistry: async () => { throw new Error('injected registry failure'); }
    });
  } catch (error) {
    removeError = error;
  }
  assert.match(removeError?.message ?? '', /preserved at recovery path .*do not delete/);
  await assert.rejects(access(path.join(removeFixture.codexHome, 'pets', 'buddy-byte')));
  const recoveryRoot = path.join(removeFixture.codexHome, 'pets', '.buddy-reviewer-backups', 'buddy-byte');
  const [recoveryId] = await readdir(recoveryRoot);
  assert.deepEqual(await readFile(path.join(recoveryRoot, recoveryId, 'spritesheet.webp')), removeFixture.sprite);

  const restoreFixture = await fixtureCatalog();
  await installPet('buddy-byte', restoreFixture);
  const removed = await removePet('buddy-byte', restoreFixture);
  await assert.rejects(
    restorePet(removed.backupId, {
      ...restoreFixture,
      writeRegistry: async () => { throw new Error('injected registry failure'); }
    }),
    /restored package was preserved.*do not delete/
  );
  assert.deepEqual(await readFile(path.join(restoreFixture.codexHome, 'pets', 'buddy-byte', 'spritesheet.webp')), restoreFixture.sprite);
  await assert.rejects(access(removed.backup));
});

test('rejected unowned removal does not create a backup directory', async () => {
  const fixture = await fixtureCatalog();
  await assert.rejects(removePet('buddy-byte', fixture), /not recorded as a Buddy-owned installation/);
  await assert.rejects(access(path.join(fixture.codexHome, 'pets', '.buddy-reviewer-backups')));
});

test('remove refuses a symlinked backup root without moving the owned pet', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  const petsRoot = path.join(fixture.codexHome, 'pets');
  const target = path.join(petsRoot, 'buddy-byte');
  const outside = path.join(fixture.root, 'outside-backups');
  await mkdir(outside);
  await symlink(outside, path.join(petsRoot, '.buddy-reviewer-backups'));

  await assert.rejects(removePet('buddy-byte', fixture), /backups directory must be a non-symlink directory/);
  assert.deepEqual(await readFile(path.join(target, 'spritesheet.webp')), fixture.sprite);
  assert.deepEqual(await readdir(outside), []);
});

test('remove refuses modified owned content and restore refuses a modified backup', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  const target = path.join(fixture.codexHome, 'pets', 'buddy-byte');
  await writeFile(path.join(target, 'spritesheet.webp'), 'user modification');
  await assert.rejects(removePet('buddy-byte', fixture), /refusing to remove modified or unsafe target/);
  assert.equal(await readFile(path.join(target, 'spritesheet.webp'), 'utf8'), 'user modification');

  await rm(target, { recursive: true });
  await installPet('buddy-byte', fixture);
  const removed = await removePet('buddy-byte', fixture);
  await writeFile(path.join(removed.backup, 'spritesheet.webp'), 'backup modification');
  await assert.rejects(restorePet(removed.backupId, fixture), /refusing to restore modified or unsafe backup/);
});

test('non-Buddy ids are rejected before any pet target is touched', async () => {
  const fixture = await fixtureCatalog();
  await assert.rejects(installPet('bella', fixture), /unknown or non-Buddy pet id/);
  await assert.rejects(removePet('../buddy-byte', fixture), /unknown or non-Buddy pet id/);
  await assert.rejects(access(path.join(fixture.codexHome, 'pets')));
});

test('pet status distinguishes installed, modified, and missing packages', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  let status = await petStatus(fixture);
  assert.equal(status.pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'installed');
  const target = path.join(fixture.codexHome, 'pets', 'buddy-byte');
  await writeFile(path.join(target, 'spritesheet.webp'), 'changed');
  status = await petStatus(fixture);
  assert.equal(status.pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'modified');
  await rm(target, { recursive: true });
  status = await petStatus(fixture);
  assert.equal(status.pets.find((pet) => pet.id === 'buddy-byte').installStatus, 'missing');
});

test('malformed registry backup paths are rejected before path operations', async () => {
  const fixture = await fixtureCatalog();
  await installPet('buddy-byte', fixture);
  const registryFile = (await filesBelow(fixture.dataDir)).find((file) => file.endsWith('/installed.json'));
  assert.ok(registryFile);
  const registry = JSON.parse(await readFile(registryFile, 'utf8'));
  const backupId = `1700000000000-00000000-0000-4000-8000-000000000000`;
  registry.backups.push({
    backup_id: backupId,
    id: 'buddy-byte',
    scope: 'public',
    path: null,
    original_target: path.join(fixture.codexHome, 'pets', 'buddy-byte'),
    manifest_sha256: '0'.repeat(64),
    spritesheet_sha256: '0'.repeat(64),
    removed_at: new Date().toISOString()
  });
  await writeJson(registryFile, registry);
  await assert.rejects(restorePet(backupId, fixture), /backups\[0\]\.path must be a non-empty string/);
});

test('pet CLI grammar is strictly allowlisted and has no select action', async () => {
  assert.deepEqual(parsePetArgs([]), { action: 'list', identifier: null, json: false });
  assert.equal(parsePetArgs(['install', 'buddy-byte', '--json']).identifier, 'buddy-byte');
  assert.equal(parsePetArgs(['update', 'buddy-byte']).identifier, 'buddy-byte');
  assert.equal(parsePetArgs(['reconcile']).action, 'reconcile');
  assert.throws(() => parsePetArgs(['select', 'buddy-byte']), /action must be/);
  assert.throws(() => parsePetArgs(['install']), /requires an identifier/);
  assert.throws(() => parsePetArgs(['status', 'extra']), /unknown pet argument/);
  assert.throws(() => parsePetArgs(['list', '--catalog', '/tmp/catalog.json']), /unknown pet argument/);
  assert.equal(parsePetArgs(['install', '--help']).help, true);
  assert.throws(() => parsePetArgs(['install', 'buddy-byte', '--codex-home', '']), /requires a non-empty path value/);
  assert.throws(() => parsePetArgs(['install', 'buddy-byte', '--data-dir', '-h']), /requires a non-empty path value/);
});
