import path from 'node:path';

import { opaqueKey, resolveRuntimeDataDir, workspaceKey } from './state.mjs';

export function automaticTurnDirectory(runtimeDataDir, root, sessionId, turnId) {
  return path.join(
    resolveRuntimeDataDir(runtimeDataDir),
    'turns',
    workspaceKey(root),
    opaqueKey(sessionId),
    opaqueKey(turnId)
  );
}

export function automaticReceiptFile(runtimeDataDir, root, reviewKey) {
  return path.join(
    resolveRuntimeDataDir(runtimeDataDir),
    'automatic-reviews',
    workspaceKey(root),
    `${reviewKey}.json`
  );
}

export function speculativeAttemptFile(directory, reviewKey) {
  return path.join(directory, 'pre-review-attempts', `${reviewKey}.json`);
}
