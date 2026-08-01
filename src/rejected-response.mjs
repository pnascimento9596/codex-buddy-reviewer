import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { escapeDiagnosticLine } from './policy.mjs';
import {
  assertStateOutsideRepository,
  ensurePrivateStatePath,
  resolveDataDir,
  workspaceKey,
  writePrivateJsonAtomic
} from './state.mjs';

const REVIEW_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;

function rawResponse(response) {
  if (response?.reviewPayload !== null && response?.reviewPayload !== undefined) {
    return typeof response.reviewPayload === 'string'
      ? response.reviewPayload
      : JSON.stringify(response.reviewPayload);
  }
  return typeof response?.stdout === 'string' ? response.stdout : '';
}

export async function preserveRejectedReviewerResponse({
  response,
  evidence,
  error,
  dataDir,
  writeJsonAtomic = writePrivateJsonAtomic
}) {
  if (typeof evidence?.review_id !== 'string' || !REVIEW_ID_PATTERN.test(evidence.review_id)) {
    throw new TypeError('Buddy rejected response review id is invalid');
  }
  const root = resolveDataDir(dataDir);
  await assertStateOutsideRepository(evidence.repository_root, root, 'rejected-response state');
  const directory = await ensurePrivateStatePath(root, path.join(
    root,
    'rejected-responses',
    workspaceKey(evidence.repository_root),
    evidence.review_id
  ));
  // A single review id can fan out to multiple provider lanes. Each rejected
  // transport is independent evidence, so never let concurrent failures race
  // to replace one shared response file.
  const file = path.join(directory, `response-${randomUUID()}.json`);
  const record = {
    schema_version: '1',
    review_id: evidence.review_id,
    failure_code: error.failureCode,
    parse_error: escapeDiagnosticLine(error.message),
    raw_response: rawResponse(response),
    recorded_at: new Date().toISOString()
  };
  try {
    await writeJsonAtomic(file, record);
  } catch (writeError) {
    if (writeError.code !== 'ENOENT') throw writeError;
    // A concurrent expiry pass can remove an emptied review directory in the
    // narrow ensure-to-open gap. Re-verify the private path and retry once;
    // the workspace prune lease serializes directory removal, so it has
    // already moved past this review before the failed open is observed.
    await ensurePrivateStatePath(root, directory);
    await writeJsonAtomic(file, record);
  }
  return file;
}
