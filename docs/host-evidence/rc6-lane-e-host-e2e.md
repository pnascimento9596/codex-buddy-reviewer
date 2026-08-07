# rc.6 Codex host evidence (lane-e)

Collected 2026-08-07 from the immutable `v0.5.0-rc.6` published artifact.
**Evidence class: machine-captured, human-unreviewed.** No owner eyeball attestation is claimed.

## Artifact and host identity

| Item | Value |
|---|---|
| Release | `v0.5.0-rc.6` prerelease |
| Tag object | `e409d32245465dae563fef94ecbeb56755bd642c` |
| Distribution commit | `ad6a01b308cac2cf6ebd953aecdf93e45cbd315a` (parent count 0) |
| Distribution tree | `20d90b09d730343b9bae2e8ce5bf247648c60c3c` |
| Source commit (dispatch head) | `9be1a9dea4741f7765ebb648941b629672246003` |
| Release run | `31171295831` attempt 1 |
| Tarball SHA-256 | `f594e59ff31ac8674078b0d8c1c6d00edba9a8d0c3c6710f569de1208a77e190` |
| Bundle SHA-256 | `9440243ba5bfcbc035883acf40550e186f5f588b8980f7e3fce3e153af5d5964` |
| Receipt JSON SHA-256 | `39bcbb41479b0af60d97e8a590e873651a7501a3474ab83f6b9122bee7a1d82b` |
| Artifact-content SHA-256 | `7a210d99d0dedd49453500b59672f2aeea6e1980a1cbfce1d19800ddd72c6b5d` |
| Release-manifest SHA-256 | `1819faa8100811f04d33b57f4cecc796ea87a05d13cd7cdb6b6532dfc233f760` |
| Codex | `codex-cli 0.146.1` |
| Install | marketplace remove/add `--ref v0.5.0-rc.6` then plugin add |
| Marketplace HEAD | distribution commit above |
| Installed hooks | UserPromptSubmit `210`, Stop `1890` |
| Host surface | Codex CLI `exec` (non-interactive); no GUI required |
| Scratch workspace | disposable Git repo under `/tmp` (paths redacted in public text) |

## #65 installed-snapshot bind (first real exercise on rc.6)

Published `verify-host-e2e` inspect logic exercised three ways (machine-captured):

| Case | Result |
|---|---|
| A. Live marketplace root (no `.codex-marketplace-install.json` on this Codex 0.146.1 buddy install) | **pass** — payload 131 files; snapshot_sha256 `c8a08bb2cc4cabc4f2b165fed693566bab32a26d214ca81843a64833d91adf7f` |
| B. Same payload + schema-valid root `.codex-marketplace-install.json` only | **pass** — marketplace_install_present=true; payload hash unchanged |
| C. Extra non-manifest file alongside | **fail** `installed_snapshot_mismatch` (expected) |

Verdict: **#65 PASS** on published rc.6. Note: unlike some other marketplaces on this host, the buddy marketplace clone did not write `.codex-marketplace-install.json`; case B proves the schema-checked tolerance path.

## Provider budget ledger

| Event | Doctor | Live turns | Notes |
|---|---:|---:|---|
| Ceiling | 2 | 3 | authorized 2026-08-07 |
| doctor `--provider-check` dual | 2 | 0 | ollama/glm-5.2:cloud **pass**; claude/claude-opus-4-8 **fail** `transport_exit` (1/2) |
| turn1 adoption re-probe (two-phase edit) | 0 | 1 | exact-final; speculative gen-1 started |
| turn2 stop-duration bulk (40 files) | 0 | 1 | stop ~12s; `invalid_pre_review_receipt` after ~4s review attempt |
| turn3 adoption redesign (single edit + idle) | 0 | 1 | **ADOPTION** |
| **Used** | **2** | **3** | within ceiling |

Codex implementer inference is outside the ceiling (recorded: 3 `codex exec` turns). Claude remained degraded (`transport_exit` / `circuit_open`); dual config retained; no product edits.

## Per-turn machine records (no private receipt dumps)

### Turn 1 — adoption re-probe (two-phase)

| Field | Value |
|---|---|
| session_key | `e2541c9ea243d78a9d64ef96` |
| turn_key | `48b67a0dba390773b443d10b` |
| Classification | **exact-final**, not adoption |
| Speculative | yes — `review_started` 2026-08-07T11:08:59Z before finish; receipt key `807ec415…` |
| Final key | `9cd6a48c…` (differs — phase2 edit after gen-1) |
| Post-Stop `review_started` | yes (both lanes) |
| Visible paragraph chars | 176 (≤700) |
| Attribution | ollama/glm-5.2:cloud succeeded; claude incomplete (partial) |
| Diagnosis | Gen-1 matched phase1-only tree; phase2 commit immediately before Stop left no gen-2 window (`checkpointPollMs=30000`); product correctly took exact-final |

### Turn 2 — Stop >600 s probe

| Field | Value |
|---|---|
| session_key | `7eb628aa474952d6109324b6` |
| turn_key | `7cf4e05fd3a87383557729ad` |
| Changed paths | 40 |
| Unstaged patch size before commit | ~677408 bytes (> configured `max_patch_bytes` 262144) |
| `turn_finished` | 2026-08-07T11:11:58.109Z |
| `review_started` | 2026-08-07T11:12:06.212Z (post-Stop) |
| Terminal | `review_degraded` / `invalid_pre_review_receipt` at 2026-08-07T11:12:10.531Z |
| Measured Stop-path span | **~12.4 s** finish→degraded; provider attempt ~4 s |
| Clamp / mid-flight kill warnings | none observed in exec log |
| ollama duration_ms | 2770 (receipt meta) |
| claude | failed `transport_exit` 1246 ms |
| Verdict on >600 s | **NOT proven** (providers returned in seconds). 1890 s unenforced host claim remains open |

### Turn 3 — adoption redesign (flex)

| Field | Value |
|---|---|
| session_key | `8c4e384d884f0c132f64ae65` |
| turn_key | `6c58eaa0086cdcf28678fb2b` |
| Classification | **ADOPTION** |
| Speculative starts | 2026-08-07T11:13:15Z and 11:13:27Z (both before finish) |
| Speculative receipt ready | 2026-08-07T11:13:41.287Z key `8f5255e852b20e9d…` |
| `turn_finished` | 2026-08-07T11:14:21.388Z |
| `review_completed` | 2026-08-07T11:14:21.830Z |
| Post-Stop `review_started` | **none** |
| Completed key | `8f5255e852b20e9d…` (matches speculative) |
| Visible paragraph chars | 433 (≤700) |
| Attribution | ollama/glm-5.2:cloud succeeded 13825 ms; claude `circuit_open` |
| Design | single edit + commit + sleep 50s + no second edit |

## #66 multi-root purge (first real exercise on rc.6)

Before purge, `data status` enumerated runtime roots including:

- `…/plugins/data/codex-buddy-reviewer`
- `…/plugins/data/codex-buddy-reviewer-codex-buddy-reviewer` (live content for this workspace)
- `…/plugins/data/codex-buddy-reviewer-personal`
- legacy `…/codex-buddy-reviewer`

After `mode disable` + `data purge --confirm-purge` for the scratch workspace:

| Assertion | Result |
|---|---|
| automatic-reviews for workspace key | **gone** (directory absent) |
| outbox events for workspace key | **gone** |
| retained turn `completed.json` markers | 3 (purge reported `retained_turn_tombstones: 3`) — content-free at-most-once delivery records, not receipt bodies |
| circuit files | 2 small breaker-state files retained |
| mode/presentation/egress settings | retained (not review content) |
| Other workspaces' historical data under sibling roots | untouched (workspace-scoped purge) |

Filesystem-level verdict: **#66 PASS** for receipt/outbox clearance on every runtime root used by this workspace identity, with explicit retention of at-most-once turn markers and circuit state.

## Unverified / open

| Item | Settling check |
|---|---|
| Stop-path host survival >600 s | Not observed; needs a turn where provider wall-clock exceeds 600 s without capture truncation |
| Host enforcement of 1890 s Stop hook | Unrun at multi-minute scale |
| Claude transport health on doctor | `transport_exit` under buddy args; binary works interactively — host/config residue, not rc.6 product edit in this lane |
| Security-scan seal of post-host-e2e head | Not authorized this lane |
| Owner browser Security Log pads | Owner-only |

## Statements

- Exactly one release dispatch this lane (`31171295831`).
- Provider inference within ceiling: doctor 2/2, live turns 3/3.
- Tags `v0.5.0-rc.1`…`rc.6` only; rc.1–rc.5 objects unchanged via `ls-remote` after publish.
