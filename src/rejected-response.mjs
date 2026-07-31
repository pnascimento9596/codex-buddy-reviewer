import path from 'node:path';

import { escapeDiagnosticLine } from './policy.mjs';
import {
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
  dataDir
}) {
  if (typeof evidence?.review_id !== 'string' || !REVIEW_ID_PATTERN.test(evidence.review_id)) {
    throw new TypeError('Buddy rejected response review id is invalid');
  }
  const root = resolveDataDir(dataDir);
  const directory = await ensurePrivateStatePath(root, path.join(
    root,
    'rejected-responses',
    workspaceKey(evidence.repository_root),
    evidence.review_id
  ));
  const file = path.join(directory, 'response.json');
  await writePrivateJsonAtomic(file, {
    schema_version: '1',
    review_id: evidence.review_id,
    failure_code: error.failureCode,
    parse_error: escapeDiagnosticLine(error.message),
    raw_response: rawResponse(response),
    recorded_at: new Date().toISOString()
  });
  return file;
}
