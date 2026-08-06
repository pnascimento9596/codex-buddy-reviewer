# Validation Record

This document separates validation evidence into five explicitly labeled layers. Current evidence must not overwrite frozen publication evidence, and unresolved gates remain unresolved until a fresh run proves otherwise.

## Layer A - current evidence at exact protected main

Current protected `main` after rc.4 freeze is advanced by host-e2e evidence PRs; immutable rc.4 source remains `b56224fb8e37ca02e071cda41702af4ef20f1ebb`. The immutable published rc.3 source remains `0c6f09ae14d834fccb2a2289f6731511dbbdb034`. Post-rc.3 protected merges closed both #36 defects (PRs #44 and #46), the #38 pet atlas packaging defect (PR #45), first-enable baseline messaging (PR #50), and recorded post-fix host evidence (PR #48). Frozen Layers B–D are unchanged historical publication evidence.

### rc.4 candidate local validation (pre-merge head)

Authoritative serial local `npm run check` on the #37 head recorded `793` tests, `775` passes, `18` intentional skips, and `0` failures. Publication-boundary, portable, skill, plugin, secret, and help-surface validations passed. Provider tests were mocked and no live provider was contacted during this gate. Exact protected-main CI for the rc.4 candidate merge head is recorded in the table below after merge.

The two prior frozen historical slices were byte-compared before this edit: Layer B (rc.1) is `3908` bytes with SHA-256 `145f7e78e68326cd678e39bcbadb402b890584ab1ba54c61073690b6cd946abc`; Layer C (rc.2) is `2914` bytes with SHA-256 `c734e100570f8dcb3fcaad941e5a86f330aa37267c79c4b2b6187e4d360ad33a`. Both comparisons were byte-identical. Layer D freezes rc.3 and remains historical.

### Protected-main GitHub validation evidence

| PR / source | Protected-main run | Head SHA | Result |
|---|---:|---|---|
| PR #13, released rc.2 source | `30694148219` | `6975a04a697bfe65602f34e790501058481b992a` | success |
| PR #15, validation-layer reconciliation | `30707435091` | `3281a44bfb72b9ac76e6e1bee3f59f04a897bcb2` | success |
| PR #17, filter-free capture hardening | `30728024227` | `c51e6fb12fae1b5c2fb8a82cf5daa0ff20b2bfeb` | success |
| PR #19, filtered worktree scope hardening | `30732240371` | `bedb4565a369aa3878c8afbde28216b2aed4e47e` | success |
| PR #20, rc.2 publication reconciliation | `30752311643` | `0219d7aa4b136e034876becb9a7dbeabf2422aa6` | success |
| PR #21, release-governance hardening | `30755603147` | `32f1121c0c916e7820d66095d2f1956793604e40` | success |
| PR #22, Phase 2 reproduced fixes | `30771259006` | `bea53a8473b69c967eac70dd64ca01d417974fdc` | success |
| PR #23, Phase 3 adversarial corpus | `30773941325` | `c703b776bd5af95449978c4d2b025acaecd0c24c` | success |
| PR #24, Phase 4 checked JavaScript | `30776339242` | `58d8abaf49a2be09322d7a44ceda306f7354ef72` | success |
| PR #26, rc.3 candidate | `30815410789` | `4eae98b1c5924e710417ec20af1eae02ccb322b8` | success |
| PR #28, randomized privacy assertion | `30820920884` | `e0de954d2e0a8dc35e1c8b8a7914e74fdd9a0b51` | success |
| PR #30, explicit Git object format | `30827388304` | `916e644676b46ab4bebdc116c45797640fb2c54f` | success |
| PR #31, cross-version Git compatibility | `30841814619` | `b28ef5bfad03d1563ddda4676ed6d536c266f6ea` | success after flake protocol |
| PR #32, reachable-history dispositions | `30853151362` | `c9bc4441cd4fc43533b834402e10507982d242af` | success |
| PR #33, deadline-containment observation | `30860361741` | `0c6f09ae14d834fccb2a2289f6731511dbbdb034` | success |
| PR #34, frozen rc.3 evidence | `30870061618` attempt 2 | `27b5e9ad73e3d4ff1e7c37d20ec82ae98d00c9d0` | success after one failed-job rerun under #25 protocol |
| PR #44, #36 snapshot-retry | (see post-merge validate) | `3ac754b211917dda15ca5e5fadb5e4bbb908dc43` | success |
| PR #45, #38 host-compatible pets | (see post-merge validate) | `23784a3a495ab09e60ac9283080b26410e5d744a` | success |
| PR #46, #36 worker keepalive | `30971047977` after flake job rerun | `866e359c53614ba4fa1c9a4bd0d4e1c32fb4ecdb` | success after flake protocol |
| PR #48, post-fix host evidence | `30992257722` | `9896aa3ebee7f99b239266ae764d98ae37637764` | success |
| PR #50, #37 first-enable baseline UX | `31007708098` (flake family; later green on same family) | `065c4704e7c5e37ff979b2a2daea67acf0163a16` | success after authorized flake handling on sibling heads |
| PR #51, rc.4 candidate | `31011169822` attempt 2 | `b56224fb8e37ca02e071cda41702af4ef20f1ebb` | success |
| Frozen rc.4 evidence (this PR) | (post-merge) | (merge SHA) | pending |

### Post-rc.3 host and supersession evidence

- Speculative adoption observed on a real Codex 0.146 host after PRs #44/#46: ready key `5a646cf08ad7402bf40ba41ccce08faa7efb73b356953406b4dfce8265cfd489` exact-matched completed key; outbox had no `review_started` after `turn_finished`. Evidence: `docs/host-evidence/speculative-adoption-2026-08-05.txt`.
- Five-pet selectability observed on fixed packages (terminal-content method; ScreenCaptureKit/TCC blocked pixels). Artifact-bound host-e2e bundle against a published archive remains open for stable.
- **Supersession invariant:** a prior real-host turn with mismatched ready/completed identity correctly refused adoption (stale-key / non-matching speculative receipt rejected; no false Stop adoption). Exact-final or failed fallback remains the safe path when identities diverge.
- **Prior-lane provider overrun (honest):** host-verify budget was 4 live review turns; verification used 5+ after the second #36 root cause appeared mid-run (1 doctor + 2 exact-final + mismatched-key turn + gate-closing adoption). Cause recorded; not silently normalized to budget.

### Phase 3 and Phase 4 exact-head delivery evidence

Historical (unchanged): PR #23 → `c703b776…` / run `30773941325`; PR #24 → `58d8abaf…` / run `30776339242`. Issue #25 and related timing flakes were later closed through PR #42 deterministic-timing work; residual process-family flakes may still appear under load and follow the authorized flake ladder.

### rc.4 pre-dispatch attribution (historical; frozen in-artifact)

release dispatch to be executed by delegated agent session under owner instruction of 2026-08-05.

The dispatch is authorized only after this candidate merges through normal protection and its exact protected-main source SHA passes protected CI. The delegated session authenticates to GitHub as owner account `pnascimento9596` (account ID `198005926`) and will invoke `.github/workflows/release.yml` from unchanged protected `main` with `version: 0.5.0-rc.4` and `publish: true`. GitHub can establish account, workflow, source, and approval attribution; it cannot establish which person or delegated local session operated an authorized account token.

**Home for new dispatch attribution:** subsequent release dispatches record
attribution under `docs/releases/dispatch-attribution.md`, which is outside the
published public artifact path set. Do not add new pre-dispatch statements to
this in-artifact Layer A section; keep the rc.4 text above as frozen history.
See the rewritten security-scan gate in `docs/releases/v0.5.0-stable-readiness.md`.

### Phase 7 pre-stable engineering work item

- [x] Deterministic-timing hardening for the original #14/#25/#29 family shipped in PR #42; intermittent process-containment flakes may still appear and use the authorized flake ladder (local 5× → failed-job rerun → full workflow rerun).

### Phase 6 published-artifact POSIX evidence

Phase 6 used only a fresh anonymous download of `codex-buddy-reviewer-0.5.0-rc.3.tar.gz`. Its checksum sidecar passed, the independently calculated archive SHA-256 was `6de1ab3c4a47a96abbc5faf868d862d614a2e2a196fd4ec730f4b7c7b9d0b759`, and `release-manifest.json` bound the 130-file artifact to source `0c6f09ae14d834fccb2a2289f6731511dbbdb034`. No source-checkout executable drove the trial.

Offline doctor ran at `2026-08-04T01:55:42Z` with provider contact disabled. It validated plugin version `0.5.0-rc.3`, both hook definitions, POSIX process-group containment configuration, complete workspace resolution, zero active egress capabilities, and the ordered disabled reviewer configuration. Native host-hook trust, command discovery, pet selection, and visual state remained explicitly unknown/manual.

The one authorized bounded health-check window was `2026-08-04T01:56:14Z`–`01:56:17Z`. It made exactly one no-repository-content call per configured reviewer: OpenCode `openai/gpt-5.6` failed closed with `transport_exit`; Ollama Cloud `glm-5.2:cloud` passed. No provider or model was substituted.

One live review turn ran from `2026-08-04T02:03:43Z` through `02:03:49Z` after explicit continuous-mode enablement, baseline capture, and a one-line `index < items.length` to `index <= items.length` mutation. The synthetic shell host did not preserve the detached speculative worker after the `UserPromptSubmit` process exited, so Stop performed the exact final fallback rather than claiming receipt adoption. Both reviewer lanes received the same 4,077-byte bounded prompt. OpenCode `openai/gpt-5.6` failed closed at inference with `transport_exit` after 1,083 ms; Ollama Cloud `glm-5.2:cloud` completed in 3,297 ms. That is one partial review, not two review turns and not a fallback substitution.

The successful Ollama result returned `status: findings` with an explicit `findings` array. It cited changed path `bounds.mjs`, current line 2, detected the planted off-by-one, and classified it `blocker` with confidence `1`. Local execution independently reproduced the claim: for a two-item array, `withinBounds(2, items)` returned `true` even though index 2 is invalid. No live reviewer returned `no_findings` or `abstain`, so no such status omitted the required findings array; the OpenCode lane returned no review object because its transport failed.

The exact Stop receipt bound baseline tree `c621c897124fc1ea7cb92cd738da99597880fe71`, final tree `13b889f7ac24cc63eeca14748f28ee59e3df8907`, and patch SHA-256 `4bd6d9b24cf54f1eab7dc75abb3a2079393853a437ed515a4e9da1e933dc53cb`. Its visible single-paragraph review was 323 characters, below the 700-character ceiling, and honestly labeled the partial connection state. Before cleanup, status accounted for 9 review-content files / 18,538 bytes, 5 settings files / 1,130 bytes, no provider temporary files, and zero active capabilities. Mode was disabled before confirmation-gated purge. After purge, receipts and renderer outbox were absent, provider temporary bytes remained zero, active capabilities remained zero, and only the required 561-byte content-free completed-turn tombstone remained as review content.

This proves the published artifact's POSIX exact-final provider path, strict successful-result shape, changed-line validation, compact output, honest partial status, disable, and bounded purge accounting. Synthetic CLI driving does not prove native pet rendering, native host trust, transcript continuation display, or speculative-worker survival under a real Codex host.

### Phase 2 independent exact-head adversarial review

The initial packet pinned protected source commit `32f1121c0c916e7820d66095d2f1956793604e40`, tree `8ca8806e891714e2d71d00a3b18d15e99755a54f`, and packet SHA-256 `9a790aadbc28b8ea1eee335a4bd1fe712894f6a4a05f934b1c1acd33a2bc72de`. After reproducing and locally fixing the first cleanup finding, the re-review packet pinned commit `6ef982b94fd4faf60b6922c059ed5445a6d75b9a`, tree `652f7522531e0f8086f4731295c68e4b10674860`, and packet SHA-256 `3013b068a72d5f3c736d3de31c877c589ed6e6b81f382d9aed30da6c75efee5d`. Each packet contained the complete named source scope, eleven complete directly relevant tests, complete PR #12/#13/#17/#19 squash diffs, and, for re-review, the complete cleanup-fix diff.

| UTC window | Provider / invocation model | Effort | Purpose | Verdict |
|---|---|---|---|---|
| `2026-08-02T16:18:12Z`–`16:18:53Z` | OpenAI Codex / `gpt-5.6-sol` | requested high; trace reported `reasoning effort: none` | initial exact-head review | one medium finding: silent turn-snapshot cleanup failure |
| `2026-08-02T16:18:12Z`–`16:20:50Z` | Ollama Cloud / `glm-5.2:cloud` | not explicitly set | initial exact-head review | `no_findings`, with `findings: []` |
| `2026-08-02T16:32:24Z`–`16:35:12Z` | Ollama Cloud / `glm-5.2:cloud` | explicit high | fixed-head re-review | `no_findings`, with `findings: []` |
| `2026-08-02T16:32:24Z`–`16:36:13Z` | OpenAI Codex / `gpt-5.6-sol` | trace-confirmed high | fixed-head authoritative re-review | four findings: publication receipt-shape bypass, unreadable-session receipt deletion, silent adopted cleanup failure, and cleanup-warning loss on replay |

The Codex effort discrepancy is retained rather than normalized: the initial call requested high effort, but its own trace showed `reasoning effort: none`; the trace-confirmed high-effort re-review is the authoritative Codex pass. The GLM attribution anomaly is also retained verbatim: `glm-5.2:cloud` twice self-reported a Claude model identity—first `claude-opus-4-20250514`, then `claude-opus-4-8`. That is an attribution defect in the Ollama Cloud reviewer route, so both GLM `no_findings` verdicts are weighted accordingly rather than treated as independent proof of model identity.

The initial cleanup claim and all four high-effort Codex re-review claims were reproduced locally with failing tests before implementation. The fixes make per-artifact cleanup failures observable, preserve one bounded cleanup-status bit through adopted and replayed continuations, treat unreadable session inventories as ambiguous before orphan-receipt pruning, and apply the broad receipt-shape detector to text blobs rather than requiring a whole-file JSON receipt. Scanner regressions reject key-value, YAML, JSONL, wrapped JSON, and single-object JSON receipts while an inert documentation/test-source control passes. The first strengthened detector found one candidate-history collision, `evals/corpus/cases/abstain-binary-omitted.json`; inspection established detector overreach because it is deliberately synthetic nested evidence (`review_id: eval-…`, `repository_root: eval-fixture`), not runtime state. Requiring a concrete runtime review key, workspace key, or UUID review ID for non-object serialized shapes removed that false positive without weakening the reproduced cases. An isolated clean candidate scan then passed over `761` reachable-history text blobs (`93` commits, `18` refs, `2` annotated tags) and `210` current-tree text files; both scanner processes exited `0`.

PR #22 then stopped before merge when its authorized bot review alleged a receipt serialized inside a JSON string. The local seed `/tmp/repro-serialized-receipt.mjs` committed one outer diagnostic object containing the full receipt as a string; the scanner incorrectly returned `ok: true` after scanning one 162-byte text blob. A RED regression preserved that exact shape. The bounded final fix walks valid JSON through at most four levels and 512 values, decodes string values that themselves contain JSON objects, and rejects any literal 64-hex token within 192 characters of `review_key`, `terminal_status`, `reviewer_runs`, or `evidence_digest`. Added controls cover the stopped-session seed, a double-escaped variant, a receipt in a JSON array, a plain log line, ordinary documentation without a hex value, and clearly synthetic short keys. The final candidate scan initially rediscovered the same synthetic eval case because the walker inspected ordinary nested objects; that was detector overreach, not runtime state, and the walker was narrowed to the specified string-decoding rung. The resulting isolated candidate passed `766` reachable-history text files (`94` commits, `18` refs, `2` annotated tags) and `210` current-tree text files with both scanner subprocesses at exit `0`. The explicit shipped limit is deliberate: the guardrail targets accidental plain, JSON, singly encoded string, and value-adjacent receipt inclusion; malicious multi-layer encoding, compression, base64, or splitting is outside scanner scope. The product boundary remains that Buddy writes receipts only under private state.

The Phase 2 call ceiling was exhausted by the two initial calls and one re-review per reviewer. The publication scanner fix and the three follow-on lifecycle/pruner fixes therefore shipped **without provider re-review**; they carry reproduced failing tests converted to focused passing regressions. rc.3 proceeds on that basis by owner authority. No provider fallback or additional Phase 2 call occurred. The preserved private review outputs were bound before cleanup by these SHA-256 values: initial Codex stdout `b8f5ca1c36d9d5eb89239c6ca27759155d0fd8219c1099419ec4ed3b9fad57d6`, initial GLM stdout `e6025a8919060e5cb196922b1ac3f18ac464545a021276a7efc560609c1e43a8`, high-effort Codex stdout `81ad511349733b3973f297b73234e942fdb8e03b0b9bdd9a388ba3b2f479b60d`, and high-effort GLM stdout `c14c5e6316d7c8b825f41723dbeea04efa62a9e2c3e33f3518c5c90747f3692a`. The final pre-commit local chain recorded `777` tests, `759` passes, `18` intentional skips, and `0` failures; `85` syntax-checked modules; `127` public files; clean skill/plugin validators; and no Gitleaks findings across `96` commits or the working directory. After the packet identities, verdicts, timestamps, anomalies, hashes, reproduction seeds, and resulting regressions were preserved here and in tests, `/tmp/codex-buddy-phase2-review/`, both receipt repro scripts, the packet assembler, and all isolated scanner candidates were removed; an independent existence check confirmed every target and candidate glob absent.

### rc.2 merge, dispatch, and approval attribution

GitHub attributes PR #13's author and merger to `pnascimento9596`. It merged at `2026-08-01T09:38:44Z`, producing source commit `6975a04a697bfe65602f34e790501058481b992a`. Release run `30694161526` was created at `2026-08-01T09:39:11Z` by `pnascimento9596`; its actor and triggering actor are both that account, its event is `workflow_dispatch`, and it completed successfully at `2026-08-01T09:58:55Z`.

The run approvals API returns three approved `public-release` reviews by `pnascimento9596`, with comments approving the build/publication workflow, attestation, and final publication. That API omits approval timestamps. Deployment status records bound the approvals to these windows: build moved from `waiting` at `09:52:22Z` to `queued` at `09:54:49Z`; attestation moved from `waiting` at `09:55:15Z` to `queued` at `09:57:32Z`; publication moved from `waiting` at `09:57:46Z` to `queued` at `09:58:24Z`. The corresponding jobs started at `09:54:52Z`, `09:57:35Z`, and `09:58:27Z`.

The public account event feed independently shows the PR merge at `09:38:44Z`, the protected-main push at `09:38:45Z`, and branch deletion at `09:38:46Z`, all attributed to `pnascimento9596`. That feed is not the account Security Log and cannot prove which local agent or browser initiated an account-owner action. Agent sessions on this machine authenticate as `pnascimento9596`; GitHub therefore establishes the account identity, not whether the human or an authorized agent used the account token. The active GitHub CLI credential is an OAuth token for `pnascimento9596` with `gist`, `read:org`, `repo`, and `workflow` scopes. The `/user` API does not expose the account's OAuth-app inventory or fine-grained PAT inventory; those require browser settings and Security Log review.

The merge, dispatch, three approvals, and publication form one 20-minute account-attributed burst. No identity other than `pnascimento9596` and GitHub Actions appears in the run, approval, deployment, PR, or public-event evidence.

### Current limitations in this layer

The published rc.2 source did not receive the fresh independent exact-head review prescribed by the roadmap gates before publication. Phase 2 supplied that review against post-rc.2 protected main and one exact cleanup-fix head; later reproduced fixes were not provider-re-reviewed because the authorized call ceiling was exhausted.

Both Phase 2 GLM responses included `findings: []` explicitly, so the strict findings-array requirement held on that route despite the model-attribution anomaly. The published rc.2 artifact predates the clean-filter, filtered-path, governance, and Phase 2 corrections; the published rc.3 POSIX trial above is the current artifact-bound evidence.

## Layer B - frozen `v0.5.0-rc.1` publication evidence, historical

<a id="post-publication-addendum-2026-07-23"></a>

This layer preserves the historical `v0.5.0-rc.1` publication evidence. These values are not current-head claims and must not be overwritten with current `main` numbers.

### Published RC identity

The GitHub prerelease for `v0.5.0-rc.1` was published at `2026-07-21T04:05:29Z` from source commit `01fad043c22b045a702485046c243ba1e3f833c6`.

Historical successful runs:

- PR validation `29798480284`: `success` for pull-request head `44aa6b3663127ae2765f78b5d47e5e1fa29c01dc`.
- Protected-main validation `29799020760`: `success` at released source `01fad043c22b045a702485046c243ba1e3f833c6`.
- Release publication `29799553023`: `success` at released source `01fad043c22b045a702485046c243ba1e3f833c6`; exact publish step completed at `2026-07-21T04:05:29Z`.

Artifact-only identity:

- tag object: `fff82d167f9cbcf4440a942a5f366ae599ea09c5`
- distribution commit: `f819879d158a37d0f8a476da65e5502f1cd5ef9d`
- distribution tree: `84b5e4c93f1733ce02157fa1155a2411a6c3ccdd`
- release-manifest SHA-256: `2b61320d766c750ce6642b652003bb7296f99c437e33f3145065293c270fffe9`
- artifact-content SHA-256: `decc03263b01d7eeb088797a56a75c97f76a52fda57e4ee4d35447f863114682`

### Release assets and provenance

| Release asset | SHA-256 | Provenance subject |
|---|---|---|
| `codex-buddy-reviewer-0.5.0-rc.1.tar.gz` | `60ad2571202dbcf5def899a1c9de5b4af75d7cb2fbdb7efd326de1023e2ffa88` | yes |
| `codex-buddy-reviewer-0.5.0-rc.1.tar.gz.sha256` | `b46a6b740849d4c96005392a67c9857bbc01da07cd5f869fb143bb30efd8ce31` | no; checksum metadata asset |
| `codex-buddy-reviewer-0.5.0-rc.1-distribution.bundle` | `88c9a8fbee898e42f256726a8110cdb0e9b88f1382fff6c5e046eaa8222b9aee` | yes |
| `codex-buddy-reviewer-0.5.0-rc.1-distribution.bundle.sha256` | `3e2e609e7986d80337958ed4b41699db94b6ec1acdcf018c1afc6cc8af8d78e9` | no; checksum metadata asset |
| `codex-buddy-reviewer-0.5.0-rc.1-distribution.json` | `35276704f34fc6005043028b75d31759a5477f7267e86113c9a1a0750b119228` | yes |

`gh attestation verify --repo pnascimento9596/codex-buddy-reviewer` succeeded independently for each of the three provenance subjects. The verified predicate type is `https://slsa.dev/provenance/v1`.

Attestation identity:

- subject alternative name: `https://github.com/pnascimento9596/codex-buddy-reviewer/.github/workflows/release.yml@refs/heads/main`
- issuer: `https://token.actions.githubusercontent.com`
- workflow: `release artifact` in `pnascimento9596/codex-buddy-reviewer` at `refs/heads/main`
- workflow and source digest: `01fad043c22b045a702485046c243ba1e3f833c6`
- trigger: `workflow_dispatch`
- invocation: `https://github.com/pnascimento9596/codex-buddy-reviewer/actions/runs/29799553023/attempts/1`

The checksum metadata assets are release assets with verified hashes, but they are not subjects in the SLSA statement. The statement covers exactly the tarball, distribution bundle, and distribution JSON listed above.

### Released-head totals

The 2026-07-23 local recon at the released head recorded `706` total tests, `688` passes, and `18` intentional skips. Live retrieval of the protected-main macOS job in run `29799020760` independently reported `706` tests, `688` passes, `0` failures, and `18` skips.

### Frozen pet asset identities

| Package | Scope | SHA-256 |
|---|---|---|
| `buddy-byte` | public/cleared | `0a6310229b6dbe12294314abf2bceef88e34aee8c5ca5f12eb9ac09a762f38b5` |
| `buddy-mochi` | public/cleared | `3f1dc884f8ab4a691cfc84692b998a991da8de734ccbccfa27c137bf8f30be3a` |
| `buddy-orbit` | public/cleared | `26efcaa8fc2b96999db2bbc2b82d934df6660de8c45997a16b11f3b1c7c389f7` |
| `buddy-bella` | public/cleared | `3454b0b4b05a1c36fcc74840a835498e7b6f4fd092af7b532bb94e7d3ce6ef0f` |
| `buddy-lupo` | public/cleared | `5d20b8fffc10c7282f05909ac5bbbe3c5f3b36f473edbebaeea325580bbb8a4e` |

## Layer C - frozen `v0.5.0-rc.2` publication evidence, historical

This layer freezes the rc.2 publication identity and the independent post-publication verification performed at `2026-08-02T13:55:13Z`. These values describe the published artifact, not current `main`.

### Published RC identity

- source commit: `6975a04a697bfe65602f34e790501058481b992a`
- release run: `30694161526` (`workflow_dispatch`, success)
- published at: `2026-08-01T09:58:52Z`
- annotated tag object: `239709efc1e2916922d7e698608c4fa92b0826df`
- parentless distribution commit: `e5cf806e48df8ce3eb3dc6be6c08f86148c3efdc` (`0` parents)
- distribution tree: `823b3e6d061e266be8e71bc9fc0b3d3c0f7274fc`

An anonymous credential-disabled clone resolved clean `main` to `bedb4565a369aa3878c8afbde28216b2aed4e47e`, found the annotated rc.2 tag, peeled it to the parentless distribution commit and exact tree above, and found `Source-Commit: 6975a04a697bfe65602f34e790501058481b992a` in the tag annotation.

### Release assets and hashes

Both checksum sidecars passed `shasum -a 256 -c`. Independently computed hashes matched the digests reported by GitHub for all five assets:

| Release asset | SHA-256 | Provenance subject |
|---|---|---|
| `codex-buddy-reviewer-0.5.0-rc.2.tar.gz` | `3b852de6b7ed5d31a8362d3fd406d76a00bef90bedd969f3be6a6492126925ea` | yes |
| `codex-buddy-reviewer-0.5.0-rc.2.tar.gz.sha256` | `b0e5663fc7266a220a8dc2911a82d629e74a38a67f843ad3a1867d3a06cca81b` | no; checksum metadata asset |
| `codex-buddy-reviewer-0.5.0-rc.2-distribution.bundle` | `ceee75ba8c846886dac2483f9caca976fc2ced889e9d465a32c2a1e94f7f3ce3` | yes |
| `codex-buddy-reviewer-0.5.0-rc.2-distribution.bundle.sha256` | `209ae53ee00c5419012b9a226719c2679a2d3b154ecf0a243643106054f52320` | no; checksum metadata asset |
| `codex-buddy-reviewer-0.5.0-rc.2-distribution.json` | `09105d57fc29c6a287dd9207ea945fef91626dd74ff72d44f8d3e5819b97331c` | yes |

### Attestation verification

`gh attestation verify` succeeded independently for the tarball, distribution bundle, and distribution JSON while enforcing repository `pnascimento9596/codex-buddy-reviewer`, source digest `6975a04a697bfe65602f34e790501058481b992a`, source ref `refs/heads/main`, signer workflow `pnascimento9596/codex-buddy-reviewer/.github/workflows/release.yml`, and denial of self-hosted runners.

All three subjects resolve to the same signed identity:

- subject alternative name: `https://github.com/pnascimento9596/codex-buddy-reviewer/.github/workflows/release.yml@refs/heads/main`
- trigger: `workflow_dispatch`
- source and workflow digest: `6975a04a697bfe65602f34e790501058481b992a`
- source ref: `refs/heads/main`
- runner environment: `github-hosted`
- invocation: `https://github.com/pnascimento9596/codex-buddy-reviewer/actions/runs/30694161526/attempts/1`

The external scratch clone, downloaded assets, and generated attestation JSON were removed after verification.

## Layer D - frozen `v0.5.0-rc.3` publication evidence, historical

This layer freezes the rc.3 publication identity and the independent post-publication verification performed on `2026-08-04`. These values describe the published artifact and must not be replaced with later `main` state.

### Published RC identity

- source commit: `0c6f09ae14d834fccb2a2289f6731511dbbdb034`
- release run: `30861281580` (attempt 1, `workflow_dispatch`, success)
- published at: `2026-08-04T01:09:55Z`
- annotated tag object: `eb6a4541cbe75c73648da806ffacd22aef2b2f0d`
- parentless distribution commit: `8782b70c5c664f5a73f9c225a802c71f1ff49ccf` (`0` parents)
- distribution tree: `ac9ffe81aa3b170cf519ef1b35977a15f9cfae4b`
- release manifest SHA-256: `f0e1556ae89c12446c736b6fd2fa11e056fc311a3ee54fc0d9623ed5740882e9`
- artifact content SHA-256: `b12014419d18d490bb3efaf244a9d47021d619eca6bff83e4e68f80836a4046b`

An anonymous credential-disabled clone resolved public `main` to the source commit above. The rc.3 ref was an annotated tag object, its annotation embedded the exact `Source-Commit`, release-manifest digest, artifact-content digest, and distribution tree, and its peeled target was the zero-parent distribution commit. The downloaded distribution JSON independently reported the same tag object, commit, tree, source commit, and digests. The distribution bundle verified as complete, reproduced the same tag/commit/tree identities, and its checked-out 131-file tree was byte-exact with the independently extracted tarball. The trusted source verifier accepted the extracted 130-file public package and all five cleared pet IDs.

### Dispatch and protected-environment attribution

GitHub attributed the dispatch actor and triggering actor to `pnascimento9596`, account ID `198005926`, at exact protected-main source `0c6f09ae14d834fccb2a2289f6731511dbbdb034`. Every reusable validation lane passed before artifact construction. The protected `public-release` environment required that same owner account and presented three separate approvals for build, attestation, and publication. The approvals API records all three as `approved`; deployments `5735240282`, `5735258101`, and `5736203039` bind the protected stages to the exact source SHA. This proves the configured account path, not which person, browser session, token, or delegated process exercised the account.

### Release assets and hashes

Both checksum sidecars passed `shasum -a 256 -c`. Independently computed hashes and sizes matched GitHub's asset metadata for all five anonymously downloaded assets:

| Release asset | Bytes | SHA-256 | Provenance subject |
|---|---:|---|---|
| `codex-buddy-reviewer-0.5.0-rc.3.tar.gz` | `13662721` | `6de1ab3c4a47a96abbc5faf868d862d614a2e2a196fd4ec730f4b7c7b9d0b759` | yes |
| `codex-buddy-reviewer-0.5.0-rc.3.tar.gz.sha256` | `105` | `a7237c233ceb3dd523fe05c32c53437f698fb77f90920da4424ae9c77745dbe3` | no; checksum metadata asset |
| `codex-buddy-reviewer-0.5.0-rc.3-distribution.bundle` | `13705017` | `4a954f2eea8069430857c650687f1152365da17dcdcab3b02b9e411c3b4854e1` | yes |
| `codex-buddy-reviewer-0.5.0-rc.3-distribution.bundle.sha256` | `118` | `9f5923ee65f02991035fa98918fb394094c2015ce4a72c93b8888f5f092e96b0` | no; checksum metadata asset |
| `codex-buddy-reviewer-0.5.0-rc.3-distribution.json` | `592` | `f7d61e73a7448fc02dd9966f35aaaf2e118023d3ab32703ccd2a0cedd540fd11` | yes |

### Policy-bound attestation verification

`gh attestation verify` succeeded independently for the tarball, distribution bundle, and distribution JSON while enforcing repository `pnascimento9596/codex-buddy-reviewer`, source digest `0c6f09ae14d834fccb2a2289f6731511dbbdb034`, source ref `refs/heads/main`, signer workflow `pnascimento9596/codex-buddy-reviewer/.github/workflows/release.yml`, and denial of self-hosted runners. Certificate-backed fields were identical for all three subjects:

- subject alternative name: `https://github.com/pnascimento9596/codex-buddy-reviewer/.github/workflows/release.yml@refs/heads/main`
- trigger: `workflow_dispatch`
- source and workflow digest: `0c6f09ae14d834fccb2a2289f6731511dbbdb034`
- source ref: `refs/heads/main`
- runner environment: `github-hosted`
- invocation: `https://github.com/pnascimento9596/codex-buddy-reviewer/actions/runs/30861281580/attempts/1`

The external scratch clone, downloaded assets, extracted artifact, bundle checkout, and generated attestation JSON were removed after the evidence was recorded.

## Layer E - frozen `v0.5.0-rc.4` publication evidence, historical

This layer freezes the rc.4 publication identity and the independent post-publication verification performed on `2026-08-05`. These values describe the published artifact and must not be replaced with later `main` state.

### Published RC identity

- source commit: `b56224fb8e37ca02e071cda41702af4ef20f1ebb`
- release run: `31013433126` (attempt 2 success after attempt-1 publish race; attestations bound to attempt 1)
- published at: `2026-08-05T14:25:20Z`
- annotated tag object: `b5d8fbc47515b6ae0ab96491b4125cc6ea8f9149`
- parentless distribution commit: `ac9f870f455645613c9f3dc8de4196fdc8a25d6d` (`0` parents)
- distribution tree: `62d851d5afadbc92fdf12bad4afa1163a6521af1`
- release manifest SHA-256: `6975bfa5becb5363aea1024ae42638626b88670fd742128cd51bdaa8f77341d1`
- artifact content SHA-256: `a38c05cba02dd11d09f6fa36e3c7547555ef80be815f8b4354d3ee74ad86235b`
- file count: `131`

An anonymous credential-disabled clone of tag `v0.5.0-rc.4` resolved to the parentless distribution commit above. The rc.4 ref is an annotated tag object; its annotation embeds the exact `Source-Commit`, release-manifest digest, artifact-content digest, and distribution tree; its peeled target is the zero-parent distribution commit. The downloaded distribution JSON independently reported the same tag object, commit, tree, source commit, and digests. `git bundle verify` accepted the distribution bundle as complete history containing the annotated tag object. The extracted 131-file tarball tree was byte-exact with the detached tag checkout after excluding only `.git`.

### Dispatch and protected-environment attribution

GitHub attributed the dispatch actor and triggering actor to `pnascimento9596`, account ID `198005926`, at exact protected-main source `b56224fb8e37ca02e071cda41702af4ef20f1ebb`. Every reusable validation lane passed before artifact construction. The protected `public-release` environment required that same owner account and presented separate approvals for build, attestation, and publication (attempt 1), plus a publish-job rerun approval on attempt 2 after a post-tag-push remote-lookup race (`Published tag object does not match the verified distribution receipt` despite the remote tag object already equaling receipt `tag_object` `b5d8fbc…`). No Release existed until attempt 2 completed. This proves the configured account path, not which person, browser session, token, or delegated process exercised the account.

### Release assets and hashes

Both checksum sidecars passed `shasum -a 256 -c`. Independently computed hashes and sizes matched GitHub's asset metadata for all five downloaded assets:

| Release asset | Bytes | SHA-256 | Provenance subject |
|---|---:|---|---|
| `codex-buddy-reviewer-0.5.0-rc.4.tar.gz` | `11184186` | `2ba45154d1e5c5218900b295412744ea9cfa1fe3a452085f9f77693651453df7` | yes |
| `codex-buddy-reviewer-0.5.0-rc.4.tar.gz.sha256` | `105` | `367241c5ed494f5e17b122dfe6299e9f473b790090465ccdd47152e312b96430` | no; checksum metadata asset |
| `codex-buddy-reviewer-0.5.0-rc.4-distribution.bundle` | `11225469` | `80e579b05d2567949d38514141eb751a444c8444aa84b011d3ecf6aa90b44492` | yes |
| `codex-buddy-reviewer-0.5.0-rc.4-distribution.bundle.sha256` | `118` | `061f25349ff111607a56c32ee8949979d9cc057b6e0551c75156eb521288b5e0` | no; checksum metadata asset |
| `codex-buddy-reviewer-0.5.0-rc.4-distribution.json` | `592` | `3ba76a8b1780395fa8ad49c59af48f0c828d254aeff74970949b01a6fd9d26b0` | yes |

### Policy-bound attestation verification

`gh attestation verify` succeeded independently for the tarball, distribution bundle, and distribution JSON while enforcing repository `pnascimento9596/codex-buddy-reviewer`, source digest `b56224fb8e37ca02e071cda41702af4ef20f1ebb`, source ref `refs/heads/main`, signer workflow `pnascimento9596/codex-buddy-reviewer/.github/workflows/release.yml`, and denial of self-hosted runners. Certificate-backed fields were identical for all three subjects:

- subject alternative name: `https://github.com/pnascimento9596/codex-buddy-reviewer/.github/workflows/release.yml@refs/heads/main`
- trigger: `workflow_dispatch`
- source and workflow digest: `b56224fb8e37ca02e071cda41702af4ef20f1ebb`
- source ref: `refs/heads/main`
- runner environment: `github-hosted`
- invocation: `https://github.com/pnascimento9596/codex-buddy-reviewer/actions/runs/31013433126/attempts/1`

Attestation certificates bind to attempt 1 (when the attest job completed). Publication completed on attempt 2 after the tag already matched the receipt.

The external scratch clone, downloaded assets, extracted artifact, and generated attestation JSON were removed after the evidence was recorded.

## Layer F - unresolved gates

The following gates remain unresolved for stable promotion after published rc.4 and artifact-bound host-e2e:

- Windows current-user-only DACL creation and verification for durable Buddy state and provider temporary roots.
- Live Windows provider egress after the DACL gate is implemented and verified.
- Repository-owned Codex validator wiring: skill/plugin validators pass on this host, but the repository still has no package-script entry point in the ordinary npm chain.
- Owner-only browser governance: OAuth app inventory, fine-grained PAT inventory, 2FA/email visibility, and admin-bypass decision for `public-release` (each later release dispatch needs its own Security Log window, including rc.4).
- Optional: fresh exact-head whole-repository deep security scan at the final promotion head if owner policy requires it.
- Stable `v0.5.0` promotion remains an explicit owner decision after the remaining gates above close.

Closed on published rc.4 (see `docs/host-evidence/index.md` rc.4 section and readiness ledger): published-artifact speculative receipt adoption; five-pet host-e2e v2 bundle against the published archive; first-enable baseline UX #37; #36/#38 root causes.
