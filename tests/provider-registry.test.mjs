import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approveProviderReviewRequest,
  dispatchProviderReview,
  getProviderDefinition,
  inspectApprovedProviderReviewRequest,
  supportedProviderIds,
  validateProviderEffort
} from '../src/provider-registry.mjs';

const RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {},
  required: []
});

test('provider registry enumerates exactly the supported provider IDs', () => {
  const providers = supportedProviderIds();
  assert.deepEqual(providers, ['claude', 'grok', 'ollama', 'opencode']);
  assert.equal(Object.isFrozen(providers), true);
  assert.throws(() => providers.push('unknown'), TypeError);
});

test('provider definitions and defaults are immutable', () => {
  const expected = {
    claude: ['claude-opus-4-8', 'high'],
    grok: ['grok-4.5', 'high'],
    ollama: ['glm-5.2:cloud', 'high'],
    opencode: ['openai/gpt-5.6', 'high']
  };
  for (const provider of supportedProviderIds()) {
    const definition = getProviderDefinition(provider);
    assert.deepEqual(
      [definition.id, definition.defaultModel, definition.defaultEffort],
      [provider, ...expected[provider]]
    );
    assert.deepEqual(
      definition.supportedEfforts,
      provider === 'ollama'
        ? ['low', 'medium', 'high']
        : ['low', 'medium', 'high', 'xhigh', 'max']
    );
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.supportedEfforts), true);
    assert.throws(() => {
      definition.defaultModel = 'substituted-model';
    }, TypeError);
  }
  assert.equal(getProviderDefinition('claude'), getProviderDefinition('claude'));
});

test('unknown providers fail before review options are inspected', () => {
  let inspected = false;
  const options = new Proxy({}, {
    get() {
      inspected = true;
      throw new Error('options must not be inspected');
    }
  });
  assert.throws(
    () => approveProviderReviewRequest('unknown', options),
    /Unsupported review provider/
  );
  assert.equal(inspected, false);
  assert.throws(() => getProviderDefinition('CLAUDE'), /Unsupported review provider/);
  assert.throws(() => getProviderDefinition(' claude '), /Unsupported review provider/);
});

test('dispatch validates provider-specific effort before invoking an adapter', async () => {
  const common = {
    root: process.cwd(),
    prompt: 'bounded review packet',
    model: 'provider/model',
    effort: 'high',
    timeoutMs: 1_000,
    responseSchema: RESPONSE_SCHEMA
  };

  assert.throws(
    () => approveProviderReviewRequest('claude', { ...common, effort: 'unsupported' }),
    /claude review effort must be/
  );
  assert.throws(
    () => approveProviderReviewRequest('grok', { ...common, responseSchema: null }),
    /response schema must be an object or undefined/
  );
  for (const effort of ['xhigh', 'max', 'unsupported']) {
    assert.throws(
      () => approveProviderReviewRequest('ollama', { ...common, effort }),
      /ollama review effort must be one of: low, medium, high/
    );
  }
  for (const effort of ['low', 'medium', 'high']) {
    assert.equal(validateProviderEffort('ollama', effort), effort);
  }
  for (const effort of ['xhigh', 'max']) {
    assert.equal(validateProviderEffort('claude', effort), effort);
    assert.equal(validateProviderEffort('grok', effort), effort);
    assert.equal(validateProviderEffort('opencode', effort), effort);
  }
  const invalidOpenCode = approveProviderReviewRequest('opencode', {
    ...common,
    model: 'missing-provider'
  });
  assert.throws(
    () => dispatchProviderReview(invalidOpenCode, { platform: 'win32' }),
    /Live reviewer contact is disabled on Windows/
  );
  await assert.rejects(
    dispatchProviderReview(invalidOpenCode, { platform: 'linux' }),
    /OpenCode model must use provider\/model form/
  );
});

test('approval validates normalized options and dispatch accepts only opaque approved handles', () => {
  assert.throws(
    () => approveProviderReviewRequest('claude', null),
    /Provider review options must be an object/
  );
  assert.throws(
    () => approveProviderReviewRequest('grok', []),
    /Provider review options must be an object/
  );
  assert.throws(() => dispatchProviderReview({}), /not an approved local handle/);
  assert.throws(() => inspectApprovedProviderReviewRequest(Object.freeze({})), /not an approved local handle/);
  assert.throws(
    () => approveProviderReviewRequest('ollama', {
      root: process.cwd(),
      prompt: 'bounded review packet',
      model: 'fixture-model',
      effort: 'high',
      timeoutMs: 1_000,
      responseSchema: RESPONSE_SCHEMA,
      signal: new AbortController().signal
    }),
    /signal is dispatch-only/
  );
});

test('registry rejects credential-shaped models before producing an approval handle', () => {
  const model = ['xai-', 'A9_bC7-dE5_fG3-hJ1_kL8'].join('');
  assert.throws(() => approveProviderReviewRequest('grok', {
    root: process.cwd(),
    prompt: 'bounded review packet',
    model,
    effort: 'high',
    timeoutMs: 1_000,
    responseSchema: RESPONSE_SCHEMA
  }), /model is invalid or contains credential material/);
});
