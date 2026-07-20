import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createApprovedProviderRequestAuthority,
  PROVIDER_CONTENT_POLICY_VERSION
} from '../src/approved-provider-request.mjs';

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { status: { type: 'string' } }
};

function candidate(overrides = {}) {
  return {
    purpose: 'technical_review',
    root: process.cwd(),
    provider: 'grok',
    prompt: 'Review the bounded technical evidence packet.',
    model: 'grok-4.5',
    effort: 'high',
    timeoutMs: 1_000,
    responseSchema: RESPONSE_SCHEMA,
    summaryGuardPacket: null,
    ...overrides
  };
}

test('approved requests are opaque, authority-local, immutable handles', () => {
  const authority = createApprovedProviderRequestAuthority();
  const otherAuthority = createApprovedProviderRequestAuthority();
  const input = candidate();
  const approved = authority.approve(input);
  input.prompt = 'mutated after approval';
  input.responseSchema.properties.status.type = 'number';

  assert.deepEqual(Reflect.ownKeys(approved), []);
  assert.equal(Object.isFrozen(approved), true);
  assert.throws(() => authority.inspect(Object.freeze({})), /not an approved local handle/);
  assert.throws(() => otherAuthority.inspect(approved), /not an approved local handle/);
  const unwrapped = authority.unwrap(approved);
  assert.equal(unwrapped.prompt, 'Review the bounded technical evidence packet.');
  assert.equal(unwrapped.responseSchema.properties.status.type, 'string');
  assert.equal(Object.isFrozen(unwrapped.responseSchema.properties), true);
  assert.throws(() => { unwrapped.prompt = 'changed'; }, TypeError);
});

test('approval binds policy, provider configuration, exact content, and channel inventory digests', () => {
  const authority = createApprovedProviderRequestAuthority();
  const approved = authority.approve(candidate());
  const metadata = authority.inspect(approved);

  assert.equal(metadata.policyVersion, PROVIDER_CONTENT_POLICY_VERSION);
  assert.equal(metadata.purpose, 'technical_review');
  assert.equal(metadata.provider, 'grok');
  assert.equal(metadata.model, 'grok-4.5');
  assert.equal(metadata.effort, 'high');
  assert.equal(metadata.timeoutMs, 1_000);
  assert.deepEqual(metadata.channelInventory, ['technical_evidence']);
  for (const digest of [
    metadata.rootSha256,
    metadata.promptSha256,
    metadata.responseSchemaSha256,
    metadata.channelInventorySha256,
    metadata.approvalSha256
  ]) assert.match(digest, /^[0-9a-f]{64}$/u);
});

test('approval rejects provider-bound credentials and incomplete content scans', () => {
  const authority = createApprovedProviderRequestAuthority();
  const basicCredential = Buffer.from('reviewer:A9_bC7-dE5_fG3-hJ1_kL8').toString('base64');
  const jwtCredential = [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJhdWQiOiJidWRkeSJ9',
    'Q7mN2vR9_kL4pX8aC6Zt1Yw5Hs3Df0Gj'
  ].join('.');
  for (const prompt of [
    `Review this: {"api_key":"${'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'}"}`,
    `Review this: {"ANTHROPIC_API_KEY":"${'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'}"}`,
    `Review this: {"APP__CLIENT_SECRET":"${'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'}"}`,
    `Review this: config['api_key'] = '${'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'}'`,
    `Review this: const apiKey: string = "${'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'}"`,
    `Review this: tool --api-key "${'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'}"`,
    `Review this: CLAUDE_CODE_OAUTH_TOKEN=${'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'}`,
    `Review this: {"client_secret":"${'9f3d7a1c5e8b2d4f6a0c3e7b9d1f5a8c'}"}`,
    `AWS_SECRET_ACCESS_KEY=${'Q7mN2vR9kL4pX8aC6Zt1Yw5Hs3Df0Gj2Ub9Ee7Vi'}`,
    'Authorization: Bearer Q7mN2vR9_kL4.pX8-aC6Zt1Yw5Hs3Df0Gj2Ub9Ee7',
    `{"Authorization":"Bearer ${jwtCredential}"}`,
    'headers.authorization = "Token Q7mN2vR9_kL4.pX8-aC6Zt1Yw5Hs3Df0Gj2Ub9Ee7"',
    'headers[\'Authorization\'] = \'Bearer A9_bC7-dE5_fG3-hJ1_kL8mN6pQ\'',
    'PROXY_AUTHORIZATION=Bearer Q7mN2vR9_kL4.pX8-aC6Zt1Yw5Hs3Df0Gj2Ub9Ee7',
    `Authorization: Basic ${basicCredential}`,
    'DATABASE_URL=postgresql://reviewer:A9_bC7-dE5_fG3-hJ1_kL8@db.example.invalid/reviews',
    'CACHE_URL=redis://:A9_bC7-dE5_fG3-hJ1_kL8@cache.example.invalid/0'
  ]) {
    assert.throws(() => authority.approve(candidate({ prompt })), /contains credential material/);
  }
  assert.throws(
    () => authority.approve(candidate({ prompt: 'a'.repeat(2 * 1024 * 1024 + 1) })),
    /exceeds its byte limit/
  );
  assert.throws(
    () => authority.approve(candidate({ prompt: '\u0000Authorization: Bearer Q7mN2vR9_kL4.pX8-aC6Zt1Yw5Hs3Df0Gj2Ub9Ee7' })),
    /unsafe control characters/
  );
});

test('approval rejects credential-shaped model identifiers before binding metadata', () => {
  const authority = createApprovedProviderRequestAuthority();
  for (const model of [
    ['xai-', 'A9_bC7-dE5_fG3-hJ1_kL8'].join(''),
    ['sk-svcacct-', 'Q7mN2vR9_kL4pX8aC6Zt1Yw5'].join(''),
    ['AKIA', 'QWERTYUIOPASDFGH'].join('')
  ]) {
    assert.throws(() => authority.approve(candidate({ model })), /model contains credential material/);
  }
  for (const model of ['openai/gpt-5.6', 'glm-5.2:cloud', 'xai/grok-4.5']) {
    assert.doesNotThrow(() => authority.approve(candidate({ model })));
  }
});

test('ordinary code, prose, placeholders, and static health checks remain allowed', () => {
  const authority = createApprovedProviderRequestAuthority();
  for (const prompt of [
    'const token = request.headers.authorization;',
    'The Bearer authorization scheme is supported by this parser.',
    '{"api_key":"replace-me-with-your-api-key"}'
  ]) {
    assert.doesNotThrow(() => authority.approve(candidate({ prompt })));
  }
  const health = authority.approve(candidate({
    purpose: 'health_check',
    prompt: 'Return only {"status":"ok"}.',
    summaryGuardPacket: null
  }));
  assert.deepEqual(authority.inspect(health).channelInventory, ['static_health_prompt']);
  assert.throws(
    () => authority.approve(candidate({ purpose: 'health_check', summaryGuardPacket: {} })),
    /cannot include a worker summary/
  );
});
