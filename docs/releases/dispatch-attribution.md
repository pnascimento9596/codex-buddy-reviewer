# Release dispatch attribution (out-of-artifact)

This file records release-workflow dispatch attribution. It lives under
`docs/releases/`, which is **not** part of the published public artifact path
set (see `release/public-files.json` and the built inventory). Writing here does
not change public artifact bytes.

Historical attribution text that already shipped inside `docs/VALIDATION.md`
(Layer A) remains frozen there. New dispatches append here instead of editing
the in-artifact validation record.

## How to use (no self-referential SHA)

The release workflow requires the dispatched event SHA to equal the current
protected default-branch HEAD. A git commit cannot name its own future SHA as
the dispatch source. Therefore this log uses a two-phase rule:

### Phase A — pre-dispatch (authority; does not invent a future SHA)

Before `workflow_dispatch`, record (here **or** in an external owner/lane
record that is later copied here):

- the **already-existing** protected-main HEAD that will be dispatched (call it
  `H`); do not create further commits on `main` after `H` before dispatch;
- the exact `version` and `publish` inputs;
- the GitHub account that will perform the dispatch;
- the owner instruction or lane authority that authorized the dispatch.

If this Phase A text is committed to `main`, that commit becomes a new HEAD and
**must not** be the dispatch source unless the entry explicitly names that new
commit only after it exists (Phase B). Preferred: keep Phase A external, or
commit Phase A only on a non-default branch, then dispatch `H` from protected
`main` without an intervening attribution commit.

### Phase B — post-dispatch (durable run identity)

After the run finishes (success, failure, or cancel), append or complete the
entry with:

- the actual `source_sha` / event SHA from the run;
- the run ID(s) and conclusion(s);
- any attempt numbers relevant to attestation binding.

GitHub can establish account, workflow, source, and approval attribution. It
cannot establish which person or delegated local session operated an authorized
account token.

## Post-scan disposition entries

When the security-scan post-scan allowlist is used, record each disposition
**here** (path + diff digest + reviewer sign-off) before dispatch. Do not write
those entries into `docs/releases/v0.5.0-stable-readiness.md` — that file defines
the gate/scan surface, so a disposition written there re-opens the gate it
claims to close. Prefer the intended order: version-prep merges, seal and scan
that head, dispatch the same head with Phase A/B attribution out-of-artifact.

## Entries

### 2026-08-05 — v0.5.0-rc.4 publish (historical; also recorded in VALIDATION.md)

- Source SHA: `b56224fb8e37ca02e071cda41702af4ef20f1ebb`
- Inputs: `version=0.5.0-rc.4`, `publish=true`
- Actor account: `pnascimento9596` (`198005926`)
- Release run: `31013433126` (attempt 2 publish; attestations bind attempt 1)
- Authority: owner instruction of 2026-08-05 via delegated agent session
- Note: the contemporaneous statement was written into `docs/VALIDATION.md`
  Layer A before this out-of-artifact home existed.

### 2026-08-05 — v0.5.0-rc.4 publish=false dry-run (post-#54)

- Source SHA: `bd9844622b462aa25b99bf1ce670aad9bb53250a`
- Inputs: `version=0.5.0-rc.4`, `publish=false`
- Actor account: `pnascimento9596`
- Runs:
  - `31042446594` — cancelled at `2026-08-05T20:05:33Z` (28 s before the
    successful dry run; no tag or Release mutation)
  - `31042484160` — success; validate+build green; attest/publish skipped;
    tags unchanged
- Authority: post-rc.4 mechanics lane exercising the release-tag reconcile fix
