# Validation Record

This document separates validation evidence into four explicitly labeled layers. Current evidence must not overwrite frozen publication evidence, and unresolved gates remain unresolved until a fresh run proves otherwise.

## Layer A - current evidence at exact protected main

Current protected `main` is `58d8abaf49a2be09322d7a44ceda306f7354ef72`. The first-parent range after the released rc.2 source contains PR #15 (`3281a44bfb72b9ac76e6e1bee3f59f04a897bcb2`), PR #17 (`c51e6fb12fae1b5c2fb8a82cf5daa0ff20b2bfeb`), PR #19 (`bedb4565a369aa3878c8afbde28216b2aed4e47e`), PR #20 (`0219d7aa4b136e034876becb9a7dbeabf2422aa6`), PR #21 (`32f1121c0c916e7820d66095d2f1956793604e40`), PR #22 (`bea53a8473b69c967eac70dd64ca01d417974fdc`), PR #23 (`c703b776bd5af95449978c4d2b025acaecd0c24c`), and PR #24 (`58d8abaf49a2be09322d7a44ceda306f7354ef72`). The later phases ship the reproduced lifecycle/publication fixes, mutation-controlled adversarial corpus cases, and a pinned strict checked-JavaScript slice.

### rc.3 candidate validation based on protected main `58d8abaf49a2be09322d7a44ceda306f7354ef72`

The rc.3 candidate worktree recorded `778` tests, `760` passes, `18` intentional skips, and `0` failures. `npm run check:syntax` checked `85` modules; `npm run check:types` installed the exact lockfile graph and passed with TypeScript `7.0.2` and `@types/node` `26.1.2`; bare `npm run security:publication` passed; `npm run release:boundary` verified `130` public files; two focused release suites passed `31/31`; the review-boundary behavioral suite remained `112/112` before and after checked-JavaScript annotations; and comments-removed emitted JavaScript was byte-identical for all five authorized modules. Gitleaks found no leaks across `104` commits or the candidate worktree, both skill validators and the plugin validator passed, and `git diff --check` was clean. Provider tests were mocked and no live provider was contacted during this gate.

The two frozen historical slices were byte-compared against protected main before this edit: Layer B (rc.1) is `3908` bytes with SHA-256 `145f7e78e68326cd678e39bcbadb402b890584ab1ba54c61073690b6cd946abc`; Layer C (rc.2) is `2914` bytes with SHA-256 `c734e100570f8dcb3fcaad941e5a86f330aa37267c79c4b2b6187e4d360ad33a`. Both comparisons were byte-identical.

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

### Phase 3 and Phase 4 exact-head delivery evidence

PR #23 passed exact-head run `30773320092`, squash-merged normally as `c703b776bd5af95449978c4d2b025acaecd0c24c`, and passed protected-main run `30773941325`. Its eight-case corpus includes mutation-controlled deleted-file old-side citation, selected-evidence truncation/abstention, and control-character grounding-bait cases.

PR #24 passed corrected exact-head run `30775405637` attempt 2, squash-merged normally as `58d8abaf49a2be09322d7a44ceda306f7354ef72`, and passed protected-main run `30776339242`. The initial head failed all validation lanes with `TS2688: Cannot find type definition file for 'node'` because the reusable job did not install the newly pinned development graph. The corrected `check:types` installs exactly from `package-lock.json` before invoking `tsc`; no workflow file changed. Attempt 1 on the corrected head then hit the intermittent Ubuntu Node 22 speculative-checkpoint race tracked in issue #25; the exact focused test passed four consecutive local runs, every other lane was green, and the single authorized rerun passed on the unchanged head. Issue #14 remains the related Windows preservation-assertion intermittent.

### rc.3 pre-dispatch attribution

release dispatch to be executed by delegated agent session under owner instruction of 2026-08-02/03.

The dispatch is authorized only after this candidate merges through normal protection and its exact protected-main source SHA passes protected CI. The delegated session authenticates to GitHub as owner account `pnascimento9596` (account ID `198005926`) and will invoke `.github/workflows/release.yml` from unchanged protected `main` with `version: 0.5.0-rc.3` and `publish: true`. GitHub can establish account, workflow, source, and approval attribution; it cannot establish which person or delegated local session operated an authorized account token.

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

Both Phase 2 GLM responses included `findings: []` explicitly, so the strict findings-array requirement held on that route despite the model-attribution anomaly. Published-artifact end-to-end confirmation for the configured reviewer pair remains a Phase 6 gate. The published rc.2 artifact also predates the clean-filter, filtered-path, governance, and Phase 2 corrections.

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

## Layer D - unresolved gates

The following gates remain unresolved for rc.3 publication, stable promotion, or stronger current-head assurance:

- Fresh exact-head whole-repository Codex Deep Security Scan.
- Five-pet artifact-bound host observations for Byte, Mochi, Orbit, Bella, and Lupo.
- Windows current-user-only DACL creation and verification for durable Buddy state and provider temporary roots.
- Live Windows provider egress after the DACL gate is implemented and verified.
- Stable artifact requirements: rebuild from exact protected `main`, reverify after deterministic archive/re-extraction, install from the positive artifact boundary, and bind host evidence to that artifact rather than to the private checkout.
- Published-artifact POSIX end-to-end provider execution evidence for rc.3, including strict findings-array behavior, speculative receipt adoption, compact output, disable, purge, and retained-byte accounting.
- Repository-owned Codex validator wiring: the documented skill and plugin validator commands passed on this host, but the repository still has no package-script entry point that makes those checks part of the ordinary npm validation chain.
- GitHub account email visibility: the authenticated API token lacks the required `user` scope, so the account owner must set the durable visibility preference in the browser.
- Fine-grained agent PAT inventory and browser Security Log review for the `2026-08-01T09:38:00Z`–`09:59:00Z` publication window remain owner-only browser evidence.
- The `public-release` environment currently requires owner account `pnascimento9596`; browser confirmation remains necessary if the API cannot establish the complete required-reviewer policy and its owner-visible controls.
- The Windows Node 22 preservation assertion intermittent from run `30682892670` is tracked in issue #14. The Ubuntu Node 22 speculative-checkpoint intermittent from run `30775405637` attempt 1 is tracked in issue #25. Both remain open because they touch checkpoint/no-loss behavior.
- Stable `v0.5.0` promotion remains an explicit owner decision after the published-artifact POSIX half, five-pet host observations, Windows DACL/egress work, and remaining governance evidence are reconciled.
