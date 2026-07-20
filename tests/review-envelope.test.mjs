import assert from 'node:assert/strict';
import test from 'node:test';

import { validateReviewWithSummaryAdvisoryEnvelope } from '../src/review-schema.mjs';

test('summary review envelope requires exactly its two isolated result channels', () => {
  const valid = {
    technical_review: { schema_version: '2' },
    summary_advisory: { schema_version: '1' }
  };
  assert.equal(validateReviewWithSummaryAdvisoryEnvelope(valid), valid);

  for (const invalid of [
    null,
    [],
    { technical_review: valid.technical_review },
    { summary_advisory: valid.summary_advisory },
    { ...valid, promoted_finding: { severity: 'blocker' } }
  ]) {
    assert.throws(
      () => validateReviewWithSummaryAdvisoryEnvelope(invalid),
      /review-with-summary response/
    );
  }
});
