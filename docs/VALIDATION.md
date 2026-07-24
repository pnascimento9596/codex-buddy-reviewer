# Validation Record

Date: 2026-07-20

This document records the current evidence state for `v0.5.0-rc.1`. It distinguishes implemented contracts from tests that have actually run, independent-review outcomes and limitations, real Windows evidence, installation state, and the manual Codex host gate. It does not treat source inspection, a skipped platform test, or an older release result as current proof.

## Release stance

The source version is `0.5.0-rc.1`. The generated positive public artifact normalizes the plugin manifest to that canonical package version; the private development manifest uses a separate `+codex.<cachebuster>` suffix so Codex installs a new immutable snapshot after source changes.

This RC is not eligible for a final `v0.5.0` tag until:

1. the exact final source head passes the complete local validation and independent review matrix;
2. GitHub Actions passes Ubuntu, macOS, Windows x64, Node 22, and Node 24 at that same head;
3. a reviewed, hash-pinned x64 Job Object helper is packaged in the positive final artifact and those exact bytes pass the Windows runtime tree tests;
4. Windows live provider egress remains disabled until current-user-only DACL creation and verification for durable Buddy state and provider temporary roots passes real Windows tests;
5. the generated public artifact is rebuilt, reverified after deterministic archive/re-extraction, and installed from its positive boundary rather than from the private checkout;
6. a fresh whole-repository Codex Deep Security Scan is completed and sealed against the frozen exact source snapshot, with every reportable release blocker resolved or explicitly accepted;
7. a strict artifact-bound host-evidence v2 bundle contains one complete report for every public pet and records every required desktop observation as `manual_pass`.

The release workflow enforces the distinction and is never triggered from a version tag. An artifact-only parentless tag deliberately contains no source workflow or development scripts, so release construction always begins with a manual dispatch from the exact protected default-branch head. Every dispatch first calls the complete reusable cross-platform validation workflow, rebuilds and reverifies the positive artifact, creates and verifies an isolated parentless distribution repository, and uploads the deterministic tarball, checksums, Git bundle, and distribution receipt. The default `publish: false` path makes no repository mutation and accepts either an exact RC version or exact final candidate.

An RC dispatch with `publish: true` creates an attested prerelease and does not require or claim host evidence. A final-version publication additionally requires `HOST_EVIDENCE_V2_BUNDLE_GZIP_B64` from the protected `public-release` environment. The workflow accepts only canonical single-line base64 containing one bounded gzip member and caps the decompressed JSON at 128 KiB. A dedicated least-privilege job uses the commit-pinned GitHub `actions/attest` action to issue provenance for the tarball, distribution bundle, and path-free binding receipt. The publication job verifies those attestations against this workflow and the exact source digest, then rechecks both checksums, receipt bindings, tag and commit object IDs, and the unchanged protected default-branch head before pushing only the artifact-only annotated tag and creating a prerelease or final GitHub Release. Retry reconciliation accepts an existing tag or release only when its exact object, metadata, prerelease state, asset set, and asset bytes match the candidate. Artifact attestation requires the repository and GitHub plan support documented by GitHub, so publication runs only after the sanitized source repository is public.

## Implemented v0.5 contracts

### Ordered reviewers and exact provider egress capabilities

Automatic mode accepts one ordered primary reviewer and one optional ordered secondary reviewer. Eligible lanes run concurrently under the existing workspace provider lease. Each configured lane gets one attempt, with no retry, substitution, or fallback. Results are validated independently and combined locally without a synthesis model. One success is sufficient for a partial completed review, while zero successes preserve the worker result and produce a degraded terminal state. Receipts and completed pet events retain ordered provider/model attribution plus safe success, failure, and open-circuit status.

Automatic provider authorization no longer holds mode and summary-consent locks through inference. Under short locks, Buddy writes the at-most-once attempt fence and atomically issues one single-use capability for each executable reviewer. Batch issuance publishes all requested capability records or none. Every capability is bound to:

- canonical workspace, session, turn, and review identities;
- mode revision, provider, model, effort, timeout, and complete reviewer-configuration digest;
- exact prompt digest and UTF-8 byte count;
- response-schema digest;
- optional summary-consent revision, summary digest, and full summary-packet digest;
- bounded issue, spend, consume, and execution deadlines.

Spend durably transitions `issued -> consumed` before executor entry. Settlement removes the active record only after the executor completes or fails and the exact consumed record is still intact. Mode and summary-consent mutation commit a new revision, snapshot prior-revision capabilities under their short lock, release the lock, and return only after those exact capabilities positively settle. Dead PIDs and elapsed deadlines do not manufacture a successful drain.

The separately consented worker-summary packet can bind only to the ordered primary capability. A secondary capability is always technical-only. This is deliberately availability-conservative: a crash after issuance/consumption but before positive settlement can leave an unresolved record that makes a later revocation command time out. A future recovery path must obtain positive supervisor-backed quiescence evidence before removing such a record.

### Provider adapters and subscription routes

The implemented adapter registry is closed to `claude`, `grok`, `ollama`, and `opencode`.

Live use of those adapters is enabled only on supported POSIX hosts in v0.5 RC. On Windows, a closed platform policy blocks manual live review before evidence collection, blocks automatic hooks before turn-directory creation, blocks doctor provider checks before approval, blocks live evaluation before output or prompt creation, and blocks the canonical dispatcher before adapter invocation. The failure code is `windows_private_state_acl_unavailable`. Tests can exercise host-independent logic only through explicit in-process platform injection; there is no CLI or environment override.

- Claude Max uses the direct authenticated Claude Code CLI with no tools, no MCP configuration, no session persistence, safe mode, a disposable working directory, and an explicit response schema.
- Grok uses the direct authenticated Grok CLI through the existing isolated bridge.
- Ollama supports local models and Ollama Cloud through the direct Ollama CLI. Cloud responses use JSON transport plus strict local validation instead of a schema argument.
- ChatGPT Pro uses OpenCode's OpenAI OAuth connection. Kimi is supported only through a model exposed by a configured OpenCode provider connection. OpenCode receives only the selected provider auth entry in a disposable deny-all environment; ambient provider secrets and the remaining auth inventory are not forwarded.

Effort compatibility is validated before provider dispatch and before automatic capability spend. Ollama accepts only `low`, `medium`, and `high`. Claude, Grok, and OpenCode additionally accept `xhigh` and `max`. Focused tests cover direct-adapter rejection, mode/setup persistence rejection, CLI dispatch accounting, and a tampered automatic-mode record that must produce no attempt receipt, capability, provider call, or circuit charge.

A validated provider result remains usable when disposable-state cleanup fails. Only the closed `cleanup_status: "failed"` run field is admitted internally, and public/manual projections use the bounded `temporary_state_cleanup_failed` warning. Tests require raw cleanup paths and errors to remain absent and require an inference or preflight failure to stay authoritative when cleanup also fails.

Direct Codex CLI and direct Kimi CLI adapters are intentionally absent until their subscription paths can prove strict no-tools and no-inherited-context execution. These are implemented adapter boundaries, not proof that every provider account is currently authenticated or that every model is available on a given subscription.

### Process containment

On POSIX, provider-capable calls use a detached IPC-liveness supervisor and one supervised process group. Catchable cancellation and deadlines use group TERM-to-KILL cleanup; non-catchable parent death is observed through kernel IPC closure. Normal provider-leader exit must not be reported as successful until remaining in-group descendants are terminated. A provider that deliberately creates a new session/process group can escape this lifecycle boundary, so the design does not claim an OS sandbox for a malicious provider binary.

On Windows, provider-capable calls have no direct-spawn fallback. The native helper contract creates a future provider suspended, assigns it to a non-breakaway Job Object configured with `KILL_ON_JOB_CLOSE`, and resumes only after successful assignment. Helper path, protocol, SHA-256, and PE architecture are verified before use. Raw protocol bytes must be printable ASCII, and a terminal control record must match the helper's actual exit code and signal. The token is protocol correlation rather than a hostile same-user identity boundary, and pre-spawn path hashing does not eliminate a same-account verification-to-spawn replacement race. The checked-in manifest deliberately marks x64 and ARM64 unavailable; source presence is not runtime proof. CI builds an ephemeral x64 helper and must execute the Windows-only process-tree tests. ARM64 remains unavailable until separately built and exercised. Exact final-semver artifact verification additionally requires a packaged verified x64 helper. These helper tests remain valuable process-containment evidence, but the privacy gate prevents live provider execution even when helper metadata verifies.

### Privacy and private state

The existing path policy, exact denied-content matching, bounded normalized fragments, ordinary-ignored aggregate fingerprint, and shared manual/automatic evidence kernel remain in force. v0.5 adds a bounded high-confidence scanner for recognized private-key/token formats and sufficiently diverse credential-shaped assignments in otherwise allowed text. Oversized or invalid UTF-8 candidates fail closed. Closed placeholder fixtures are exempted only when the complete value matches a conservative placeholder form. Separately consented worker summaries are assessed after sanitization/truncation with this scanner, exact excluded-path references, and the high-risk path policy; unsafe or incomplete packets are suppressed and the capability becomes technical-only.

Private JSON reads reject symlinks, use `O_NOFOLLOW` where available, and compare the opened file identity to the pre-open metadata. Atomic/exclusive JSON writes sync the file and, on POSIX, the parent directory after publication. Manual receipt storage is opt-in. Automatic content-bearing recovery state and renderer events have a non-extendable 24-hour age threshold, worker summaries are not persisted in new renderer events, and workspace data has an explicit status and purge workflow. Age-based physical deletion is opportunistic on the next Buddy prune because no background daemon is installed. Same-user ancestor swaps and cross-platform power-loss semantics remain narrower limits; no universal filesystem durability guarantee is claimed.

### Positive distribution boundary

The public builder starts from an empty destination outside the source repository and materializes only explicit runtime-allowlist and public-pet blobs from committed `HEAD`. Building from Git blobs prevents clean or smudge filters, line-ending conversion, and concurrent working-tree byte changes from changing the artifact. It rejects an existing or nested destination, selected-path worktree changes, non-regular committed entries, non-cleared pet promotion, malformed configuration, unexpected paths, changed bytes, and noncanonical identity metadata. The generated artifact contains Byte, Mochi, Orbit, Bella, and Lupo.

The exact generated path set and each file's size, mode, and SHA-256 are recorded in `release-manifest.json`. The verifier must run from a trusted full source checkout. It independently derives the allowed paths and every expected source or transformed byte from that checkout's matching commit, then confirms the artifact-authored manifest, canonical package/plugin version, catalog, provenance, public pet hashes, and absence of development/private markers. A self-consistent artifact manifest cannot authorize an extra path or changed allowlisted byte. The builder claims a source commit only when it equals the repository's current `HEAD` and every selected public path is clean before and after construction. Local structural validation uses a clearly isolated temporary committed snapshot instead of assigning the dirty working tree's bytes to the real checkout `HEAD`.

The local distribution-commit builder is the next positive boundary after artifact verification. It creates a separate repository with an artifact-only parentless commit, a single distribution branch, and one deterministic annotated `v<version>` tag. The source commit epoch supplies the UTC author, committer, and tagger timestamp; all three identities use the fixed public release bot; and ambient Git identity and configuration are excluded. Verification requires the tag to peel to the only commit, compares every tracked blob and worktree file byte-for-byte with the positive artifact, rejects personal filesystem paths and bounded credential-shaped content, permits no remote, inventories all refs and Git objects, and fails on inherited or unreachable objects. The local tool does not modify refs in the source checkout and has no publish or network operation. The workflow exports only the verified tag closure as a Git bundle for the separately authorized publication job.

The reusable validation workflow scans complete repository history with the commit-pinned Gitleaks action, pins the scanner itself to 8.30.1, and runs publication `--tree-only` mode against the exact clean source index on Ubuntu with Node 22. The release job additionally checks out complete history and runs the bounded full publication gate before it can construct an artifact. That gate scans raw path signatures in every reachable blob, candidate text content, tracked and historical pathnames, raw commit identities and messages, raw annotated-tag identities and messages, supplemental signed or merge-tag headers, and every ref name. It accepts GitHub noreply identities and reserved `.invalid` fixtures by default; any other reviewed public contributor address must be explicitly allowlisted. The full-history clean-worktree requirement is intentionally not part of ordinary local dirty-tree validation. After the release job constructs the exact public artifact, it uses the same pinned Gitleaks setup without comments, summaries, or SARIF uploads and separately runs `gitleaks dir` against that artifact before host-evidence validation, archiving, or upload.

Repository code and the positive public artifact use Apache-2.0. Bella and Lupo received explicit owner authorization for public redistribution on 2026-07-19. Their provenance and exact package hashes are verified with the other public pets.

### Host evidence

Host-evidence schema v2 is bound to the source commit, release manifest, complete artifact identity, byte-identical installed snapshot, selected public pet, private receipt, completion record, and exactly one matching public outbox event. Collection is local-only, uses exclusive mode-`0600` creation, and refuses overwrite. Final promotion consumes a strict schema-v1 bundle: it independently validates every report, requires every report to be complete, binds release and pet hashes to the rebuilt artifact, rejects missing/duplicate/unknown pet IDs, and requires the report ID set to equal the release manifest's public-pet set exactly.

Automation does not claim to prove command-menu discovery, visible no-argument toggling, hook trust, visibly combined worker/review presentation, absence of a continuation loop, or native pet appearance/animation. Those gates accept only `pending`, `manual_pass`, or `manual_fail` with a named observer, timestamp, and notes where required. An ordinary automated `pass` is rejected.

## Current validation status

The integrated continuous-review working tree passed the complete local `npm test` run on 2026-07-20: 687 tests, 669 passes, 18 intentional platform skips, and 0 failures in 248.8 seconds. Earlier complete runs exposed a real executable-entrypoint defect and an outdated test harness that enabled continuous review without the new purpose-specific consent. The worker input boundary was separated, the harness now records explicit consent, their targeted regressions passed, and the complete suite passed after both corrections. Focused tests also cover exact-key adoption, stale cancellation, atomic foreground takeover, bounded worker lifetime, no-change cost suppression, two-generation limits, per-connection circuits, dual-review partial results, all-open circuits, durable receipt validation, private retention, and compact visible output.

Portable validation passed with 81 syntax-checked modules, all five public pets, all five deterministic evaluation cases, a 123-file isolated positive release boundary, and every public CLI help path. Both Buddy skills and the Codex plugin validator passed. `git diff --check`, the repository-wide no-em-dash scan, and the public literal-personal-path scan passed. Gitleaks scanned all 12 reachable commits and approximately 2.10 MB of history, then approximately 14.67 MB of the current directory including untracked candidate files, with no findings.

These are exact local working-tree development signals, not an exact committed-head, real Windows, Codex host, or GitHub Actions release record. At this record's freeze point, final RepoPrompt context review, fresh Grok 4.5 high review, fresh Claude Opus 4.8 high review, protected GitHub Actions, and protected RC publication remain pending. A fresh whole-repository Codex Deep Security Scan and manual five-pet host observations are intentionally deferred and are not public RC launch gates. No Ollama or GLM model review is used for the final independent-review phase; Ollama remains a supported product adapter.

### Security-workbench status

A sealed whole-repository Deep Security Scan of the pre-fix RC head completed with 20 findings: 17 medium and 3 low. Provider-free reproductions covered credential syntax gaps, denied-content fragment and live Git metadata coverage, and lossy invalid UTF-8 pathname handling. The current working tree implements structural fixes and focused regressions for those families, but no fresh exact-final-tree scan has revalidated closure.

Separate read-only adversarial integration audits reproduced concrete defects in the evolving v0.5 diff, including prepared-summary identity mismatch, POSIX inherited-stdio descendant survival, pre-spend outbox delay, placeholder false negatives, cumulative summary-revocation bypass, capability-issuance deadline loss under lock contention, settlement/provider-circuit misclassification, technical-schema digest mismatch, named POSIX Grok prompt remnants, unsafe summary advisory egress, Windows high-bit control aliases and terminal/helper-exit mismatch, and a final-release path without a packaged verified x64 helper. The implementation contains targeted fixes and focused regressions for these development findings. An earlier Opus 4.8 high review found stale egress registry recovery debt. The final handling preserves an explicit expired-v1 migration rule while retaining every valid schema-v2 issued or consumed record until exact positive settlement; focused tests cover expiry, snapshot visibility, drain timeout, and post-executor settlement. A later broad Opus 4.8 high pass correctly abstained because review evidence was incomplete for 31 changed paths; it is not counted as an all-clear. Grounded Grok 4.5 high reviews found stale egress records, UNC executable acceptance, named-pipe token disclosure, contradictory release-tag instructions, a stale live-eval provider dispatch API, inaccurate renderer-retention wording, a broken skill root instruction, pre-spend prompt-budget result loss, and late provider-effort validation. Every validated issue received a focused fix and regression where behavior changed. The final complete-file Grok correction review transmitted all 14 selected paths without exclusions or truncation and returned `no_findings` for patch hash `0d625864c59bc2d04b4184e2f9e373c30e208df3618ff63bb3c3b6bdba77da1c`. A separate credential-boundary audit found realistic terminal credential syntaxes that the high-confidence scanner did not yet recognize, plus an adversarial regular-expression performance risk. The scanner now covers the validated assignment, header, CLI, environment, URL, interpolation, and escaped-delimiter families, and a maximum-size hostile-input regression completes within the two-second test budget. These are strong local development signals, but exact committed-head, Codex Security, GitHub Actions, real Windows, and Codex host gates remain distinct.

## Pet assets

The atlas binaries were not regenerated during v0.5 hardening. Their catalog-pinned identities remain:

| Package | Scope | SHA-256 |
|---|---|---|
| `buddy-byte` | public/cleared | `0a6310229b6dbe12294314abf2bceef88e34aee8c5ca5f12eb9ac09a762f38b5` |
| `buddy-mochi` | public/cleared | `3f1dc884f8ab4a691cfc84692b998a991da8de734ccbccfa27c137bf8f30be3a` |
| `buddy-orbit` | public/cleared | `26efcaa8fc2b96999db2bbc2b82d934df6660de8c45997a16b11f3b1c7c389f7` |
| `buddy-bella` | public/cleared | `3454b0b4b05a1c36fcc74840a835498e7b6f4fd092af7b532bb94e7d3ce6ef0f` |
| `buddy-lupo` | public/cleared | `5d20b8fffc10c7282f05909ac5bbbe3c5f3b36f473edbebaeea325580bbb8a4e` |

The earlier full-decoder and visual evidence remains historical evidence for identical bytes, not a substitute for rerunning the available structural/full-decoder gates or for observing the packaged RC in Codex.

## Historical v0.4 evidence

The prior `v0.4.0` RC completed a 240-test local suite, plugin/skill validators, a sealed security scan with two subsequently fixed findings, a Grok 4.5 review, and a Claude Opus 4.8 high review. Those results explain why v0.5 added the capability boundary, provider supervision, receipt privacy, and further hardening, but they do not validate the current working tree. The former v0.4 package/cachebuster, installation path, exact test count, and external-review conclusions are intentionally not presented as current v0.5 proof.

## Final evidence to append at exact head

Before stable promotion, replace this pre-final status with:

- exact branch head and complete dirty/committed diff identity;
- complete test totals and every validator command/result;
- public artifact file count, manifest digest, source commit, and re-extraction result;
- artifact-only distribution tree, commit, annotated tag object, content digest, and exact-ref verification result;
- cache-busted private development manifest and sanitized personal installation path;
- RepoPrompt snapshot/context and architecture-review conclusions;
- exact Grok and Opus CLI versions, model/effort/sandbox arguments, findings, resolutions, and rerun status;
- fresh Deep Security Scan snapshot digest, sealed report paths, findings disposition, and completion identity;
- GitHub Actions run URL and per-matrix conclusions, including real Windows x64 helper/runtime tests;
- host-evidence v2 path and digest only after genuine manual observations exist.

Until those fields are evidence-backed, this remains an RC implementation record rather than a final release attestation.

## Post-publication addendum (2026-07-23)

This additive section records evidence obtained after the historical sections above were frozen. It does not replace or retroactively broaden the earlier claims.

### Published RC identity

The [GitHub prerelease for `v0.5.0-rc.1`](https://github.com/pnascimento9596/codex-buddy-reviewer/releases/tag/v0.5.0-rc.1) was published at `2026-07-21T04:05:29Z` from source commit `01fad043c22b045a702485046c243ba1e3f833c6`. Live GitHub Actions inspection on 2026-07-23 confirmed these successful runs:

- [PR validation `29798480284`](https://github.com/pnascimento9596/codex-buddy-reviewer/actions/runs/29798480284): `success` for pull-request head `44aa6b3663127ae2765f78b5d47e5e1fa29c01dc`.
- [Protected-main validation `29799020760`](https://github.com/pnascimento9596/codex-buddy-reviewer/actions/runs/29799020760): `success` at released source `01fad043c22b045a702485046c243ba1e3f833c6`.
- [Release publication `29799553023`](https://github.com/pnascimento9596/codex-buddy-reviewer/actions/runs/29799553023): `success` at the same released source. Its exact publish step completed at `2026-07-21T04:05:29Z`.

The artifact-only tag object is `fff82d167f9cbcf4440a942a5f366ae599ea09c5`; it resolves to distribution commit `f819879d158a37d0f8a476da65e5502f1cd5ef9d` and tree `84b5e4c93f1733ce02157fa1155a2411a6c3ccdd`. The tag message and downloaded `codex-buddy-reviewer-0.5.0-rc.1-distribution.json` bind that distribution to release-manifest SHA-256 `2b61320d766c750ce6642b652003bb7296f99c437e33f3145065293c270fffe9` and artifact-content SHA-256 `decc03263b01d7eeb088797a56a75c97f76a52fda57e4ee4d35447f863114682`.

### Release assets and provenance

The five GitHub Release assets were downloaded again on 2026-07-23. Locally recomputed SHA-256 values matched the live GitHub asset digests, and the two checksum files named the same tarball and distribution-bundle hashes:

| Release asset | SHA-256 | Provenance subject |
|---|---|---|
| `codex-buddy-reviewer-0.5.0-rc.1.tar.gz` | `60ad2571202dbcf5def899a1c9de5b4af75d7cb2fbdb7efd326de1023e2ffa88` | yes |
| `codex-buddy-reviewer-0.5.0-rc.1.tar.gz.sha256` | `b46a6b740849d4c96005392a67c9857bbc01da07cd5f869fb143bb30efd8ce31` | no; checksum metadata asset |
| `codex-buddy-reviewer-0.5.0-rc.1-distribution.bundle` | `88c9a8fbee898e42f256726a8110cdb0e9b88f1382fff6c5e046eaa8222b9aee` | yes |
| `codex-buddy-reviewer-0.5.0-rc.1-distribution.bundle.sha256` | `3e2e609e7986d80337958ed4b41699db94b6ec1acdcf018c1afc6cc8af8d78e9` | no; checksum metadata asset |
| `codex-buddy-reviewer-0.5.0-rc.1-distribution.json` | `35276704f34fc6005043028b75d31759a5477f7267e86113c9a1a0750b119228` | yes |

`gh attestation verify --repo pnascimento9596/codex-buddy-reviewer` succeeded independently for each of the three provenance subjects. The verified predicate type is `https://slsa.dev/provenance/v1`. The certificate identity is:

- subject alternative name: `https://github.com/pnascimento9596/codex-buddy-reviewer/.github/workflows/release.yml@refs/heads/main`;
- issuer: `https://token.actions.githubusercontent.com`;
- workflow: `release artifact` in `pnascimento9596/codex-buddy-reviewer` at `refs/heads/main`;
- workflow and source digest: `01fad043c22b045a702485046c243ba1e3f833c6`;
- trigger: `workflow_dispatch`;
- invocation: `https://github.com/pnascimento9596/codex-buddy-reviewer/actions/runs/29799553023/attempts/1`.

The checksum metadata assets are release assets with verified hashes, but they are not subjects in the SLSA statement. The statement covers exactly the tarball, distribution bundle, and distribution JSON listed above.

### Released-head totals and remaining gates

The 2026-07-23 local recon at the released head recorded `706` total tests, `688` passes, and `18` intentional skips. Live retrieval of the protected-main macOS job in run `29799020760` independently reported `706` tests, `688` passes, `0` failures, and `18` skips. The later README-only wording merge does not change source or test files.

The following remain explicitly unrun, unimplemented, disabled, or unpublished and are not claimed by this addendum:

- a fresh exact-head Codex Security scan;
- the five named artifact-bound pet host observations;
- Windows current-user-only DACL work and verification;
- live Windows provider egress;
- stable `v0.5.0` publication.

The README badge labeled `Release gates pending` refers to those stable-promotion gates. It does not mean that the published `v0.5.0-rc.1` release or its protected publication run failed.
