import assert from 'node:assert/strict';
import test from 'node:test';

import { renderContinuation } from '../src/lifecycle.mjs';

function result() {
  return {
    schema_version: '2',
    status: 'no_findings',
    summary: 'No validated defects.',
    findings: [],
    comments: []
  };
}

test('continuation exposes only bounded provider cleanup warnings', () => {
  const review = result();
  const rendered = renderContinuation({
    reviewKey: 'a'.repeat(64),
    output: {
      provider: 'grok',
      model: 'grok-4.5',
      result: review,
      reviews: [{
        source_index: 0,
        provider: 'grok',
        model: 'grok-4.5',
        result: review,
        run: {
          cleanup_status: 'failed',
          cleanup_error: 'SECRET raw cleanup diagnostic',
          cleanup_path: '/private/tmp/provider-prompt'
        }
      }],
      failures: [],
      sources: null,
      summaryAdvisory: null
    }
  });

  const lines = rendered.split('\n');
  const start = lines.findIndex((line) => line.endsWith('_START'));
  const payload = JSON.parse(lines[start + 1]);
  assert.deepEqual(payload.operational_warnings, [{
    source_index: 0,
    provider: 'grok',
    model: 'grok-4.5',
    code: 'temporary_state_cleanup_failed'
  }]);
  assert.doesNotMatch(rendered, /SECRET|provider-prompt|cleanup_error|cleanup_path/);
});

test('continuation omits cleanup warnings after normal cleanup', () => {
  const review = result();
  const rendered = renderContinuation({
    reviewKey: 'b'.repeat(64),
    output: {
      provider: 'claude',
      model: 'claude-opus-4-8',
      result: review,
      reviews: [{
        source_index: 0,
        provider: 'claude',
        model: 'claude-opus-4-8',
        result: review,
        run: null
      }],
      failures: [],
      sources: null,
      summaryAdvisory: null
    }
  });
  const lines = rendered.split('\n');
  const start = lines.findIndex((line) => line.endsWith('_START'));
  const payload = JSON.parse(lines[start + 1]);
  assert.deepEqual(payload.operational_warnings, []);
});
