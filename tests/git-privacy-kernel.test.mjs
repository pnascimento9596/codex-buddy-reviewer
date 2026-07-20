import assert from 'node:assert/strict';
import test from 'node:test';

import {
  excludedRenameDestinations,
  parseGitIndexEntries,
  parseGitNameStatus,
  parseGitTreeEntry,
  splitNull
} from '../src/git-privacy-kernel.mjs';

test('Git NUL path fields decode only after a lossless UTF-8 check', () => {
  assert.deepEqual(
    splitNull(Buffer.from('src/caf\u00e9.mjs\0docs/readme.md\0')),
    ['src/caf\u00e9.mjs', 'docs/readme.md']
  );

  assert.throws(
    () => splitNull(Buffer.from([0x73, 0x72, 0x63, 0x2f, 0xff, 0x2e, 0x6d, 0x6a, 0x73, 0x00])),
    (error) => error?.failureCode === 'git_path_encoding_invalid'
      && /lossless UTF-8/.test(error.message)
  );

  assert.deepEqual(splitNull(Buffer.from('src/\ufffd.mjs\0')), ['src/\ufffd.mjs']);
  assert.throws(
    () => splitNull(Buffer.from('missing-final-nul')),
    (error) => error?.failureCode === 'git_path_parse_incomplete'
  );
});

test('rename and copy records preserve raw pathname identity until validation', () => {
  assert.deepEqual(
    [...excludedRenameDestinations(Buffer.from('R100\0.env\0config.mjs\0'))],
    ['config.mjs']
  );

  assert.throws(
    () => excludedRenameDestinations(Buffer.from([0x52, 0x31, 0x30, 0x30, 0x00, 0x2e, 0x65, 0x6e, 0x76, 0x00, 0xff, 0x00])),
    (error) => error?.failureCode === 'git_path_encoding_invalid'
  );
});

test('structured Git record parsers validate metadata and path bytes independently', () => {
  assert.deepEqual(parseGitIndexEntries(Buffer.from(
    `100644 ${'a'.repeat(40)} 0\tsrc/caf\u00e9.mjs\0`
  )), [{ mode: '100644', objectId: 'a'.repeat(40), stage: '0', path: 'src/caf\u00e9.mjs' }]);

  assert.deepEqual(parseGitTreeEntry(Buffer.from(
    `100644 blob ${'b'.repeat(40)}\tsrc/caf\u00e9.mjs\0`
  ), 'src/caf\u00e9.mjs'), {
    mode: '100644', type: 'blob', objectId: 'b'.repeat(40), path: 'src/caf\u00e9.mjs'
  });

  assert.deepEqual(parseGitNameStatus(Buffer.from('C87\0.env\0config.mjs\0')), [{
    status: 'C87', source: '.env', destination: 'config.mjs'
  }]);

  assert.throws(
    () => parseGitIndexEntries(Buffer.concat([
      Buffer.from(`100644 ${'a'.repeat(40)} 0\tbad-`), Buffer.from([0xff, 0x00])
    ])),
    (error) => error?.failureCode === 'git_path_encoding_invalid'
  );
  assert.throws(
    () => parseGitTreeEntry(Buffer.from(`100644 blob ${'b'.repeat(40)}\tother.mjs\0`), 'expected.mjs'),
    (error) => error?.failureCode === 'git_path_parse_incomplete'
  );
  assert.throws(
    () => parseGitNameStatus(Buffer.from('R100\0only-source\0')),
    (error) => error?.failureCode === 'git_path_parse_incomplete'
  );
});
