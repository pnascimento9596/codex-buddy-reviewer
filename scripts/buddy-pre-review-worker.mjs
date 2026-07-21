#!/usr/bin/env node
import { createHash } from 'node:crypto';

import { readJsonObjectInput } from '../hooks/lib/hook-input.mjs';
import { runPreReviewWorker } from '../src/pre-review.mjs';

try {
  const input = await readJsonObjectInput();
  await runPreReviewWorker(input, { runtimeDataDir: process.env.PLUGIN_DATA });
} catch (error) {
  const digest = createHash('sha256').update(String(error?.message ?? error)).digest('hex').slice(0, 12);
  process.stderr.write(`Buddy pre-review worker failed closed (diagnostic ${digest}).\n`);
}
