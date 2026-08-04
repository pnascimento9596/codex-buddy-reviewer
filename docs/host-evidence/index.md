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
| Review key | `ce50eb16000bfdbc5ec90f39eaee9f3c995d3a301b82531e266e7aedec4f2290` |
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

At Stop it recorded `worker_state: superseded`, still with zero speculative launches and no ready key. Stop requested exact-final key `e4a50a0ab46ae1aca7690942b4d5013ddac3137129de4a7abb32c9ca862ce918`.

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
| [`bella-ready.png`](bella-ready.png) | legacy Bella, Ready | 2026-08-04T11:14:43Z | `b73713465fefb721da3ee4fd614eaccb53aaf99ecdc8c6e44b6a777b92b6b644` |
| [`bella-running.png`](bella-running.png) | legacy Bella, Running during genuine Codex work | 2026-08-04T11:19:48Z | `89c1dc7dc22fa4614c33f1ec708b65c2805241b656b65ce6dffe661fd914196c` |
| [`bella-ready-after-review.png`](bella-ready-after-review.png) | legacy Bella, Ready after exact-final review | 2026-08-04T11:24:35Z | `5f36b2cbc23e6f5dd6ae924fc2a7e4be2d8269e20d4589c4da9a78784d227872` |
| [`lupo-ready.png`](lupo-ready.png) | legacy Lupo, Ready | 2026-08-04T11:25:08Z | `896a203d2a9928eacedaf2fe538c603c21cf318e07be7980b3e7265a3e31f4e2` |

These images prove graphics-capable native rendering and genuine Running/Ready transitions. They do **not** prove the released `buddy-bella` or `buddy-lupo` packages.

Buddy's rc.3 installer reports Byte, Mochi, Orbit, Bella, and Lupo all `installed`, but Codex 0.146.0 did not expose any `buddy-*` package in `/pet`; filtering for Byte returned no matches. The TUI also emitted:

```text
Failed to load pet: load ambient pet
```

The v2 packages use 1536x2288 atlases and `spriteVersionNumber: 2`; working legacy packages use 1536x1872 atlases without that field. A reversible Byte probe removing only `spriteVersionNumber` remained undiscoverable, and the original manifest was restored byte-for-byte. P1 issue [#38](https://github.com/pnascimento9596/codex-buddy-reviewer/issues/38) tracks the host/package compatibility contract.

**Disposition:** terminal graphics support passed in Kitty, but the five released-pet host gate failed. Byte, Mochi, Orbit, `buddy-bella`, and `buddy-lupo` could not honestly be cycled or captured because the tested host did not list them. Stable promotion remains blocked pending a corrected package/host contract and a repeated five-pet real-host run.

See [`pet-terminal-limitation.txt`](pet-terminal-limitation.txt) for the compact visible-host record.

## Gate summary

| Gate | Disposition |
|---|---|
| Verified published artifact installation | pass |
| Namespaced skill invocation | pass |
| Native `/buddy-review` documentation | corrected in source; rc.3 behavior documented |
| Hook execution and workspace mode | pass |
| Authorized provider doctor check | pass |
| Exact-final safe fallback | pass twice |
| First-enable baseline UX | fail-closed pass; issue #37 |
| Speculative adoption | **blocked by #36** |
| Kitty graphics rendering | pass for legacy ambient pets |
| Five released v2 pets | **blocked by #38** |
| Stable promotion | **not ready** |

## Restoration

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
