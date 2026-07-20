import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  providerCircuitIsOpen,
  readProviderCircuit,
  recordProviderCircuit
} from '../src/provider-circuit.mjs';
import { opaqueKey, workspaceKey } from '../src/state.mjs';

test('shared provider circuit preserves the existing path, schema, threshold, and success reset', async () => {
  const runtimeDataDir = await mkdtemp(path.join(os.tmpdir(), 'buddy-provider-circuit-'));
  const root = path.join(runtimeDataDir, 'repo');
  const options = {
    runtimeDataDir,
    root,
    provider: 'grok',
    model: 'grok-4.5'
  };
  const expectedFile = path.join(
    runtimeDataDir,
    'circuits',
    workspaceKey(root),
    `${opaqueKey('grok\0grok-4.5')}.json`
  );

  const initial = await readProviderCircuit(options);
  assert.equal(initial.file, expectedFile);
  assert.deepEqual(initial.state, { consecutive_failures: 0, open_until: null });

  await recordProviderCircuit(options, false);
  await recordProviderCircuit(options, false);
  assert.equal(await providerCircuitIsOpen(options), null);
  await recordProviderCircuit(options, false);

  const opened = JSON.parse(await readFile(expectedFile, 'utf8'));
  assert.deepEqual(Object.keys(opened).sort(), [
    'consecutive_failures', 'open_until', 'schema_version', 'updated_at'
  ]);
  assert.equal(opened.schema_version, '1');
  assert.equal(opened.consecutive_failures, 3);
  assert.equal(Date.parse(opened.open_until) > Date.now(), true);
  assert.equal(await providerCircuitIsOpen(options), true);

  await recordProviderCircuit(options, true);
  const reset = JSON.parse(await readFile(expectedFile, 'utf8'));
  assert.equal(reset.consecutive_failures, 0);
  assert.equal(reset.open_until, null);
  assert.equal(await providerCircuitIsOpen(options), null);
});
