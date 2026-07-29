import path from 'node:path';

import { escapeDiagnosticLine } from './policy.mjs';
import {
  resolveDataDir,
  workspaceKey,
  writePrivateJsonAtomic
} from './state.mjs';

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
  const root = resolveDataDir(dataDir);
  const file = path.join(
    root,
    'rejected-responses',
    workspaceKey(evidence.repository_root),
    evidence.review_id,
    'response.json'
  );
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
