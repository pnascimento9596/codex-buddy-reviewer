import path from 'node:path';

import {
  ensurePrivateStatePath,
  opaqueKey,
  readPrivateJson,
  resolveRuntimeDataDir,
  withFileLock,
  workspaceKey,
  writePrivateJsonAtomic
} from './state.mjs';

const CIRCUIT_FAILURE_LIMIT = 3;
const CIRCUIT_OPEN_MS = 30 * 60_000;

export async function readProviderCircuit({ runtimeDataDir, root, provider, model }) {
  const runtimeRoot = resolveRuntimeDataDir(runtimeDataDir);
  const directory = path.join(runtimeRoot, 'circuits', workspaceKey(root));
  await ensurePrivateStatePath(runtimeRoot, directory);
  const file = path.join(directory, `${opaqueKey(`${provider}\0${model}`)}.json`);
  return {
    file,
    state: await readPrivateJson(file) ?? { consecutive_failures: 0, open_until: null }
  };
}

export async function providerCircuitIsOpen(options) {
  const { state } = await readProviderCircuit(options);
  return state.open_until && Date.parse(state.open_until) > Date.now();
}

export async function recordProviderCircuit(options, succeeded) {
  const { file } = await readProviderCircuit(options);
  await withFileLock(file, async () => {
    const current = await readPrivateJson(file) ?? { consecutive_failures: 0, open_until: null };
    const failures = succeeded ? 0 : current.consecutive_failures + 1;
    await writePrivateJsonAtomic(file, {
      schema_version: '1',
      consecutive_failures: failures,
      open_until: failures >= CIRCUIT_FAILURE_LIMIT
        ? new Date(Date.now() + CIRCUIT_OPEN_MS).toISOString()
        : null,
      updated_at: new Date().toISOString()
    });
  });
}
