import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { receiptEvidence } from './evidence.mjs';
import { assessProviderModelIdentifier } from './secret-scan.mjs';
import {
  ensurePrivateStatePath,
  resolveDataDir,
  workspaceKey,
  writePrivateJsonAtomic
} from './state.mjs';

export async function storeReceipt({ evidence, result, provider, model, stderr, run, retainEvidence, dataDir }) {
  if (!assessProviderModelIdentifier(model).allowed) {
    throw new Error('Buddy receipt model is invalid or contains credential material');
  }
  if (run !== null && run !== undefined) {
    if (!run || typeof run !== 'object' || Array.isArray(run)
        || run.model !== model || !assessProviderModelIdentifier(run.model).allowed) {
      throw new Error('Buddy receipt provider run has an invalid or mismatched model identifier');
    }
  }
  const root = resolveDataDir(dataDir);
  const reviewDir = path.join(root, 'reviews', workspaceKey(evidence.repository_root), evidence.review_id);
  const parent = path.dirname(reviewDir);
  const temporary = path.join(parent, `.${path.basename(reviewDir)}.${randomUUID()}.tmp`);
  await ensurePrivateStatePath(root, parent);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await writePrivateJsonAtomic(path.join(temporary, 'evidence.json'), receiptEvidence(evidence, retainEvidence));
    await writePrivateJsonAtomic(path.join(temporary, 'result.json'), result);
    await writePrivateJsonAtomic(path.join(temporary, 'run.json'), {
      schema_version: '1',
      review_id: evidence.review_id,
      provider,
      model,
      prompt_version: '4',
      patch_hash: evidence.patch_hash,
      completed_at: new Date().toISOString(),
      stderr_present: run?.stderr_present ?? Boolean(stderr?.trim()),
      stderr_hash: stderr?.trim() ? createHash('sha256').update(stderr.trim()).digest('hex') : null,
      provider_run: run ?? null
    });
    await rename(temporary, reviewDir);
    return reviewDir;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}
