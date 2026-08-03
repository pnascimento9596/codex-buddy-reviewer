#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePetProvenance } from '../src/pet-catalog.mjs';
import { escapeDiagnosticLine } from '../src/policy.mjs';

export const DEFAULT_PET_CATALOG = fileURLToPath(new URL('../assets/pets/catalog.json', import.meta.url));
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXPECTED_WIDTH = 1536;
const EXPECTED_HEIGHT = 2288;
const GRID_COLUMNS = 8;
const GRID_ROWS = 11;

function fail(message) {
  throw new Error(`Buddy atlas validation: ${message}`);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function plainBytes(file, label) {
  const details = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') fail(`${label} is missing`);
    throw error;
  });
  if (details.isSymbolicLink() || !details.isFile()) fail(`${label} must be a regular non-symlink file`);
  return readFile(file);
}

function parseVp8l(bytes, offset, length) {
  if (length < 5 || bytes[offset] !== 0x2f) fail('VP8L chunk has an invalid signature or header length');
  const bits = bytes.readUInt32LE(offset + 1);
  const version = (bits >>> 29) & 0x7;
  if (version !== 0) fail(`VP8L chunk uses unsupported version ${version}`);
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
    alpha_used: Boolean((bits >>> 28) & 1)
  };
}

function parseVp8(bytes, offset, length) {
  if (length < 10 || bytes[offset + 3] !== 0x9d || bytes[offset + 4] !== 0x01 || bytes[offset + 5] !== 0x2a) {
    fail('VP8 chunk has an invalid key-frame header');
  }
  return {
    width: bytes.readUInt16LE(offset + 6) & 0x3fff,
    height: bytes.readUInt16LE(offset + 8) & 0x3fff,
    alpha_used: false
  };
}

function parseVp8x(bytes, offset, length) {
  if (length !== 10) fail('VP8X chunk must contain exactly 10 bytes');
  return {
    width: 1 + bytes.readUIntLE(offset + 4, 3),
    height: 1 + bytes.readUIntLE(offset + 7, 3),
    alpha_used: Boolean(bytes[offset] & 0x10),
    animated: Boolean(bytes[offset] & 0x02)
  };
}

export function inspectWebpStructure(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20) fail('WebP file is too short');
  if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') {
    fail('file is not a RIFF/WEBP container');
  }
  const declaredLength = bytes.readUInt32LE(4) + 8;
  if (declaredLength !== bytes.length) fail(`RIFF length ${declaredLength} does not match file length ${bytes.length}`);
  const chunks = [];
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail('truncated WebP chunk header');
    const type = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = bytes.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + length;
    const paddedEnd = payloadEnd + (length & 1);
    if (payloadEnd > bytes.length || paddedEnd > bytes.length) fail(`chunk ${type} exceeds the RIFF boundary`);
    chunks.push({ type, length, payloadOffset });
    offset = paddedEnd;
  }
  if (offset !== bytes.length) fail('WebP chunk walk did not end at the RIFF boundary');

  const vp8xChunks = chunks.filter((item) => item.type === 'VP8X');
  const imageChunks = chunks.filter((item) => item.type === 'VP8' || item.type === 'VP8L');
  if (vp8xChunks.length > 1 || imageChunks.length !== 1) fail('WebP atlas must contain one image bitstream and at most one VP8X canvas');
  if (chunks.some((item) => item.type === 'ANIM' || item.type === 'ANMF')) fail('animated WebP containers are not supported as sprite atlases');

  const imageChunk = imageChunks[0];
  const image = imageChunk.type === 'VP8L'
    ? parseVp8l(bytes, imageChunk.payloadOffset, imageChunk.length)
    : parseVp8(bytes, imageChunk.payloadOffset, imageChunk.length);
  const canvas = vp8xChunks.length
    ? parseVp8x(bytes, vp8xChunks[0].payloadOffset, vp8xChunks[0].length)
    : image;
  if (canvas.animated) fail('animated VP8X canvas is not supported as a sprite atlas');
  if (vp8xChunks.length && (canvas.width !== image.width || canvas.height !== image.height)) {
    fail('VP8X canvas dimensions disagree with the image bitstream');
  }
  return {
    width: canvas.width,
    height: canvas.height,
    alpha_used: canvas.alpha_used || image.alpha_used,
    image_encoding: imageChunk.type,
    chunks: chunks.map((item) => item.type)
  };
}

function inside(root, relative, label) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) fail(`${label} must be a relative path`);
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail(`${label} escapes the catalog root`);
  return resolved;
}

export async function validatePetAtlases(catalogFile = DEFAULT_PET_CATALOG) {
  const canonicalCatalog = await realpath(path.resolve(catalogFile)).catch((error) => {
    if (error.code === 'ENOENT') fail('catalog is missing');
    throw error;
  });
  const root = path.dirname(canonicalCatalog);
  let catalog;
  try {
    catalog = JSON.parse((await plainBytes(canonicalCatalog, 'catalog')).toString('utf8'));
  } catch (error) {
    if (error.message.startsWith('Buddy atlas validation:')) throw error;
    fail('catalog is not valid JSON');
  }
  if (catalog.schema_version !== '1' || !Array.isArray(catalog.pets) || !catalog.pets.length) fail('catalog has an unsupported schema');
  const results = [];
  const ids = new Set();
  for (const entry of catalog.pets) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || ids.has(entry.id)) fail('catalog contains an invalid or duplicate pet id');
    ids.add(entry.id);
    if (entry.available !== true || entry.spriteVersionNumber !== 2 || !SHA256_PATTERN.test(entry.manifestSha256)
        || !SHA256_PATTERN.test(entry.spritesheetSha256)) fail(`${entry.id} is not a hash-pinned available V2 package`);
    const manifestFile = inside(root, entry.manifestPath, `${entry.id} manifestPath`);
    const spritesheetFile = inside(root, entry.spritesheetPath, `${entry.id} spritesheetPath`);
    const provenanceFile = inside(root, entry.provenancePath, `${entry.id} provenancePath`);
    for (const [file, label] of [[manifestFile, 'manifest'], [spritesheetFile, 'spritesheet'], [provenanceFile, 'provenance']]) {
      if (await realpath(file) !== file) fail(`${entry.id} ${label} uses a symlinked path component`);
    }
    const manifestBytes = await plainBytes(manifestFile, `${entry.id} manifest`);
    const spritesheetBytes = await plainBytes(spritesheetFile, `${entry.id} spritesheet`);
    const provenanceBytes = await plainBytes(provenanceFile, `${entry.id} provenance`);
    if (hash(manifestBytes) !== entry.manifestSha256 || hash(spritesheetBytes) !== entry.spritesheetSha256) {
      fail(`${entry.id} package bytes do not match the catalog hashes`);
    }
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const provenance = JSON.parse(provenanceBytes.toString('utf8'));
    if (manifest.id !== entry.id || manifest.spriteVersionNumber !== 2 || manifest.spritesheetPath !== 'spritesheet.webp') {
      fail(`${entry.id} manifest does not describe the expected V2 spritesheet`);
    }
    validatePetProvenance(provenance, entry, { requirePublicRights: true });
    const structure = inspectWebpStructure(spritesheetBytes);
    if (structure.width !== EXPECTED_WIDTH || structure.height !== EXPECTED_HEIGHT
        || structure.width % GRID_COLUMNS !== 0 || structure.height % GRID_ROWS !== 0) {
      fail(`${entry.id} atlas is not the exact ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT} ${GRID_COLUMNS}x${GRID_ROWS} grid`);
    }
    if (!structure.alpha_used) fail(`${entry.id} atlas does not declare alpha usage`);
    results.push({
      id: entry.id,
      scope: entry.scope,
      width: structure.width,
      height: structure.height,
      columns: GRID_COLUMNS,
      rows: GRID_ROWS,
      cell_width: structure.width / GRID_COLUMNS,
      cell_height: structure.height / GRID_ROWS,
      image_encoding: structure.image_encoding,
      chunks: structure.chunks,
      spritesheet_sha256: entry.spritesheetSha256
    });
  }
  return {
    schema_version: '1',
    validation_scope: 'container-structure-and-catalog-integrity',
    full_pixel_decode: false,
    pet_count: results.length,
    pets: results
  };
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const unsupported = args.find((arg) => !['--json', '--help', '-h'].includes(arg));
    if (unsupported !== undefined) throw new Error(`unsupported atlas argument: ${unsupported}`);
    if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write('Usage: validate-pet-atlases.mjs [--json]\n');
      return;
    }
    const result = await validatePetAtlases();
    process.stdout.write(args.includes('--json')
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Buddy atlas structure: ${result.pet_count} hash-pinned V2 packages passed (container structure only; no full pixel decode).\n`);
  } catch (error) {
    process.stderr.write(`${escapeDiagnosticLine(error?.message ?? error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
