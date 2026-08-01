# Validation Record

This document separates validation evidence into three explicitly labeled layers. Current evidence must not overwrite frozen publication evidence, and unresolved gates remain unresolved until a fresh run proves otherwise.

## Layer A - current evidence at exact protected main

Current protected `main` is `6975a04a697bfe65602f34e790501058481b992a`, merged by PR #13 after the earlier PR #11 protected-main head `90dab8d9fa48842f15164d19bd45c7355469015c`. The requested `90dab8d9` evidence is preserved here because it was protected main after PR #11, but it is no longer the default-branch head.

### Local exact-HEAD validation on `6975a04a697bfe65602f34e790501058481b992a`

The following commands were run on branch `docs/validation-reconciliation` before this document edit, with `HEAD=6975a04a697bfe65602f34e790501058481b992a`:

| Command | Exit | Verbatim totals / result |
|---|---:|---|
| `npm run check:syntax` | 0 | `Syntax checked 84 modules.` |
| `npm run check` | 0 | `tests 754`; `suites 0`; `pass 736`; `fail 0`; `cancelled 0`; `skipped 18`; `todo 0`; `duration_ms 270139.536834`; portable subchecks included `Syntax checked 84 modules.` and `Public release boundary verified from an isolated clean snapshot (126 files).` |
| `npm run security:secrets` | 0 | `81 commits scanned`; scanned approximately `7.43 MB` of history with `no leaks found`; scanned approximately `14.81 MB` of the current directory with `no leaks found`. |
| `npm run security:publication` | 1 | `Publication boundary failed [UNSAFE_HISTORY_EMAIL]: Commit author uses a non-public email that is not explicitly allowlisted.` |
| `npm run release:boundary` | 0 | `Public release boundary verified from an isolated clean snapshot (126 files).` |

Current module count: `84` syntax-checked modules. Current positive release-boundary artifact count: `126` files.

### Protected-main GitHub validation evidence

| PR / source | Protected-main run | Head SHA | Result |
|---|---:|---|---|
| PR #12, squash merge of the rc.2 reconciliation stack | `30683824617` | `0344e13a457ab27f334819cb4686f137c7d13bb3` | success |
| PR #11, action-pin update after PR #12 | `30684263733` | `90dab8d9fa48842f15164d19bd45c7355469015c` | success |
| PR #13, review-path retention race closure after PR #11 | `30694148219` | `6975a04a697bfe65602f34e790501058481b992a` | success |

PR #12 and PR #11 are cited by number because their individual stack SHAs are not reachable from `main`'s first-parent history after squash merges. PR #13 is cited for the same reason.

### Current limitations in this layer

The strict `findings`-required rejection path is covered by local parser/schema tests, but it remains unverified against live OpenCode and Ollama Cloud responses. OpenCode does not enforce the review-result schema at transport, and Ollama Cloud uses JSON formatting plus strict local validation rather than a schema argument.

`IDEA.md` is excluded locally through `.git/info/exclude`, so it no longer makes the working checkout dirty. The remaining no-argument `npm run security:publication` failure is the intentional publication-boundary identity policy for a non-allowlisted public email in reachable history. This document records that result; it does not rewrite history or relax the policy.

## Layer B - frozen `v0.5.0-rc.1` publication evidence, historical

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
- Codex skill/plugin validator gate: the repository currently has no automatable entry point for this gate, so it cannot be counted as a repeatable validation command until one is added.
- Publication-boundary history identity disposition for exact current reachable history: no-argument `npm run security:publication` fails until the public personal author email in reachable history is explicitly allowlisted or otherwise dispositioned.
- The Windows Node 22 preservation assertion flake from run `30682892670` is tracked in issue #14 and remains unexplained. Because it is a preservation assertion, it is higher-signal than a generic timing flake given the rc.2 no-loss work.
