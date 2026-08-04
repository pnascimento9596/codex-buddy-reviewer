# Governance and Owner-Observed Completion Checklist

This file tracks controls and observations that cannot be proved by repository CI or the GitHub repository API alone. A checked item requires direct account-owner action or observation; agent inference is not evidence.

## GitHub account controls

- [x] Review the GitHub account Security Log for release and deployment activity around `2026-08-01T09:38:00Z` through `2026-08-01T09:59:00Z`, and around each later release dispatch. Record unexpected identities, IP addresses, sessions, or token use before stable promotion.
  - Done 2026-08-04 via Safari Security Log (signed in as `pnascimento9596`). Query `created:>=2026-08-01T09:20:00Z created:<=2026-08-01T10:20:00Z` returned exactly three events, all at `2026-08-01T09:38:46Z`, all actor GitHub System, all Copilot Pull Request Reviewer `oauth_access` regenerate/destroy/create. No unexpected identities or IPs in-window. Screenshots retained only under local excluded `.local-evidence/security-log/` (not committed). Repo-level merge/dispatch is not an account Security Log event type.
- [ ] Inventory authorized OAuth applications and revoke any that no longer need repository access.
- [ ] Inventory fine-grained personal access tokens and revoke stale or unrecognized credentials.
- [ ] Replace broad agent credentials where practical with repository-selected fine-grained tokens. Agent tokens should not receive Actions write/workflow-dispatch or deployment-approval access unless the specific session requires it.
  - Agent residue: create only under owner browser control; never expose token value to agents or commits. Suggested scope: this repository, Contents + Pull requests write, no workflow, no deployment review.
- [ ] Decide whether to disable administrator bypass for the `public-release` environment. The repository API currently reports `can_admins_bypass: true`.
- [ ] Review account email visibility and two-factor-authentication status in browser settings; the active API token does not expose authoritative values for these settings.

The repository API successfully enforces `pnascimento9596` as the sole required reviewer for `public-release`, with protected branches only and `prevent_self_review: false` (re-verified 2026-08-04). The release workflow additionally rejects dispatches whose GitHub account actor is not exactly `pnascimento9596`. This is defense-in-depth: it identifies the GitHub account presented to the workflow, not the human, browser session, OAuth application, or agent process using an owner credential.

Attempting `gh api /user/security-log` on `2026-08-02` returned verbatim:

```text
{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}gh: Not Found (HTTP 404)
```

The authenticated `/user` endpoint exposed the account profile for login `pnascimento9596` and numeric ID `198005926`, but did not expose a complete security log, OAuth-application inventory, fine-grained-token inventory, or authoritative token/session provenance.

## Host-observed release gates

- [ ] Observe native pet rendering from the published artifact for Byte, Mochi, Orbit, Bella, and Lupo.
- [ ] Observe Codex transcript continuation and compact review display in the native host.
- [ ] Confirm the native host trusts and invokes the installed artifact's hook entrypoints as documented.
- [ ] Complete the Windows current-user-only DACL creation and verification gate before any live Windows provider egress.
- [ ] Decide whether the verified release candidate is eligible for stable `v0.5.0` promotion. That decision remains with the account owner after independent review, published-artifact verification, and host observations are complete.

CLI-observable POSIX evidence can support these checks but cannot replace native rendering, transcript-display, or host-trust observations.

## Phase 7 repository-observed ledger — 2026-08-04

The following repository and API evidence is complete:

- rc.3 was published by protected workflow run `30861281580` from exact protected source `0c6f09ae14d834fccb2a2289f6731511dbbdb034` after all validation lanes passed.
- GitHub attributed the dispatch, all three required-environment approvals, and publication to owner account `pnascimento9596` (`198005926`). This proves account attribution, not the human/session/token behind that account.
- Independent anonymous verification proved annotated tag `eb6a4541cbe75c73648da806ffacd22aef2b2f0d`, parentless distribution commit `8782b70c5c664f5a73f9c225a802c71f1ff49ccf`, tree `ac9ffe81aa3b170cf519ef1b35977a15f9cfae4b`, all five asset digests and sizes, both checksum sidecars, and three policy-bound GitHub-hosted attestations.
- The frozen rc.3 evidence shipped through protected PR #34; frozen rc.1 and rc.2 bytes remained unchanged.
- The published-artifact POSIX trial stayed within budget: one health call per configured reviewer and one live review turn. OpenCode `openai/gpt-5.6` failed closed; Ollama Cloud `glm-5.2:cloud` detected and grounded the planted off-by-one as `blocker` / confidence `1`. The successful result included `findings`; no reviewer returned `no_findings` or `abstain`. The 323-character output, mode disable, purge, tombstone retention, zero provider-temp bytes, and zero active capabilities were verified.
- Issue #29 was corrected through PR #33. Issues #14 and #25 remain open; #25 recurred under loaded Ubuntu Node 24 protected CI and continues to require the deterministic-timing hardening pass.

The unchecked account and native-host items above remain genuinely unresolved. Repository automation cannot convert them into owner-observed evidence. In particular, the REST API refusal for `/user/security-log` is not a Security Log review, and synthetic hook invocation is not native Codex hook trust, transcript rendering, or five-pet visual observation.

**Stable-promotion disposition:** do not promote `v0.5.0` yet. rc.3 is independently verified and suitable for continued prerelease evaluation, but stable promotion should wait for the exact-head deep security scan, #14/#25 timing hardening, published-artifact speculative receipt adoption under a real host, five-pet native host bundle, Windows DACL/live-egress gate, and the remaining owner-only account review.
