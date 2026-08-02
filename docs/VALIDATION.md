# Validation Record

This document separates validation evidence into four explicitly labeled layers. Current evidence must not overwrite frozen publication evidence, and unresolved gates remain unresolved until a fresh run proves otherwise.

## Layer A - current evidence at exact protected main

Current protected `main` is `bedb4565a369aa3878c8afbde28216b2aed4e47e`. The first-parent range after the released rc.2 source contains PR #15 (`3281a44bfb72b9ac76e6e1bee3f59f04a897bcb2`), PR #17 (`c51e6fb12fae1b5c2fb8a82cf5daa0ff20b2bfeb`), and PR #19 (`bedb4565a369aa3878c8afbde28216b2aed4e47e`). PR #17 prevents clean-filter execution during capture; PR #19 omits unproven filtered worktree representations while preserving reviewable stage-0 index evidence.

### Local exact-HEAD validation on `bedb4565a369aa3878c8afbde28216b2aed4e47e`

The final local verification of this protected head recorded `769` tests, `751` passes, `18` intentional skips, and `0` failures. `npm run check:syntax` checked `85` modules; bare `npm run security:publication` passed after scanning `746` history text blobs; `npm run release:boundary` verified `127` public files; and `git diff --check` was clean. The focused filtered-path regression selection passed `7/7` tests. Provider tests were mocked and no live provider was contacted.

### Protected-main GitHub validation evidence

| PR / source | Protected-main run | Head SHA | Result |
|---|---:|---|---|
| PR #13, released rc.2 source | `30694148219` | `6975a04a697bfe65602f34e790501058481b992a` | success |
| PR #15, validation-layer reconciliation | `30707435091` | `3281a44bfb72b9ac76e6e1bee3f59f04a897bcb2` | success |
| PR #17, filter-free capture hardening | `30728024227` | `c51e6fb12fae1b5c2fb8a82cf5daa0ff20b2bfeb` | success |
| PR #19, filtered worktree scope hardening | `30732240371` | `bedb4565a369aa3878c8afbde28216b2aed4e47e` | success |

### rc.2 merge, dispatch, and approval attribution

GitHub attributes PR #13's author and merger to `pnascimento9596`. It merged at `2026-08-01T09:38:44Z`, producing source commit `6975a04a697bfe65602f34e790501058481b992a`. Release run `30694161526` was created at `2026-08-01T09:39:11Z` by `pnascimento9596`; its actor and triggering actor are both that account, its event is `workflow_dispatch`, and it completed successfully at `2026-08-01T09:58:55Z`.

The run approvals API returns three approved `public-release` reviews by `pnascimento9596`, with comments approving the build/publication workflow, attestation, and final publication. That API omits approval timestamps. Deployment status records bound the approvals to these windows: build moved from `waiting` at `09:52:22Z` to `queued` at `09:54:49Z`; attestation moved from `waiting` at `09:55:15Z` to `queued` at `09:57:32Z`; publication moved from `waiting` at `09:57:46Z` to `queued` at `09:58:24Z`. The corresponding jobs started at `09:54:52Z`, `09:57:35Z`, and `09:58:27Z`.

The public account event feed independently shows the PR merge at `09:38:44Z`, the protected-main push at `09:38:45Z`, and branch deletion at `09:38:46Z`, all attributed to `pnascimento9596`. That feed is not the account Security Log and cannot prove which local agent or browser initiated an account-owner action. Agent sessions on this machine authenticate as `pnascimento9596`; GitHub therefore establishes the account identity, not whether the human or an authorized agent used the account token. The active GitHub CLI credential is an OAuth token for `pnascimento9596` with `gist`, `read:org`, `repo`, and `workflow` scopes. The `/user` API does not expose the account's OAuth-app inventory or fine-grained PAT inventory; those require browser settings and Security Log review.

The merge, dispatch, three approvals, and publication form one 20-minute account-attributed burst. No identity other than `pnascimento9596` and GitHub Actions appears in the run, approval, deployment, PR, or public-event evidence.

### Current limitations in this layer

The published rc.2 source did not receive the fresh independent exact-head review prescribed by the roadmap gates before publication. The post-publication byte, tag, hash, and attestation checks in Layer C do not replace that review. Fresh independent review of current protected `main` is now the rc.3/stable pre-release gate and requires explicit owner consent before any provider contact.

The strict `findings`-required rejection path remains unverified against live OpenCode and Ollama Cloud responses. The published rc.2 artifact also predates the clean-filter evidence and filtered-path scope corrections in PRs #17 and #19.

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

The following gates remain unresolved for rc.3/stable promotion or for stronger current-head assurance:

- Fresh independent exact-head review of current protected `main`, requiring explicit owner consent before provider contact.
- Fresh exact-head whole-repository Codex Deep Security Scan.
- Five-pet artifact-bound host observations for Byte, Mochi, Orbit, Bella, and Lupo.
- Windows current-user-only DACL creation and verification for durable Buddy state and provider temporary roots.
- Live Windows provider egress after the DACL gate is implemented and verified.
- Stable artifact requirements: rebuild from exact protected `main`, reverify after deterministic archive/re-extraction, install from the positive artifact boundary, and bind host evidence to that artifact rather than to the private checkout.
- POSIX end-to-end provider execution evidence at the exact stable candidate.
- Repository-owned Codex validator wiring: the documented skill and plugin validator commands passed on this host, but the repository still has no package-script entry point that makes those checks part of the ordinary npm validation chain.
- GitHub account email visibility: the authenticated API token lacks the required `user` scope, so the account owner must set the durable visibility preference in the browser.
- The Windows Node 22 preservation assertion flake from run `30682892670` is tracked in issue #14 and remains unexplained. Because it is a preservation assertion, it is higher-signal than a generic timing flake given the rc.2 no-loss work.
