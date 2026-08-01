# Validation Record

This document separates validation evidence into three explicitly labeled layers. Current evidence must not overwrite frozen publication evidence, and unresolved gates remain unresolved until a fresh run proves otherwise.

## Layer A - current evidence at exact protected main

Current protected `main` is `6975a04a697bfe65602f34e790501058481b992a`. The range `90dab8d9..6975a04` contains exactly one first-parent commit: `6975a04 Close rc.2 review-path retention races (#13)`. PR #13 merged head `abcbd0475684523ec5e10ed5420787573ef5f57a` into base `90dab8d9fa48842f15164d19bd45c7355469015c` at `2026-08-01T09:38:44Z`, producing squash commit `6975a04a697bfe65602f34e790501058481b992a`. Its PR-head validation run `30693726400` passed every matrix lane, the validation gate, repository credential scan, and GitGuardian. Protected-main push run `30694148219` then passed at the squash commit.

### Local exact-HEAD validation on `6975a04a697bfe65602f34e790501058481b992a`

The following commands were run on branch `docs/validation-reconciliation` before this document edit, with `HEAD=6975a04a697bfe65602f34e790501058481b992a`:

| Command | Exit | Verbatim totals / result |
|---|---:|---|
| `npm run check:syntax` | 0 | `Syntax checked 84 modules.` |
| `npm run check` | 0 | `tests 754`; `suites 0`; `pass 736`; `fail 0`; `cancelled 0`; `skipped 18`; `todo 0`; `duration_ms 270139.536834`; portable subchecks included `Syntax checked 84 modules.` and `Public release boundary verified from an isolated clean snapshot (126 files).` |
| `npm run security:secrets` | 0 | `81 commits scanned`; scanned approximately `7.43 MB` of history with `no leaks found`; scanned approximately `14.81 MB` of the current directory with `no leaks found`. |
| `npm run security:publication` | 0 | Post-fix branch evidence at `4a5fad7cb7e27a4d9a0063de96094b6b13f508f7`: `Publication boundary passed (history, 729 text blobs scanned).` |
| `npm run release:boundary` | 0 | `Public release boundary verified from an isolated clean snapshot (126 files).` |

Current module count: `84` syntax-checked modules. Current positive release-boundary artifact count: `126` files.

### Identity and publication-boundary dispositions

| Commit | Author | Committer | Identity disposition |
|---|---|---|---|
| `0344e13a457ab27f334819cb4686f137c7d13bb3` | `Paulo Nascimento <pnascimento9596@gmail.com>` | `GitHub <noreply@github.com>` | public Gmail author; GitHub noreply committer |
| `90dab8d9fa48842f15164d19bd45c7355469015c` | `dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>` | `GitHub <noreply@github.com>` | GitHub noreply author and committer |
| `6975a04a697bfe65602f34e790501058481b992a` | `Paulo Nascimento <pnascimento9596@gmail.com>` | `GitHub <noreply@github.com>` | public Gmail author; GitHub noreply committer |
| `e6cd1d737eda20a7485d1e10ac7894e959cb0bae` | `Paulo Nascimento <pnascimento9596@users.noreply.github.com>` | `Paulo Nascimento <pnascimento9596@users.noreply.github.com>` | GitHub noreply author and committer |

The authenticated API attempt to set email visibility to private returned HTTP `404` because the token lacks the `user` scope. The account owner must make that durable account-level change in the GitHub browser settings; repository history was not rewritten.

The committed publication allowlist records the reviewed public Gmail address and exact historical path/blob dispositions. It permits only exact reviewed identities and exact historical blob OIDs, requires a clean replacement blob at each recorded `fixed_at` commit, refuses current-tree suppression, and leaves every other publication check fail-closed. The current Claude fixture path is derived from the platform temporary directory as of `1bd93c6b73b984f8b88339c4b0c3c7cdcc3640fa`; its isolated test passed `12` tests with `0` failures.

### Focused validators at current exact HEAD

The documented focused validators from the source checkout also passed on this host:

| Command | Exit | Verbatim totals / result |
|---|---:|---|
| `node scripts/buddy-eval.mjs validate --json` | 0 | `case_count: 5`; categories `abstain`, `clean`, `defect`, `deletion`, `privacy` |
| `node scripts/validate-pet-atlases.mjs --json` | 0 | `pet_count: 5`; `validation_scope: container-structure-and-catalog-integrity`; `full_pixel_decode: false` |
| `python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/review` | 0 | `Skill is valid!` |
| `python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/buddy-review` | 0 | `Skill is valid!` |
| `python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .` | 0 | `Plugin validation passed` |

### Protected-main GitHub validation evidence

| PR / source | Protected-main run | Head SHA | Result |
|---|---:|---|---|
| PR #12, squash merge of the rc.2 reconciliation stack | `30683824617` | `0344e13a457ab27f334819cb4686f137c7d13bb3` | success |
| PR #11, action-pin update after PR #12 | `30684263733` | `90dab8d9fa48842f15164d19bd45c7355469015c` | success |
| PR #13, review-path retention race closure after PR #11; PR-head run `30693726400` | `30694148219` | `6975a04a697bfe65602f34e790501058481b992a` | success |

PR #12 and PR #11 are cited by number because their individual stack SHAs are not reachable from `main`'s first-parent history after squash merges. PR #13 is cited for the same reason.

### Current limitations in this layer

The strict `findings`-required rejection path is covered by local parser/schema tests, but it remains unverified against live OpenCode and Ollama Cloud responses. OpenCode does not enforce the review-result schema at transport, and Ollama Cloud uses JSON formatting plus strict local validation rather than a schema argument.

The private planning-note file is excluded locally through the repository-local exclude file, so it no longer makes the working checkout dirty. Bare `npm run security:publication` now passes through the committed reviewed dispositions; no flag, environment-only suppression, history rewrite, or tag change is required.

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

## Layer C - unresolved gates

The following gates remain unresolved for stable promotion or for stronger current-head assurance:

- Fresh exact-head whole-repository Codex Deep Security Scan.
- Five-pet artifact-bound host observations for Byte, Mochi, Orbit, Bella, and Lupo.
- Windows current-user-only DACL creation and verification for durable Buddy state and provider temporary roots.
- Live Windows provider egress after the DACL gate is implemented and verified.
- Stable artifact requirements: rebuild from exact protected `main`, reverify after deterministic archive/re-extraction, install from the positive artifact boundary, and bind host evidence to that artifact rather than to the private checkout.
- POSIX end-to-end provider execution evidence at the exact stable candidate.
- Repository-owned Codex validator wiring: the documented skill and plugin validator commands passed on this host, but the repository still has no package-script entry point that makes those checks part of the ordinary npm validation chain.
- GitHub account email visibility: the authenticated API token lacks the required `user` scope, so the account owner must set the durable visibility preference in the browser.
- The Windows Node 22 preservation assertion flake from run `30682892670` is tracked in issue #14 and remains unexplained. Because it is a preservation assertion, it is higher-signal than a generic timing flake given the rc.2 no-loss work.
