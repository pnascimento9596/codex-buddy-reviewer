# rc.5 Codex host evidence (lane-c2a)

Collected 2026-08-06 from the immutable `v0.5.0-rc.5` published artifact.
**Evidence class: machine-captured, human-unreviewed.** No owner eyeball attestation is claimed.

## Artifact and host identity

| Item | Value |
|---|---|
| Release | `v0.5.0-rc.5` prerelease |
| Tag object | `df9d02d6687333a7925d17f018591c3c8881ef8c` |
| Distribution commit | `c9f9c9b88f431abe006105f7a984f8f266b72d55` |
| Source commit | `5c99b9da910bfd916600a3f51d1aa9133d39a079` |
| Tarball SHA-256 | `ba9d537a4b45a9cf31d02a7b0d680fe8916c5ef71098a26ba65c18009917a543` |
| Artifact-content SHA-256 | `7c90bea1598f473c52b697bd39b30f40405f9a5568106bf11678eaaac9068b40` |
| Codex | `codex-cli 0.146.0` install; live turns after host update `0.146.1` |
| Install path | marketplace `codex plugin marketplace add … --ref v0.5.0-rc.5` then plugin add |
| Marketplace HEAD | distribution commit above; exact-match tag `v0.5.0-rc.5` |
| Kitty | `0.48.2` remote control |
| Host surface | Codex TUI in kitty; no GUI app required |
| Scratch workspace | disposable Git repo under external evidence dir (paths redacted here) |

## Marketplace install + .git-skip bind

Payload byte comparison (skip root `.git` only): extracted tarball == marketplace clone == plugin cache for all 130 manifest paths (0 content mismatches). First published-artifact exercise of marketplace install with PR #55 `.git` collector skip.

**Finding:** marketplace clone also contains `.codex-marketplace-install.json` (not in tarball). `verify-host-e2e collect --installed-snapshot <marketplace-clone>` fails `installed_snapshot_mismatch` (file_count 132 vs artifact 131). Clean extract as `--installed-snapshot` yields machine_complete. See issue #65.

## Machine host-e2e collect (turn1 dual findings)

`verify-host-e2e collect` against clean artifact snapshot + plugin runtime data dir:

| Machine check | Status |
|---|---|
| release_artifact | pass |
| installed_snapshot | pass (clean extract snapshot) |
| workspace_identity | pass |
| installed_pet (buddy-byte) | pass |
| continuation_observed | pass |
| turn_receipt | pass |
| review_completed_outbox | pass |

Manual host/visual gates left **pending** (machine-captured only; not promoted to manual_pass).

## Provider budget ledger

**Live unit (this lane):** one Buddy-enabled Codex turn that contacts a configured
reviewer at least once. Dual-lane work and any speculative activity inside that
same turn are **inside** the unit, not additional units. A turn is free only when
provider is `none` / zero-change local path with no reviewer subprocess.
Counting each provider subprocess separately was **not** the pre-authorized unit.

| Event | Doctor | Live | Notes |
|---|---:|---:|---|
| Ceiling | 2 | 4 | pre-authorized 2026-08-06 (Codex turns, not subprocesses) |
| doctor --provider-check dual | 2 | 0 | ollama pass; claude binary_missing (PATH) |
| turn3 no-change | 0 | 0 | provider none; free |
| turn1 planted off-by-one | 0 | 1 | dual findings; glm attribution match |
| turn2 multi-file helpers | 0 | 1 | one turn; speculative then exact-final inside unit; claude transport_exit partial |
| turn4 large dual ceiling | 0 | 1 | both failed ~17.5s stop |
| turn4b ollama-only ceiling | 0 | 1 | success ~8.0s stop; speculative then exact-final inside unit |
| **Used** | **2** | **4** | no overrun under the pre-authorized turn unit |

Codex implementer turns: 5 (turn3,1,2,4,4b) + pet/setup non-review interaction.
If live were redefined as each provider subprocess, turn2/turn4b exact-final
retries would raise the count above 4 — that is a different unit than authorized.

## Per-turn summaries (no private receipt dumps)

See:

- [`rc5-doctor-and-hooks.txt`](rc5-doctor-and-hooks.txt)
- [`rc5-turn3-no-change-egress.txt`](rc5-turn3-no-change-egress.txt)
- [`rc5-turn1-visible-review.txt`](rc5-turn1-visible-review.txt)
- [`rc5-stop-ceiling-and-adoption.txt`](rc5-stop-ceiling-and-adoption.txt)

### glm-5.2:cloud attribution defect check

On every ollama lane result in this lane, attributed provider/model remained ollama / glm-5.2:cloud. **No Claude identity self-report observed** in machine receipts this lane.

### Data lifecycle

Mode disabled; `data purge --confirm-purge` removed legacy-path rejected_responses/outbox entries reported by `data status`. Provider CLI auth hashes unchanged.

**Finding:** runtime receipts/outbox/turns for this install live under the plugins/data plugin identity root and remained after purge while `data status` primarily inventories the legacy codex-buddy-reviewer home. Dual-root accounting gap — issue #66.

## Unresolved / residue

1. Speculative receipt adoption at Stop — not observed (exact-final only).
2. Affirmative Stop-path duration >600s — not observed (fast provider return/fail).
3. Full five-pet visual manual bundle — out of scope per rc.4 disposition; machine pet install + selector text only.
4. Marketplace snapshot mismatch unless collector skips install metadata or operators use clean extract (#65).
5. data status/purge vs plugins/data runtime root split (#66).

## Closing

rc.5 published bytes install, bind, dual-review findings on a planted defect, no-change zero-egress, and machine collect of a successful dual turn are established. Adoption and >600s Stop survival remain open. Disposition #65/#66 before treating host-e2e as sealed for stable.

---

# rc.3 Codex host evidence

Collected on 2026-08-04 from the immutable `v0.5.0-rc.3` release artifact. This ledger separates automated state, visible host observations, and unresolved gates; a rendered legacy pet or an exact-final fallback is not relabeled as evidence for a different claim.

## Artifact and host identity

| Item | Value |
|---|---|
| Release | `v0.5.0-rc.3` prerelease |
| Release archive SHA-256 | `6de1ab3c4a47a96abbc5faf868d862d614a2e2a196fd4ec730f4b7c7b9d0b759` |
| Source commit | `0c6f09ae14d834fccb2a2289f6731511dbbdb034` |
| Distribution commit | `8782b70c5c664f5a73f9c225a802c71f1ff49ccf` |
| Distribution tree | `ac9ffe81aa3b170cf519ef1b35977a15f9cfae4b` |
| Codex | `codex-cli 0.146.0` |
| Installed plugin | `0.5.0-rc.3+codex.20260803011343` |
| Graphics terminal | Kitty `0.48.2`, `TERM=xterm-kitty` |
| Host surface | Codex TUI in terminal; no GUI app present or required |
| Scratch workspace | disposable genuine Git repository; path redacted in committed captures |

The verified rc.3 marketplace installation replaced the owner's earlier rc.2 installation. The rc.3 plugin and all five pet packages remain installed after this attempt. The normal Byte rollback record is retained as backup `1785853528846-7bd93ca0-4e6d-40a6-ab20-6831bf1631c9`.

## Capture methods

- `*.txt`: owned Codex TUI terminal-content capture, reduced to the exact relevant visible lines; ANSI/control bytes and personal paths removed.
- `*.png`: macOS window capture of the Kitty window. The screenshots contain the real Codex TUI pixels and are not generated or reconstructed images.
- Private automatic-review receipts and turn-state files were read locally to establish review-key identity and timing. They are not committed because they contain local operational paths and bounded private state.

## Skill discovery, enable, and doctor

| Observation | Result | Evidence |
|---|---|---|
| Native `/buddy-review` | **Fail as documented command**: Codex returned `Unrecognized command '/buddy-review'. Type "/" for a list of supported commands.` | [`command-discovery.txt`](command-discovery.txt) |
| Namespaced skill | **Pass**: `$codex-buddy-reviewer:buddy-review` loaded the installed rc.3 skill and executed its allowlisted command | [`skill-invocation.txt`](skill-invocation.txt) |
| Hook trust | **Manual pass**: the installed hook definition was accepted before the genuine task; subsequent `UserPromptSubmit` and Stop state proves the hook executed, but no automated receipt is promoted into a UI-attestation claim | [`skill-invocation.txt`](skill-invocation.txt), review receipts described below |
| Continuous mode | **Pass**: workspace-scoped mode visibly enabled for `ollama/glm-5.2:cloud` | [`enable-and-doctor.txt`](enable-and-doctor.txt) |
| Authorized provider check | **Pass**: `1/1 configured reviewer health checks passed` | [`enable-and-doctor.txt`](enable-and-doctor.txt) |
| First enable baseline | **Fail closed / UX residue**: `Buddy Review abstained because the exact start snapshot was unavailable.` No provider call was made | issue [#37](https://github.com/pnascimento9596/codex-buddy-reviewer/issues/37) |

The README and host docs now state plainly that the working invocation is `$codex-buddy-reviewer:buddy-review`; `/buddy-review` is not a native Codex slash command on the tested host.

## Exact-final fallback and speculative adoption

### First genuine changed task

The private baseline was captured at `2026-08-04T14:55:36.310Z`. Stop began exact-final review at `2026-08-04T14:56:50.396Z`.

| Field | Value |
|---|---|
| Review identity (SHA-256 digest) | `ce50eb16000bfdbc5ec90f39eaee9f3c995d3a301b82531e266e7aedec4f2290` |
| Baseline tree | `734757a28386e645649b28ae76be8eb4bcd4e0b5` |
| Final tree | `b6f6831de106d3a78e54142b8015b1085a32169e` |
| Changed paths | 3 |
| Provider/model | `ollama/glm-5.2:cloud` |
| Provider duration | 22,221 ms |
| Result | `no_findings` |
| Presentation | observed |

The automatic receipt, completed-turn record, and egress capability all carried the same key. No speculative key existed. The final Codex response preserved the implementation summary and appended the visible Buddy paragraph exactly once: [`exact-final-review-transcript.txt`](exact-final-review-transcript.txt).

### Authorized longer task

The longer task worked for 8 minutes 21 seconds. Its private pre-review state began with:

```json
{
  "generation": 1,
  "speculative_launches": 0,
  "worker_state": "debouncing",
  "active_review_key": null,
  "ready_review_key": null,
  "final_requested": false,
  "final_review_key": null
}
```

At Stop it recorded `worker_state: superseded`, still with zero speculative launches and no ready identity. Stop requested exact-final identity `e4a50a0ab46ae1aca7690942b4d5013ddac3137129de4a7abb32c9ca862ce918`.

| Field | Value |
|---|---|
| Baseline tree | `b6f6831de106d3a78e54142b8015b1085a32169e` |
| Final tree | `2c3ecca307bfe7c3d7a26f41f5a246c160a0c97e` |
| Changed paths | 8 |
| Provider/model | `ollama/glm-5.2:cloud` |
| Provider duration | 60,068 ms |
| Result | `no_findings` |
| Presentation | observed |

Again, the receipt and completed-turn key matched the exact-final key. Safety fallback passed; speculative adoption was not observed.

### Instrumented no-egress diagnosis

A third genuine task sampled worker state and Git/content fingerprints every two seconds. Codex was terminated after the speculative worker failed, before Stop could issue an exact-final request. The run created no attempt file, no new automatic-review receipt, and no provider call.

Source constants and eligibility established from `src/pre-review.mjs` and `src/turn-snapshot.mjs`:

- state poll: 100 ms;
- generation debounce and checkpoint confirmation delay: 1,500 ms each;
- fallback checkpoint poll and mode revalidation: 30,000 ms;
- two speculative generations maximum;
- each `captureTurnSnapshot` performs two matching full captures, and stable checkpoint confirmation performs another complete snapshot after the delay;
- untracked paths are included and may be eligible when complete;
- provider eligibility requires at least one complete transmitted path, complete privacy coverage, remaining budget, and unchanged enabled/continuous/consented mode revision.

Measured state:

| Interval | Duration |
|---|---:|
| No pre-review state while the exact baseline was captured | 20.4 s |
| Worker in `capturing` with its PID alive | 278.8 s |
| First unchanged content fingerprint | 205.6 s |
| Second unchanged fingerprint | 4.0 s |
| Third unchanged fingerprint | 89.5 s |

Terminal worker state:

```json
{
  "generation": 1,
  "speculative_launches": 0,
  "worker_state": "failed",
  "active_review_key": null,
  "ready_review_key": null,
  "final_requested": false,
  "final_review_key": null
}
```

A direct quiescent `captureTurnSnapshot` immediately afterward succeeded in 2,607 ms over 11 paths, producing tree `80962d5db49bdd70a7922fe7d10a75229ff597dc` and status hash `5d398b6b2a810ddd683fe303cbc122b1b0635215b4d3a7ab1cb44ce01662ef3a`.

**Disposition:** stable windows far exceeded the 1.5-second debounce, but the detached checkpoint path never published a candidate review key and eventually failed before egress. The exact internal exception is unavailable because detached stderr is discarded and only `worker_state: failed` is persisted. P1 issue [#36](https://github.com/pnascimento9596/codex-buddy-reviewer/issues/36) tracks durable failure diagnostics and the concurrency-state-machine correction. The stable speculative-adoption gate remains **open** until a post-fix real host adopts an exact matching speculative receipt without a second provider execution.

Provider ledger for Part A: one authorized doctor health check, two exact-final live review turns, and zero calls from the instrumented diagnostic task.

## Pet host evidence

Apple Terminal and `/usr/bin/screen` produced this exact disposition:

> Pets aren't available in this terminal. Terminal pets need image support, and this terminal environment doesn't expose a supported image protocol. Try a terminal with Kitty graphics or Sixel support, or run Codex outside tmux.

Kitty removed that graphics-protocol blocker. It rendered the owner's legacy ambient `bella` and `lupo` packages:

| File | Visible state | UTC capture | SHA-256 |
|---|---|---|---|
| [`bella-ready.png`](bella-ready.png) | legacy Bella, Ready | 2026-08-04T11:14:43Z | `4c35aaf9bfdb4320e63f39f37c6840bc4df8fa53e95a885b6f1749660d3b17a3` |
| [`bella-running.png`](bella-running.png) | legacy Bella, Running during genuine Codex work | 2026-08-04T11:19:48Z | `50aac50d72e76e4436d057e8bd2ad4cc77eacbcd6b45f61d8ad01a9994bbf7e6` |
| [`bella-ready-after-review.png`](bella-ready-after-review.png) | legacy Bella, Ready after exact-final review | 2026-08-04T11:24:35Z | `1d501e7eb65d8a666c25164b9fbb045c5d0e585f6e3f77e6c5ee5d74d16a427e` |
| [`lupo-ready.png`](lupo-ready.png) | legacy Lupo, Ready | 2026-08-04T11:25:08Z | `a5e897a8988dadde4e9ce827a5e20fd06e9da1efffd63ee4e6e95969b018f966` |

These images prove graphics-capable native rendering and genuine Running/Ready transitions. They do **not** prove the released `buddy-bella` or `buddy-lupo` packages.

Buddy's rc.3 installer reports Byte, Mochi, Orbit, Bella, and Lupo all `installed`, but Codex 0.146.0 did not expose any `buddy-*` package in `/pet`; filtering for Byte returned no matches. The TUI also emitted:

```text
Failed to load pet: load ambient pet
```

The v2 packages use 1536x2288 atlases and `spriteVersionNumber: 2`; working legacy packages use 1536x1872 atlases without that field. A reversible Byte probe removing only `spriteVersionNumber` remained undiscoverable, and the original manifest was restored byte-for-byte. P1 issue [#38](https://github.com/pnascimento9596/codex-buddy-reviewer/issues/38) tracks the host/package compatibility contract.

**Historical rc.3 disposition:** terminal graphics support passed in Kitty, but the five released-pet host gate failed at that time. Byte, Mochi, Orbit, `buddy-bella`, and `buddy-lupo` could not honestly be cycled or captured because the tested host did not list them. The corrected package/host contract and later exact-artifact bundle are recorded in the post-fix and published-rc.4 sections below; this historical entry is not current stable-release status.

See [`pet-terminal-limitation.txt`](pet-terminal-limitation.txt) for the compact visible-host record.

## Gate summary (rc.3 historical)

| Gate | Disposition |
|---|---|
| Verified published artifact installation | pass |
| Namespaced skill invocation | pass |
| Native `/buddy-review` documentation | corrected in source; rc.3 behavior documented |
| Hook execution and workspace mode | pass |
| Authorized provider doctor check | pass |
| Exact-final safe fallback | pass twice |
| First-enable baseline UX | fail-closed pass; issue #37 |
| Speculative adoption | **blocked by #36 on rc.3; closed post-fix below** |
| Kitty graphics rendering | pass for legacy ambient pets |
| Five released v2 pets | **blocked by #38 on rc.3; closed post-fix below** |
| Stable promotion | **not ready** (see current readiness ledger) |

## Restoration (rc.3 attempt)

Continuous mode was explicitly disabled at `2026-08-04T18:20:05.165Z`, clearing continuous-review consent. Workspace purge then ran with settings included. Final status reported:

```json
{
  "mode_enabled": false,
  "active_provider_capabilities": 0,
  "content_files": 0,
  "content_bytes": 0,
  "settings_files": 0,
  "settings_bytes": 0,
  "provider_temporary_files": 0,
  "provider_temporary_bytes": 0,
  "live_provider_runs": 0
}
```

Shared pet ownership and rollback state remained intentionally outside workspace review-content purge: 14 files / 13,232 bytes, including the Byte backup named above. The rc.3 marketplace plugin and five installed pet packages remain in place.

No stable release was dispatched, no release/tag was mutated, and no published rc.3 artifact was edited.

---

# Post-fix host evidence (2026-08-05)

Collected after protected merges `#44` (`3ac754b`), `#45` (`23784a3`), and `#46` (`866e359`). Marketplace slot held a **dev verification install** of protected main; the immutable published `v0.5.0-rc.3` release was not mutated.

## Speculative adoption

| Field | Value |
|---|---|
| Host | Codex CLI `0.146.0` in Kitty `0.48.2` |
| Review identity | `5a646cf08ad7402bf40ba41ccce08faa7efb73b356953406b4dfce8265cfd489` |
| Speculative launches | 2 (live worker PIDs observed) |
| Automatic-review created | `2026-08-05T02:52:08.345Z` |
| Completed | `2026-08-05T02:53:01.371Z` |
| Outcome | `findings` |
| Provider | `ollama` / `glm-5.2:cloud` / 29616 ms |
| Changed paths | 4 |
| Baseline tree | `83708e17eca1956897521df6c20449ae75f54bcb` |
| Final tree | `0d35f4be81ebaa1305908e8dd478cd2112062215` |
| Outbox order | `turn_started` → `review_started` ×2 → `turn_finished` → `review_completed` |
| Second provider at Stop | **none** (no `review_started` after `turn_finished`) |

Evidence: [`speculative-adoption-2026-08-05.txt`](speculative-adoption-2026-08-05.txt)

**Root causes closed on #36:** (1) snapshot-changed escaped to terminal `failed`; (2) detached worker drained the event loop via non-persistent watch + unref'd timers.

## Five-pet selectability

After packaging host-compatible 8×9 / 1536×1872 atlases and host-shaped manifests, `/pet` lists Byte, Mochi, Orbit, buddy-Bella, and buddy-Lupo.

| Evidence | Content |
|---|---|
| [`pet-selector-byte.txt`](pet-selector-byte.txt) | filter Byte match |
| [`pet-selector-mochi.txt`](pet-selector-mochi.txt) | filter Mochi match |
| [`pet-selector-orbit.txt`](pet-selector-orbit.txt) | filter Orbit match |
| [`pet-selector-all.txt`](pet-selector-all.txt) | unfiltered list excerpt |

Pixel window capture was blocked by ScreenCaptureKit/TCC automation limits in this environment. Terminal-content capture is the committed host method for this pass.

**Root cause closed on #38:** rc.3 shipped extended 8×11 atlases; Codex 0.146.0 accepts the base 8×9 grid only.

## Post-fix gate summary

| Gate | Disposition |
|---|---|
| Speculative adoption | **pass** (exact key match; no second Stop provider) |
| Five released pets selectable on fixed packages | **pass** (Byte/Mochi/Orbit + buddy-Bella/Lupo listed); artifact-bound host-e2e bundle still required for stable publication |
| Published rc.3 immutability | preserved |
| Stable promotion | still requires owner instruction + remaining residue (#37, Windows DACL, governance) |


---

# Published rc.4 host evidence (2026-08-05)

Collected against the immutable published `v0.5.0-rc.4` artifact only (not a dev `main` install).

## Artifact and host identity

| Item | Value |
|---|---|
| Release | `v0.5.0-rc.4` prerelease |
| Release archive SHA-256 | `2ba45154d1e5c5218900b295412744ea9cfa1fe3a452085f9f77693651453df7` |
| Artifact tree SHA-256 (collector) | `39171a1b15eb0187483fbf06771152293ca89b00a0da7f26a0242017169dd7e6` |
| Source commit | `b56224fb8e37ca02e071cda41702af4ef20f1ebb` |
| Distribution commit | `ac9f870f455645613c9f3dc8de4196fdc8a25d6d` |
| Release run | `31013433126` attempt 2 |
| Codex | `codex-cli 0.146.0` |
| Installed plugin | `0.5.0-rc.4` from marketplace `--ref v0.5.0-rc.4` |
| Graphics terminal | Kitty `0.48.2` |
| Host surface | Codex TUI in terminal; no GUI app required |
| Host-e2e v2 bundle | validated complete (`schema_version` 1, 5 reports); gzip+b64 3992 bytes under local excluded evidence |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| Verified published artifact install | pass | marketplace ref `v0.5.0-rc.4`; release-manifest hash match |
| Native `/buddy-review` | fail as documented | [`rc4-command-discovery.txt`](rc4-command-discovery.txt) |
| Namespaced skill | pass | same |
| Hook trust | manual_pass | UserPromptSubmit + Stop executed |
| Enable + #37 baseline message | pass | [`rc4-enable-and-doctor.txt`](rc4-enable-and-doctor.txt) |
| Authorized doctor provider check | pass (1/1) | same |
| Speculative adoption on published artifact | **pass** | [`rc4-speculative-adoption-2026-08-05.txt`](rc4-speculative-adoption-2026-08-05.txt) — key `425a466f…`; review_started before turn_finished; no second review_started |
| Five-pet selectability | pass | [`rc4-pet-selector-*.txt`](rc4-pet-selector-all.txt) |
| Compact output | pass | 274 chars |
| Disable + purge | pass | remaining content files 0; pets retained outside scope |
| Host-e2e v2 bundle validate-bundle | **pass** | private bundle bound to artifact; all five public pets |

## Provider ledger (this published-artifact pass)

Budget: 1 doctor + ≤3 live review turns.

1. `doctor --provider-check` — 1/1 ollama/glm-5.2:cloud pass  
2. Multi-file adopted review `425a466f551ae40d38558c6d50ed24b5b152100520e6289b54c5b222a21a6b27` — findings, 12888 ms  
3. Concurrent speculative sibling receipt `068784493a1ca39bad9d3aae9fbbeb45232f43ac678688474f4148948d30b18b` — findings, 14039 ms (not Stop-presented)  

Local `no_findings` with `provider: none` on an empty-delta exit turn is not a provider call.

## Pixel note

ScreenCaptureKit/TCC blocked automated window capture. Terminal-content capture remains the committed method for pet selector and TUI state.
