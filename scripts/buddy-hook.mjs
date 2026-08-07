#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readHookInput } from '../hooks/lib/hook-input.mjs';
import { resolveRuntimeDataDir } from '../hooks/lib/host-runtime.mjs';
import { createHookOutputGuard } from '../src/hook-transport.mjs';
import { captureTurnStart, markContinuationStdoutWritten, reviewTurnStop } from '../src/lifecycle.mjs';

const output = createHookOutputGuard();
try {
  const input = await readHookInput();
  const options = { runtimeDataDir: resolveRuntimeDataDir() };
  if (input.hook_event_name === 'UserPromptSubmit') {
    await output.write((await captureTurnStart(input, options)).output);
  } else if (input.hook_event_name === 'Stop') {
    const result = await reviewTurnStop(input, options);
    const written = await output.write(result.output);
    if (written && result.deliveryToken) {
      await markContinuationStdoutWritten(input, result.deliveryToken, options);
    }
  }
} catch (error) {
  const errorHash = createHash('sha256').update(String(error?.message ?? error)).digest('hex').slice(0, 12);
  if (!output.attempted) {
    await output.write({ systemMessage: `Buddy Review failed open before completion (diagnostic ${errorHash}).` });
  } else {
    process.stderr.write(`Buddy Review post-output failure (diagnostic ${errorHash}).\n`);
  }
}
