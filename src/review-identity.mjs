// @ts-ignore -- noResolve keeps checked-JS confined to the authorized slice.
import { createHash } from 'node:crypto';

// @ts-ignore -- external runtime boundary; validated by its owning module.
import { MODE_POLICY_VERSION, reviewersForMode } from './mode.mjs';
import { REVIEW_SCHEMA_VERSION } from './review-schema.mjs';
// @ts-ignore -- external runtime boundary; validated by its owning module.
import { canonicalJson, opaqueKey } from './state.mjs';
// @ts-ignore -- external runtime boundary; validated by its owning module.
import { turnEvidenceDigest, turnSnapshotDigest } from './turn-snapshot.mjs';

export const REVIEW_PROMPT_VERSION = '5';

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * @param {{
 *   input: {session_id: string, turn_id: string, last_assistant_message?: string},
 *   mode: {min_confidence: number, max_patch_bytes: number, [key: string]: unknown},
 *   baseline: unknown,
 *   final: {repository_root: string, [key: string]: unknown},
 *   evidence: unknown,
 *   summaryGuardConsent?: null | {
 *     enabled: boolean,
 *     policy_version: string,
 *     configuration_revision: number,
 *     provider: string,
 *     model: string
 *   }
 * }} binding
 * @returns {string}
 */
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
