import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  createPrivacyFragmentSalt,
  matchesPrivacyFragments,
  privacyFragmentFingerprints,
  sharesPrivacyFragment
} from '../src/privacy-fragments.mjs';

function fixture(prefix, count = 180) {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index}=value_${index}_with_unique_material;`).join('\n');
}

function deterministicAscii(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
  let state = 0x6d2b79f5;
  let value = '';
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    value += alphabet[state >>> 0 & 63];
  }
  return value;
}

test('salted content-defined fragments catch long subsets across whitespace and line-ending changes', () => {
  const salt = createPrivacyFragmentSalt();
  const denied = fixture('private');
  const subset = denied.split('\n').slice(40, 140).join('\r\n  ');
  const deniedIndex = privacyFragmentFingerprints(Buffer.from(denied), salt);
  const candidate = privacyFragmentFingerprints(Buffer.from(`safe_prefix();\n${subset}\nsafe_suffix();`), salt);
  assert.equal(deniedIndex.complete, true);
  assert.equal(candidate.complete, true);
  assert.equal(sharesPrivacyFragment(candidate.fingerprints, new Set(deniedIndex.fingerprints)), true);
});

test('short denied values match at every alignment without exposing their bytes', () => {
  const salt = createPrivacyFragmentSalt();
  const secret = 'TOKEN=café-secret-42';
  const denied = privacyFragmentFingerprints(Buffer.from(secret), salt);
  assert.equal(denied.complete, true);
  assert.equal(denied.shortFingerprints.length, 1);
  assert.match(denied.shortFingerprints[0], /^[1-9][0-9]{0,2}:[0-9a-f]{32}$/);
  assert.doesNotMatch(denied.shortFingerprints[0], /café|secret|TOKEN/u);

  const variants = [
    `${secret}const suffix = true;`,
    `const prefix = true;${secret}const suffix = true;`,
    `const prefix = true;${secret}`,
    'const prefix = true; TOKEN = cafe\u0301 - secret - 42; const suffix = true;'
  ];
  for (const candidate of variants) {
    assert.deepEqual(
      matchesPrivacyFragments(Buffer.from(candidate), salt, {
        fingerprints: new Set(denied.fingerprints),
        shortFingerprints: new Set(denied.shortFingerprints)
      }),
      { complete: true, matches: true },
      candidate
    );
  }
});

test('substantial values copied from short denied records match without their field prefix', () => {
  const salt = createPrivacyFragmentSalt();
  const value = `private-${'x'.repeat(48)}`;
  const denied = privacyFragmentFingerprints(Buffer.from(`TOKEN=${value}\n`), salt);
  assert.equal(denied.complete, true);
  assert.equal(denied.fingerprints.length, 0);
  assert.equal(denied.shortFingerprints.length > 1, true);
  assert.deepEqual(matchesPrivacyFragments(
    Buffer.from(`export const copied = '${value}';\n`),
    salt,
    {
      fingerprints: new Set(denied.fingerprints),
      shortFingerprints: new Set(denied.shortFingerprints)
    }
  ), { complete: true, matches: true });
});

test('long denied sources match when copied inside boundary-changing wrappers', () => {
  const salt = createPrivacyFragmentSalt();
  const deniedText = fixture('protected', 36);
  const denied = privacyFragmentFingerprints(Buffer.from(deniedText), salt);
  const wrapper = Buffer.from(`const prefix = 'boundary shift';\n${deniedText}\nconst suffix = true;\n`);

  assert.equal(denied.complete, true);
  assert.equal(denied.shortFingerprints.length > 0, true);
  assert.deepEqual(matchesPrivacyFragments(wrapper, salt, {
    fingerprints: new Set(denied.fingerprints),
    shortFingerprints: new Set(denied.shortFingerprints)
  }), { complete: true, matches: true });
});

test('32 to 127 byte excerpts match long denied sources at every alignment', () => {
  const salt = createPrivacyFragmentSalt();
  const deniedText = fixture('protected', 24);
  const normalizedExcerpt = deniedText.replace(/\s/gu, '').slice(73, 137);
  const denied = privacyFragmentFingerprints(Buffer.from(deniedText), salt);

  assert.equal(Buffer.byteLength(normalizedExcerpt), 64);
  assert.deepEqual(matchesPrivacyFragments(
    Buffer.from(`prefix_${normalizedExcerpt}_suffix`),
    salt,
    {
      fingerprints: new Set(denied.fingerprints),
      shortFingerprints: new Set(denied.shortFingerprints)
    }
  ), { complete: true, matches: true });
});

test('exhaustive long-source windows fail closed when their capacity is exceeded', () => {
  const salt = createPrivacyFragmentSalt();
  assert.deepEqual(
    privacyFragmentFingerprints(Buffer.from(fixture('protected', 10)), salt, { maxShortFragments: 2 }),
    { complete: false, fingerprints: [], shortFingerprints: [] }
  );
});

test('default short-window capacity covers ordinary denied sources beyond the former 8192-entry ceiling', () => {
  const salt = createPrivacyFragmentSalt();
  const source = deterministicAscii(65_567);
  const denied = privacyFragmentFingerprints(Buffer.from(source), salt);

  assert.equal(denied.complete, true);
  assert.equal(denied.fingerprints.length > 0, true);
  assert.equal(denied.shortFingerprints.length, 65_536);

  const copiedExcerpt = source.slice(40_000, 40_096);
  assert.deepEqual(matchesPrivacyFragments(
    Buffer.from(`const copied = '${copiedExcerpt}';`),
    salt,
    {
      fingerprints: new Set(denied.fingerprints),
      shortFingerprints: new Set(denied.shortFingerprints)
    }
  ), { complete: true, matches: true });

  assert.deepEqual(
    privacyFragmentFingerprints(Buffer.from(`${source}x`), salt),
    { complete: false, fingerprints: [], shortFingerprints: [] }
  );
});

test('retained 256-bit short fingerprints remain matchable after compact fingerprints are introduced', () => {
  const salt = createPrivacyFragmentSalt();
  const secret = 'TOKEN=legacy-private-value';
  const normalized = Buffer.from(secret.replace(/\s/gu, ''), 'utf8');
  const legacyFingerprint = `${normalized.length}:${createHmac('sha256', Buffer.from(salt, 'hex'))
    .update('buddy-privacy-short-fragment-v1\0')
    .update(String(normalized.length))
    .update('\0')
    .update(normalized)
    .digest('hex')}`;

  assert.deepEqual(matchesPrivacyFragments(
    Buffer.from(`const copied = '${secret}';`),
    salt,
    { fingerprints: new Set(), shortFingerprints: new Set([legacyFingerprint]) }
  ), { complete: true, matches: true });

  const compact = privacyFragmentFingerprints(Buffer.from('TOKEN=compact-private-value'), salt);
  const mixed = new Set([legacyFingerprint, ...compact.shortFingerprints]);
  assert.deepEqual(matchesPrivacyFragments(
    Buffer.from('const copied = "TOKEN=compact-private-value";'),
    salt,
    { fingerprints: new Set(), shortFingerprints: mixed }
  ), { complete: true, matches: true });
});

test('short unrelated boilerplate remains reviewable', () => {
  const salt = createPrivacyFragmentSalt();
  const denied = privacyFragmentFingerprints(Buffer.from('TOKEN=private-value'), salt);
  const unrelated = Buffer.from('const shared = true;\n');
  assert.equal(privacyFragmentFingerprints(unrelated, salt).shortFingerprints.length, 1);
  assert.deepEqual(matchesPrivacyFragments(unrelated, salt, {
    fingerprints: new Set(denied.fingerprints),
    shortFingerprints: new Set(denied.shortFingerprints)
  }), { complete: true, matches: false });
});

test('fragment fingerprints are turn-salted and oversized inputs fail closed', () => {
  const content = Buffer.from(fixture('private'));
  const first = privacyFragmentFingerprints(content, createPrivacyFragmentSalt());
  const second = privacyFragmentFingerprints(content, createPrivacyFragmentSalt());
  assert.notDeepEqual(first.fingerprints, second.fingerprints);
  assert.deepEqual(
    privacyFragmentFingerprints(content, createPrivacyFragmentSalt(), { maxBytes: 16 }),
    { complete: false, fingerprints: [], shortFingerprints: [] }
  );
});

test('unsupported text and bounded short-match limits fail closed', () => {
  const salt = createPrivacyFragmentSalt();
  assert.deepEqual(
    privacyFragmentFingerprints(Buffer.from([0xff, 0xfe, 0xfd]), salt),
    { complete: false, fingerprints: [], shortFingerprints: [] }
  );

  const first = privacyFragmentFingerprints(Buffer.from('TOKEN=one'), salt);
  const second = privacyFragmentFingerprints(Buffer.from('TOKEN=two'), salt);
  const inventory = {
    fingerprints: new Set(),
    shortFingerprints: new Set([...first.shortFingerprints, ...second.shortFingerprints])
  };
  assert.deepEqual(
    matchesPrivacyFragments(Buffer.from('const safe = true;'), salt, inventory, { maxShortFragments: 1 }),
    { complete: false, matches: false }
  );
  assert.deepEqual(
    matchesPrivacyFragments(Buffer.from('a'.repeat(80)), salt, {
      fingerprints: new Set(),
      shortFingerprints: new Set(first.shortFingerprints)
    }, { maxShortMatchWork: 2 }),
    { complete: false, matches: false }
  );
  assert.deepEqual(
    matchesPrivacyFragments(Buffer.from([0xff]), salt, inventory),
    { complete: false, matches: false }
  );
});
