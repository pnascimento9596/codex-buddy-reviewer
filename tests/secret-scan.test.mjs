import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessProviderModelIdentifier,
  MAX_SECRET_SCAN_BYTES,
  scanSecretMaterial
} from '../src/secret-scan.mjs';

function credentialFixture(name, ...parts) {
  return `${name}=${parts.join('')}`;
}

test('secret scan detects only high-confidence provider and private-key material', () => {
  for (const value of [
    '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate bytes',
    `AWS_ACCESS_KEY_ID=${'AKIA'}${'QWERTYUIOPASDFGH'}`,
    `OPENAI_API_KEY=sk-proj-${'A9_bC7-dE5_fG3-hJ1_kL8'}`,
    'api_key=aB7/C9d+Ef2_Gh5-Jk8.Lm4=Np6Qr3'
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: true });
  }
});

test('secret scan preserves ordinary code and explicit placeholder examples', () => {
  for (const value of [
    'const remaining = capacity - used;\n',
    'API_KEY=replace-me-with-your-api-key',
    'password=test_password_for_local_fixture',
    'access_token=placeholder-access-token-for-local-fixture',
    'secret_key=example-credential-for-local-fixture',
    'const token = request.headers.authorization;'
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: false });
  }
});

test('provider model identifiers reject credential shapes without blocking ordinary model names', () => {
  const credentialModels = [
    ['xai-', 'A9_bC7-dE5_fG3-hJ1_kL8'].join(''),
    ['sk-proj-', 'Q7mN2vR9_kL4pX8aC6Zt1Yw5'].join(''),
    ['ghp_', 'A9bC7dE5fG3hJ1kL8mN6pQ2rS4tU7vW9xY1z'].join(''),
    ['AKIA', 'QWERTYUIOPASDFGH'].join(''),
    ['sk', '-ant', '-api', '03-', 'A9_bC7', '-dE5_fG', '3-hJ1_k', 'L8mN6pQ'].join(''),
    ['sk-ant-oat01-', 'Q7mN2vR9_kL4pX8aC6Zt1Yw5'].join(''),
    ['sk-or-v1-', 'N6pQ2rS4tU7vW9xY1zA3bC5dE8fG0hJ2'].join(''),
    ['gsk_', 'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'].join(''),
    [
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
      Buffer.from('{"aud":"buddy"}').toString('base64url'),
      'Q7mN2vR9_kL4pX8aC6Zt1Yw5Hs3Df0Gj'
    ].join('.'),
    'A9bC7dE5fG3hJ1kL8mN6pQ2rS4tU7vW9xY1z',
    ['namespace/api_key:', 'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'].join(''),
    ['postgresql://reviewer:', 'A9_bC7-dE5_fG3-hJ1_kL8', '@db.example.invalid'].join('')
  ];
  for (const value of credentialModels) {
    assert.deepEqual(
      assessProviderModelIdentifier(value),
      { allowed: false, reason: 'credential_material' },
      value.slice(0, 8)
    );
  }
  for (const value of [
    'grok-4.5',
    'claude-opus-4-8',
    'glm-5.2:cloud',
    'openai/gpt-5.6',
    'accounts/fireworks/models/llama-v3p1-8b-instruct',
    'xai/grok-4.5',
    'openrouter/x-ai/grok-code-fast-1',
    'hf.co/bartowski/Qwen2.5-Coder-32B-Instruct-GGUF:Q4_K_M',
    'models/api-key-embedding-v2',
    'Meta-Llama-3.1-70B-Instruct-Turbo'
  ]) {
    assert.deepEqual(assessProviderModelIdentifier(value), { allowed: true, reason: null }, value);
  }
  for (const value of ['', 'model with spaces', '../model', 'model\u0000id', 'a'.repeat(201)]) {
    assert.deepEqual(assessProviderModelIdentifier(value), { allowed: false, reason: 'invalid_format' });
  }
});

test('secret scan detects quoted credential keys across JSON, YAML, and TOML forms', () => {
  const credential = ['A9_bC7-dE5_', 'fG3-hJ1_kL8mN6pQ'].join('');
  for (const value of [
    `{"api_key": "${credential}"}`,
    `{'access_token': '${credential}'}`,
    `"private_key" = "${credential}"`,
    `'secret-token': ${credential}`
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: true }, value);
  }

  for (const value of [
    '{"api_key": "replace-me-with-your-api-key"}',
    "'access_token': 'placeholder-access-token-for-local-fixture'",
    'const labels = { "api_key": "selected by the operator" };'
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: false }, value);
  }
});

test('secret scan detects namespaced, provider, and lifecycle credential keys', () => {
  const credential = ['A9_bC7-dE5_', 'fG3-hJ1_kL8mN6pQ'].join('');
  const hexCredential = ['9f3d7a1c5e8b2d4f', '6a0c3e7b9d1f5a8c'].join('');
  const awsCredential = ['Q7mN2vR9kL4pX8aC6Zt1', 'Yw5Hs3Df0Gj2Ub9Ee7Vi'].join('');
  for (const value of [
    `{"ANTHROPIC_API_KEY":"${credential}"}`,
    `{"APP__CLIENT_SECRET":"${credential}"}`,
    `APP__API_KEY=${credential}`,
    `_API_KEY=${credential}`,
    `__CLIENT_SECRET=${credential}`,
    `config['api_key'] = '${credential}'`,
    `process.env["AWS_SECRET_ACCESS_KEY"] = "${credential}"`,
    `const apiKey: string = "${credential}"`,
    `api_key: str = "${credential}"`,
    `val apiKey: String = "${credential}"`,
    `let api_key: &str = "${credential}"`,
    `apiKey := "${credential}"`,
    `api_key = \`${credential}\``,
    `ANTHROPIC_AUTH_TOKEN=${credential}`,
    `CLAUDE_CODE_OAUTH_TOKEN=${credential}`,
    `GROK_AUTH_TOKEN=${credential}`,
    `OLLAMA_AUTH_TOKEN=${credential}`,
    `KIMI_AUTH_TOKEN=${credential}`,
    `SESSION_TOKEN=${credential}`,
    `ID_TOKEN=${credential}`,
    `tool --api-key "${credential}"`,
    `setx API_KEY "${credential}"`,
    `{"client_secret":"${hexCredential}"}`,
    `AWS_SECRET_ACCESS_KEY=${awsCredential}`,
    `{"AWS_SECRET_ACCESS_KEY":"${awsCredential}"}`,
    `integration.refresh_token = "${credential}"`,
    `password="A9_bC7!dE5_fG3@hJ1_kL8"`,
    `client_secret="Q7mN2v$R9_kL4%pX8-aC6"`,
    `{"ANTHROPIC_API_KEY":"A9_bC7:dE5_fG3@hJ1_kL8"}`,
    'password="correct horse battery staple"',
    'api_key="AbCdEfGhIjKlMnOpQrStUvWx"',
    'password="correct.horse.battery.staple"',
    'password="ab\\"A9_bC7-dE5_fG3-hJ1_kL8mN6pQ"',
    "password='ab\\'A9_bC7-dE5_fG3-hJ1_kL8mN6pQ'",
    'password=`ab\\`A9_bC7-dE5_fG3-hJ1_kL8mN6pQ`'
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: true }, value);
  }

  for (const value of [
    '{"ANTHROPIC_API_KEY":"replace-me-with-your-api-key"}',
    'client_secret=placeholder-client-secret-for-local-fixture',
    'AWS_SECRET_ACCESS_KEY=example-secret-access-key-for-local-fixture',
    'ANTHROPIC_API_KEY=example-anthropic-api-key-for-local-fixture',
    'api_key_header_name="X-Custom-Public-Identifier-42"',
    'private_key_algorithm="RSAES-OAEP-SHA256-MGF1"',
    'api_key_description="ThisIsPublicMetadataValue42"',
    'api_key = request.headers.authorization',
    'client_secret = process.env.CLIENT_SECRET',
    'AWS_SECRET_ACCESS_KEY=process.env.AWS_SECRET_ACCESS_KEY',
    'password = configuration.databasePassword',
    'private_key = keyStore.selectedPublicIdentifier',
    'refresh_token = getRefreshToken()',
    'api_key = getConfig().apiKey',
    'refresh_token = tokenStore?.getRefreshToken()',
    'tool --api-key replace-me-with-your-api-key',
    'setx API_KEY example-api-key-for-local-fixture',
    '{"api_key":"replace-me-with-your-api-key","endpoint":"https://example.invalid"}',
    'api_key="replace-me-with-your-api-key"; console.log("ready")',
    '{"api_key":"YOUR_API_KEY","password":"configured by user"}',
    'api_key="${ANTHROPIC_API_KEY}"',
    'client_secret="${CLIENT_SECRET}"'
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: false }, value);
  }
});

test('secret scan detects Authorization credentials in header and structured forms without matching prose', () => {
  const basicCredential = Buffer.from('reviewer:A9_bC7-dE5_fG3-hJ1_kL8').toString('base64');
  const jwtCredential = [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJhdWQiOiJidWRkeSJ9',
    'Q7mN2vR9_kL4pX8aC6Zt1Yw5Hs3Df0Gj'
  ].join('.');
  for (const value of [
    'Authorization: Bearer Q7mN2vR9_kL4.pX8-aC6Zt1Yw5Hs3Df0Gj2Ub9Ee7',
    'authorization:\tBEARER\tbR8kP2sV7mT4xQ9nC5jH1wL6dF3aZ0uY2eG8iK4oN7pS9vX',
    `{"Authorization":"Bearer ${jwtCredential}"}`,
    'headers.authorization = "Bearer Q7mN2vR9_kL4.pX8-aC6Zt1Yw5Hs3Df0Gj2Ub9Ee7"',
    `request.headers.Authorization = "Basic ${basicCredential}"`,
    'HTTP_AUTHORIZATION=Token Q7mN2vR9_kL4.pX8-aC6Zt1Yw5Hs3Df0Gj2Ub9Ee7',
    'PROXY_AUTHORIZATION=ApiKey Q7mN2vR9_kL4.pX8-aC6Zt1Yw5Hs3Df0Gj2Ub9Ee7',
    'headers[\'Authorization\'] = \'Bearer A9_bC7-dE5_fG3-hJ1_kL8mN6pQ\'',
    `headers["Proxy-Authorization"] = "Basic ${basicCredential}"`,
    'Authorization: Bearer "Q7mN2vR9_kL4.pX8-aC6Zt1Yw5Hs3Df0Gj2Ub9Ee7"',
    'Authorization = `Bearer Q7mN2vR9_kL4.pX8-aC6Zt1Yw5Hs3Df0Gj2Ub9Ee7`',
    `Authorization: Basic ${basicCredential}`,
    `{"authorization":"Basic ${basicCredential}"}`
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: true }, value);
  }

  for (const value of [
    'Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
    'Authorization: Bearer example-access-token-for-local-fixture',
    'Authorization: Bearer YOUR_ACCESS_TOKEN',
    'Authorization: Basic BASE64_CREDENTIALS',
    'Authorization: Bearer $ACCESS_TOKEN',
    'The Bearer authorization scheme is supported by this parser.'
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: false }, value);
  }
});

test('secret scan detects credentials embedded in connection URLs', () => {
  for (const value of [
    'DATABASE_URL=postgresql://buddy-reviewer:A9_bC7-dE5_fG3-hJ1_kL8@db.example.invalid/reviews',
    'mongodb+srv://reviewer:Q7mN2vR9_kL4.pX8-aC6Zt1Yw5@cluster.example.invalid/db',
    'redis://service:%41%39_bC7-dE5_fG3-hJ1_kL8@cache.example.invalid:6379/0',
    'redis://:A9_bC7-dE5_fG3-hJ1_kL8@cache.example.invalid:6379/0'
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: true }, value);
  }

  for (const value of [
    'postgresql://localhost/reviews',
    'https://example.invalid/docs/user:password@host',
    'redis://service:placeholder-password-for-local-fixture@cache.example.invalid/0',
    'postgresql://user:${DB_PASSWORD}@db.example.invalid/reviews',
    'mongodb://<username>:<password>@host.example.invalid/db'
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: false }, value);
  }
});

test('secret scan does not exempt placeholder words embedded in credential-shaped values', () => {
  for (const value of [
    credentialFixture(
      'api_key',
      'aB7C9dEf2Gh5', 'Jk8Lm4Np6Qr3test'
    ),
    credentialFixture(
      'access_token',
      'A9bC7dE5fG3h', 'J1kL8dummyN6pQ'
    ),
    credentialFixture(
      'password',
      'Q7wE9rT2yU4i', 'O6pA8sampleS3dF'
    ),
    credentialFixture(
      'secret_key',
      'Z1xC3vB5nM7a', 'S9dF2fakeG4hJ'
    ),
    credentialFixture(
      'private_key',
      'test_A9bC7dE5', 'fG3hJ1kL8mN6pQ'
    ),
    credentialFixture(
      'passwd',
      'dummy-A9_bC7-dE5', '_fG3-hJ1_kL8'
    ),
    credentialFixture(
      'api_key',
      'V8nM6bC4xZ2', 'exampleQ9wE7rT5'
    ),
    credentialFixture(
      'access_token',
      'K3jH5gF7dS9', 'placeholderL2kJ4hG6'
    ),
    credentialFixture(
      'secret_key',
      'R4tY6uI8oP2', 'replaceA5sD7fG9'
    ),
    credentialFixture(
      'password',
      'N6mB8vC2xZ4', 'change-meQ7wE9rT3'
    ),
    credentialFixture(
      'passwd',
      'H5jK7lP9oI3', 'not-realU6yT8rE2'
    ),
    credentialFixture(
      'private_key',
      'C7vB9nM3aS5', '00000000D2fG4hJ6'
    )
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: true }, value);
  }
});

test('secret scan requires placeholder shapes to consume the entire candidate', () => {
  for (const value of [
    'api_key=replace-me-with-your-api-key-A9bC7dE5fG3hJ1kL8',
    'access_token=placeholder-access-token-for-local-fixture-Z9yX7wV5',
    'password=test_password_for_local_fixture_A9bC7dE5',
    'secret_key=sample-secret-key-for-local-fixture-Q7wE9rT2',
    'api_key=aB7C9dEf2Gh5Jk8Lm4Np6Qr3xxxxxxxx'
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: true }, value);
  }

  for (const value of [
    `api_key=${'x'.repeat(24)}`,
    `access_token=${'0'.repeat(24)}`,
    'API_KEY=REPLACE_ME_WITH_YOUR_API_KEY',
    'password=TEST.PASSWORD.FOR.LOCAL.FIXTURE',
    'secret_token=not-real-secret-token-for-local-fixture'
  ]) {
    assert.deepEqual(scanSecretMaterial(Buffer.from(value)), { complete: true, detected: false }, value);
  }
});

test('secret scan fails closed for oversized or invalid UTF-8 text-like inputs', () => {
  assert.deepEqual(
    scanSecretMaterial(Buffer.alloc(MAX_SECRET_SCAN_BYTES + 1, 0x61)),
    { complete: false, detected: false }
  );
  assert.deepEqual(
    scanSecretMaterial(Buffer.from([0x61, 0xc3, 0x28, 0x62])),
    { complete: false, detected: false }
  );
});

test('secret scan remains bounded on maximum-size unterminated escaped literals', () => {
  const unit = `api_key="${'\\\\'.repeat(255)}X\n`;
  const repetitions = Math.floor(MAX_SECRET_SCAN_BYTES / Buffer.byteLength(unit));
  const input = Buffer.from(unit.repeat(repetitions));
  const started = performance.now();
  assert.deepEqual(scanSecretMaterial(input), { complete: true, detected: false });
  assert.equal(performance.now() - started < 2_000, true);
});
