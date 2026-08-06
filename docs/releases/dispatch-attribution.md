# Release dispatch attribution (out-of-artifact)

This file records pre-dispatch attribution statements for protected release
workflow runs. It lives under `docs/releases/`, which is **not** part of the
published public artifact path set (see `release/public-files.json` and the
built inventory). Writing here does not change public artifact bytes.

Historical attribution text that already shipped inside `docs/VALIDATION.md`
(Layer A) remains frozen there. New dispatches append here instead of editing
the in-artifact validation record.

## How to use

Immediately before a protected `workflow_dispatch` of
`.github/workflows/release.yml`, append a dated section naming:

- the exact protected-main source SHA that will be dispatched;
- the exact `version` and `publish` inputs;
- the GitHub account that will perform the dispatch;
- the owner instruction or lane authority that authorized the dispatch.

GitHub can establish account, workflow, source, and approval attribution. It
cannot establish which person or delegated local session operated an authorized
account token.

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
