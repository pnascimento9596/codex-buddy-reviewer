import { createHash } from 'node:crypto';

import { MODE_POLICY_VERSION, reviewersForMode } from './mode.mjs';
import { REVIEW_SCHEMA_VERSION } from './review-schema.mjs';
import { canonicalJson, opaqueKey } from './state.mjs';
import { turnEvidenceDigest, turnSnapshotDigest } from './turn-snapshot.mjs';

export const REVIEW_PROMPT_VERSION = '5';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function reviewKeyFor({ input, mode, baseline, final, evidence, summaryGuardConsent }) {
  const reviewers = reviewersForMode(mode);
  return sha256(canonicalJson({
    session_key: opaqueKey(input.session_id),
    turn_key: opaqueKey(input.turn_id),
    repository_root: final.repository_root,
    baseline_snapshot_sha256: turnSnapshotDigest(baseline),
    final_snapshot_sha256: turnSnapshotDigest(final),
    evidence_sha256: turnEvidenceDigest(evidence),
    last_assistant_message_hash: summaryGuardConsent?.enabled
      ? sha256(input.last_assistant_message ?? '')
      : null,
    reviewers,
    prompt_version: REVIEW_PROMPT_VERSION,
    policy_version: MODE_POLICY_VERSION,
    result_schema_version: REVIEW_SCHEMA_VERSION,
    confidence_threshold: mode.min_confidence,
    max_patch_bytes: mode.max_patch_bytes,
    summary_claim_guard: summaryGuardConsent
      ? {
          enabled: summaryGuardConsent.enabled,
          policy_version: summaryGuardConsent.policy_version,
          configuration_revision: summaryGuardConsent.configuration_revision,
          provider: summaryGuardConsent.provider,
          model: summaryGuardConsent.model
        }
      : { enabled: false, state: 'unavailable' }
  }));
}
