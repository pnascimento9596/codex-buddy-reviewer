# Changelog

All notable changes to Codex Buddy Reviewer are documented here. Release candidates remain evidence-bound to exact source, automated validation, independent review, and protected publication. Adoption-scale human host observations are intentionally deferred until real users or pull requests make them useful.

## 0.5.0 - 2026-08-07

First stable release of the v0.5 line. Cumulative highlights since rc.1:

### Highlights (rc.1 → stable)

- **Egress authorization boundary (v0.5).** Provider-capable work uses a dedicated provider lane, short mode/summary-consent locks for capability issuance, then durable single-use capability spend before inference. Mode and summary-consent mutations drain prior-revision capabilities before returning.
- **Dual independent reviewers.** Concurrent primary/secondary lanes with per-connection circuit breakers; partial success when one lane fails; no silent provider substitution.
- **Speculative continuous review.** At most two pre-Stop generations plus exact-final fallback; adoption of exact ready receipts without a second provider call (proven on published rc.4 artifact and re-proven at rc.6 host-e2e Turn 3).
- **Native host pets.** Five public pets (Byte, Mochi, Orbit, Bella, Lupo) on Codex 0.146-compatible 8×9 atlases; first-enable baseline UX; speculative-worker keepalive and snapshot-retry.
- **Publication and release machinery.** Deterministic public artifact, parentless distribution commit, annotated tags via `ensure-release-tag` (post-push REST race fixed), SLSA attestations, host-evidence v2 bundle gate for final publish.
- **Privacy / publication scanners.** Filter-free Git evidence, structured publication payloads, tree-only and full-history publication boundary modes.

### Operator-critical fixes landing in this stable

- **#65 marketplace snapshot bind.** Installed-snapshot bind tolerates exactly one schema-valid root `.codex-marketplace-install.json`; extra files still fail.
- **#66 multi-root data purge.** `data status` / `data purge` enumerate plugins/data identity roots and the legacy durable data-dir.
  - **Purge once more after upgrade:** operators who purged under rc.5 (or earlier) while automatic review wrote under `~/.codex/plugins/data/...` should disable automatic review and run `data purge --confirm-purge` again so every root is cleared.
- **Claude auth classification.** Claude Code OAuth/auth failure envelopes classify as `auth_unavailable` instead of generic `transport_exit` (exit 0/1 accepted so stdout can be inspected — same lesson as OpenCode).
- **Packaged Windows x64 Job Object helper.** Reviewed hash-pinned `bin/win32-x64/buddy-job-supervisor.exe` is required for final-semver packaging. ARM64 remains unavailable. Live Windows provider egress remains **blocked** until DACL work ships.

### Documented limitations (stable)

- **Windows live provider egress:** SHIPS BLOCKED (rc.1-era posture, enforced in code). DACL + live Windows egress is post-stable engineering.
- **Stop >600 s host enforcement:** configured hooks 210/1890 confirmed at rc.5/rc.6; end-to-end enforcement beyond ~17.5 s never observed. rc.6 oversized-evidence probe fail-closed via `invalid_pre_review_receipt` (~12.4 s Stop path).
- **Speculative adoption:** PROVEN at rc.6 (Turn 3, key-matched, no post-Stop `review_started`).
- **#62 consent-lock (Windows Node 24):** characterized as test-observed timing (1 s observation window); product `withFileLock` try/finally releases on throw; test window widened to 10 s.
- **#63 pid-0 origin:** open; positive-integer guard landed earlier; origin path still tracked.
- **Five-pet human observation:** satisfied by machine-captured artifact-bound bundles at rc.4/rc.5/rc.6 with human-unreviewed label — stable evidentiary basis is machine capture, deliberately.
- **Claude dual-reviewer doctor health:** requires a valid Claude Code OAuth session on the host; expired OAuth is reported as `auth_unavailable`.

### Release status

- Prepared for publication only from the exact protected `main` head through the guarded release workflow with `version: 0.5.0` and `publish: true` under owner standing authorization. Do not treat this changelog entry alone as dispatch authorization.

## 0.5.0-rc.6 - 2026-08-07

### Fixed

- **#66 (PR #69).** `data status` and `data purge` now enumerate every runtime root the installed plugin identity may have used: explicit `--runtime-data-dir`, host `PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA`, discovered non-symlink directories under `<CODEX_HOME>/plugins/data/` matching the buddy plugin identity, and the legacy durable data-dir. Status reports and purge clear workspace content under all of those roots. Content-free turn tombstones and capability at-most-once records remain. Symlinked plugin-data discovery entries are ignored so purge cannot be pointed at arbitrary paths.

  **Operator note (rc.5 and earlier):** If you ran `data purge --confirm-purge` while automatic review had written receipts under `~/.codex/plugins/data/...`, that purge could report success while runtime receipts/outbox/turns remained on disk. After installing a build with this fix, disable automatic review and run `data purge --confirm-purge` once more so every root is cleared.

- **#65 (PR #69).** Host-e2e installed-snapshot bind tolerates exactly one root-level `.codex-marketplace-install.json` after schema-checking it as host metadata (`source_type`/`source`/`ref_name`/`sparse_paths`/`revision`; no extra fields). Nested path, other extra files, or invalid schema still fail the bind. Root `.git` skip from PR #55 is unchanged. Runbook updated. Report/bundle validation reuses the same strict marketplace schema as collect.

### Observed on rc.5 host-e2e (lane-c2a; machine-captured, human-unreviewed)

- Marketplace install of published `v0.5.0-rc.5` binds payload bytes (modulo install metadata, fixed in this RC).
- Dual-review planted off-by-one detected; no-change turn zero egress.
- Speculative adoption unobserved on rc.5 (accepted residue; re-probe at rc.6 host-e2e). Lifecycle/adoption code is byte-identical to rc.4 source except `src/filter-free-git.mjs`.
- Stop-path duration >600 s unproven (open; re-probe at rc.6 host-e2e). Hook timeout configuration is the rc.4→rc.5 delta.
- glm-5.2:cloud attribution matched configured model in observed turns; per-result check remains mandatory.

### Release status

- This remains an RC. It is prepared for publication only from the exact protected `main` head through the guarded release workflow with `version: 0.5.0-rc.6`. Do not treat this changelog entry as dispatch authorization. Exact-head security re-scan remains open on the post-fix promotion head after rc.6 host-e2e. Windows DACL and owner governance residue are unchanged.

## 0.5.0-rc.5 - 2026-08-06

### Fixed

- **PR #54 (`bd98446`).** Release publication no longer fails closed on a post-push REST race: after a successful annotated-tag push, `ensure-release-tag` verifies the remote tag object with bounded backoff and treats an already-matching remote tag as success. Genuine tag mismatches still fail closed. Root cause was run `31013433126` attempt 1 (~322 ms after push); attempt 2 published without rewriting attempt-1 attestations.
- **PR #55 (`0df21e8`).** Full-suite test runner budget raised from 900 s to 1200 s after macOS CI cancelled `tests/automatic.test.mjs` at aggregate ~897.6 s (`fail 0 / cancelled 1`, not a single hung test). Deadline-cleanup waits for the child PID before asserting; hook invoke test budget raised. Host-e2e marketplace installs may carry a root `.git` (clone); verification binds plugin payload bytes and skips only that install-method metadata.
- **PR #57 (`5d5c34f`).** Security-scan reproduced defects:
  - Git `check-attr --source` on unsupported Git versions fails closed with named `git_version_unsupported` instead of opaque batch failure or silent omission of historical attribute checks.
  - Windows job-supervisor ERROR path exits 125 (Node contract) instead of always 124.
  - **Configured** host hook timeouts in `hooks/hooks.json`: `UserPromptSubmit` 60→**210** s and `Stop` 600→**1890** s so the declared values sit above the product capture ceiling (180 s) and default provider ceiling (1800 s).

### Hook timeout host enforcement (UNVERIFIED)

Codex CLI **0.146.0** is known to clamp **SessionEnd** hook timeouts (observed clamp warning to 3 s on the official `openai-codex` plugin). No installed-schema or binary string evidence was found that SessionEnd-style clamps also apply to `UserPromptSubmit` 210 or `Stop` 1890. The official `openai-codex` plugin ships `Stop: 900` without a documented Stop clamp. **Whether the host honors Buddy's 210 / 1890 values end-to-end is unverified without a host session observation.** Until that check lands, treat the PR #57 hook change as a correct configuration relative to product ceilings, not as proven host behavior. Owner-observable check: install the candidate, run a continuous-mode turn whose provider work approaches the configured ceiling, and confirm Codex does not emit a clamp warning or SIGKILL the hook before the product deadline.

### Changed

- Security-scan gate wording: dispatch attribution for new releases is recorded under `docs/releases/dispatch-attribution.md` (out of the public artifact) with a two-phase pre/post-dispatch protocol that does not invent a future SHA. The stable-readiness gate ledger remains on the scan surface. Pure version-identity bumps after a sealed scan require an explicit ledger disposition; scan-surface edits still re-open the gate. See `docs/releases/v0.5.0-stable-readiness.md`.
- `actions/attest` pin advanced to v4.2.1 via PR #27 (`19c8e89`) so the next release mints attestations from a CI-verified current action.

### Release status

- This remains an RC. It is prepared for publication only from the exact protected `main` head through the guarded release workflow with `version: 0.5.0-rc.5`. Do not treat this changelog entry as dispatch authorization. Exact-head security re-scan of the final promotion head remains open under the rewritten gate. Windows DACL and owner governance residue are unchanged.

## 0.5.0-rc.4 - 2026-08-05

### Fixed

- **#36 (both defects), PRs #44 and #46.** Speculative pre-review no longer terminalizes on ordinary mid-capture churn: `turn snapshot changed during capture; retry` returns to debounce instead of `worker_state: failed` (PR #44 / `3ac754b`). Detached workers also keep the event loop alive while idle — non-persistent `fs.watch` and unref'd timers previously let Node exit under a top-level await with no live PID and zero launches (PR #46 / `866e359`).
- **#38, PR #45 (`23784a3`).** Public pet packages ship Codex 0.146-compatible base **8×9 / 1536×1872** atlases and host-shaped manifests. rc.3's extended 8×11 / 1536×2288 look-direction atlases were a packaging defect relative to the host contract, not a graphics-protocol failure.
- **#37, PR #50 (`065c470`).** First-enable UX is explicit: mode enable does not capture a baseline; the next Codex turn establishes the private start snapshot at prompt submit; mid-turn enable does not invent a missing baseline. Fail-closed no-provider / no whole-tree-fallback behavior is unchanged.

### Observed on real host (post-fix, pre-rc.4 publish)

- Speculative adoption: exact ready key matched completed key with no second provider execution at Stop (evidence under `docs/host-evidence/`, PR #48).
- Five-pet selectability on fixed packages: Byte, Mochi, Orbit, Bella, and Lupo listed in `/pet` (terminal-content captures; ScreenCaptureKit/TCC blocked pixel screenshots).
- Stale/mismatched ready≠completed keys correctly rejected (supersession invariant); Stop did not adopt a non-matching speculative receipt.
- Prior real-host verification provider overrun recorded honestly: budget 4 live review turns, used 5+ after discovering the second #36 root cause mid-verify (doctor + two exact-final turns + mismatched-key turn + gate-closing adoption turn).

### Release status

- This remains an RC. Artifact-bound five-pet host-e2e bundle validation against the published rc.4 artifact is still required before stable `v0.5.0`. Windows current-user-only DACL and live Windows provider egress remain deferred. Owner governance residue is unchanged.

## 0.5.0-rc.3 - 2026-08-03

### Reviewed

- The bounded Phase 2 independent review pinned exact source/tree identities and used OpenAI Codex `gpt-5.6-sol` plus Ollama Cloud `glm-5.2:cloud`; every accepted claim was reproduced locally before implementation. Invocation evidence, not the GLM route's incorrect Claude self-identification, remains authoritative.
- PR #15 separated current validation claims from frozen publication evidence. PRs #23 and #24 then added mutation-controlled adversarial corpus coverage and a strict checked-JavaScript gate for the five authorized review-boundary modules.

### Defects found

- The Phase 2 review found silent private turn-snapshot cleanup failures, loss of cleanup warnings when adopting or replaying continuations, and unsafe orphan pruning when a turn-session inventory is unreadable.
- It also found that the publication guardrail could miss receipt-shaped runtime state serialized as non-JSON text or inside a singly encoded JSON string.
- Earlier privacy review found that repository clean filters could execute during evidence capture and that filtered working-tree bytes could not be treated as equivalent to provable stage-0 index content.

### Defects fixed

- Cleanup failures are surfaced for foreground, adopted, and replayed continuations; unreadable session inventories preserve claimed receipts as ambiguous rather than pruning them as orphans.
- The publication scanner rejects accidental key-value, YAML, JSONL, wrapped JSON, single-object JSON, and singly encoded string receipt shapes while preserving deliberately synthetic documentation and evaluator fixtures. Multi-layer encoding, compression, base64, and splitting remain documented non-goals; the product boundary remains private-state-only receipt persistence.
- PR #17 prevents repository clean filters from executing during capture and uses filter-free Git objects for private turn snapshots. PR #19 reviews only provable staged filtered bytes and explicitly omits unproven filtered working-tree representations.
- PR #21 rejects non-owner release dispatches before reusable validation, protected-environment approval, or release concurrency can be occupied.

### Shipped in this candidate

- PR #22 shipped the reproduced Phase 2 cleanup, pruning, and publication-boundary fixes through protected CI. PR #23 shipped deleted-file old-side citation, patch-budget truncation/abstention, and control-character grounding-bait cases with mutation controls that fail on policy violations.
- PR #24 shipped exact-version development tooling and strict checked JavaScript for `review-schema`, `result`, approved provider requests, reviewer identity, and aggregation. Emitted runtime JavaScript remained byte-identical after comments were removed, and the focused behavioral suite remained 112/112.
- This candidate carries Byte, Mochi, Orbit, Bella, and Lupo under their checked-in Apache-2.0 provenance grants. It becomes a published prerelease only if the exact protected `main` head passes `.github/workflows/release.yml` with `version: 0.5.0-rc.3` and `publish: true`; stable host acceptance is not claimed.

## 0.5.0-rc.2 - 2026-08-01

Released from source commit `6975a04a697bfe65602f34e790501058481b992a` as the annotated artifact-only tag `v0.5.0-rc.2`.

### Fixed

- Reviewer schemas, runtime validation, outbox input, and source-result retention now preserve complete verbose responses instead of rejecting or truncating them at five findings; the compact aggregate remains deliberately bounded to five displayed findings.
- Malformed or transport-invalid provider responses are written once to private mode-`0600` evidence with a safe parse error, then removed from propagating error objects so raw bytes cannot leak through diagnostics.
- OpenCode accepts high-reasoning JSONL events without treating reasoning as completed review text, and Grok accepts its observed `end_turn` envelope without weakening the closed transport contract.
- Provider deadline re-arm uses bounded completion grace, and an authenticated completed process result wins over a stale deadline flag while cancellation, containment, temporary-state cleanup, and the POSIX Grok FIFO bridge retain their post-rc.1 behavior.
- The consumer-proof harness resolves and validates an absolute installation root and exits nonzero unless all three no-loss transport probes are strictly `true`.
- Structured results that omit the schema-required `findings` property now fail strict local validation instead of being normalized into apparent clean or abstaining outcomes.
- Rejected provider responses are kept outside the reviewed repository, appear in workspace status and purge coverage, retain concurrent responses without collision, and expire under the same 24-hour content ceiling as automatic receipts and outbox events.

### Release status

- This remains an RC. The published public artifact contains the five public pets Byte, Mochi, Orbit, Bella, and Lupo under their checked-in Apache-2.0 provenance grants. Artifact-bound host evidence remains a stable `v0.5.0` gate and was not required for this RC.

## 0.5.0-rc.1

### Added

- A durable, short-lived, single-use egress capability that binds each automatic provider call to the exact workspace, turn, review identity, mode revision, provider/model configuration, prompt, response schema, optional summary packet, and deadlines.
- Drain-backed mode and summary-consent revocation without holding configuration locks through inference.
- A native Windows Job Object supervisor source implementation, fail-closed helper verification, and Windows-only CI runtime gates. No unchecked binary is shipped by the source manifest.
- A positive public artifact builder/verifier that includes only allowlisted runtime files and the five public-scope pet assets.
- Fail-closed public artifact provenance that rejects staged, modified, untracked, or ignored public inputs and requires an explicit source commit to equal the repository `HEAD`.
- Strict host-evidence schema v2 bound to the exact source commit, generated artifact tree, installed snapshot, private receipt, completion record, outbox event, and explicit human host/visual observations.
- High-confidence secret scanning for recognized credential formats and contextual high-entropy assignments in otherwise allowed text files.
- Read-time no-follow/inode checks for private JSON and POSIX parent-directory syncing after private JSON publication.
- A reusable cross-platform validation workflow and manual protected-source release workflow that produce deterministic, reverified archives plus an isolated parentless artifact-only tag candidate. Final publication requires complete artifact-bound host evidence, a provenance attestation, exact object and asset reconciliation, and an explicitly approved least-privilege publication job.
- A pinned Gitleaks 8.30.1 directory scan of the exact built public artifact before host-evidence validation, archiving, or upload, with scanner comments, summaries, and SARIF uploads disabled.
- Ordered primary and optional secondary reviewer connections, concurrent execution, atomic multi-capability issuance, deterministic local aggregation with source receipts, attributed terminal receipts/events, and one-success partial completion without retry or provider fallback.
- Direct Claude Code and isolated OpenCode adapters alongside Grok and Ollama. Supported subscription routes include Claude Max directly, ChatGPT Pro through OpenCode OpenAI OAuth, Ollama local/Cloud directly, Grok directly, and configured Kimi models through OpenCode.
- Continuous pre-review from exact private Git checkpoints, with explicit intermediate-egress consent, at most two stable speculative generations per turn, cancellation of superseded provider work, and an exact final adoption or fallback gate.
- A shared exact review identity that binds full baseline and final snapshot digests, privacy-filtered evidence, ordered reviewer configuration, and optional summary consent without using screenshots or UI state.
- Deterministic compact visible output capped at one paragraph, three sentences, and 700 characters, while full validated attribution and findings remain in the private local receipt.

### Changed

- Minimum supported Node.js version is now 22.
- Pet discovery and presentation validation are catalog-driven instead of hard-coded to five package IDs.
- Bella and Lupo are now publicly redistributable alongside Byte, Mochi, and Orbit under the repository license, with explicit owner authorization recorded in their provenance files.
- Manual review storage is opt-in, automatic content retention is bounded, new v2 renderer events persist `worker_summary: null`, retained legacy v1 summaries remain default-denied, and workspace data has an explicit status and purge workflow.
- CI now targets Ubuntu and macOS on Node 22, Windows on Node 22, and Ubuntu on Node 24 with immutable action pins.
- Provider execution records privacy-safe capability audit metadata on both successful and failed terminal receipts.
- Worker-summary advisory consent is primary-only. A configured secondary always receives technical evidence only, and changing the secondary cannot widen summary egress.
- OpenCode projects only the selected model provider's auth entry into a disposable deny-all environment and does not forward ambient provider credentials or the remaining auth inventory.
- When an exact final review is pending, the renderer event says `Code review and suggestions are in progress.` The native pet remains limited to host-owned animation and task state.
- Enabling the optional worker-summary guard uses final-only review for that turn because the screened summary does not exist during speculative background work.

### Security

- Capability settlement never infers success from a dead process or elapsed deadline; ambiguous crashes remain unresolved and can conservatively block later revocation commands.
- Provider-capable Windows execution has no direct-process fallback when containment is requested.
- Secret scanning fails closed when a candidate is too large or cannot be validated as exact UTF-8 text.
- Direct Codex CLI and direct Kimi CLI adapters remain disabled until strict no-tools and no-inherited-context subscription execution can be proven.
- Provider credentials remain owned by existing CLI or OpenCode connections. Buddy does not persist or log credential values, and stale Buddy-owned provider temporary directories are removed through a bounded ownership-checked scavenger.
- Detached worker payloads exclude prompts, transcripts, tool data, screen state, credentials, and provider chat history. Reviewer invocations remain fresh, isolated, and memoryless across turns.

### Release status

- This is an RC. Exact-head cross-platform CI, the reviewed hash-pinned Windows x64 Job Object helper in the positive artifact, frozen-diff RepoPrompt and independent Grok/Opus reviews, and the documented security gates remain separate evidence requirements.
- Human artifact-bound observations for Byte, Mochi, Orbit, Bella, and Lupo are intentionally deferred and are not a public RC launch gate. No real host acceptance is claimed by this entry.
