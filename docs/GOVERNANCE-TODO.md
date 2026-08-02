# Governance and Owner-Observed Completion Checklist

This file tracks controls and observations that cannot be proved by repository CI or the GitHub repository API alone. A checked item requires direct account-owner action or observation; agent inference is not evidence.

## GitHub account controls

- [ ] Review the GitHub account Security Log for release and deployment activity around `2026-08-01T09:38:00Z` through `2026-08-01T09:59:00Z`, and around each later release dispatch. Record unexpected identities, IP addresses, sessions, or token use before stable promotion.
- [ ] Inventory authorized OAuth applications and revoke any that no longer need repository access.
- [ ] Inventory fine-grained personal access tokens and revoke stale or unrecognized credentials.
- [ ] Replace broad agent credentials where practical with repository-selected fine-grained tokens. Agent tokens should not receive Actions write/workflow-dispatch or deployment-approval access unless the specific session requires it.
- [ ] Decide whether to disable administrator bypass for the `public-release` environment. The repository API currently reports `can_admins_bypass: true`.
- [ ] Review account email visibility and two-factor-authentication status in browser settings; the active API token does not expose authoritative values for these settings.

The repository API successfully enforces `pnascimento9596` as the sole required reviewer for `public-release`, with protected branches only and `prevent_self_review: false`. The release workflow additionally rejects dispatches whose GitHub account actor is not exactly `pnascimento9596`. This is defense-in-depth: it identifies the GitHub account presented to the workflow, not the human, browser session, OAuth application, or agent process using an owner credential.

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
