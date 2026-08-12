# Maintenance

`v0.6.0` is installed from the immutable `v0.6.0` Git tag. Keep the
installation, local state, and release rollback boundaries separate.

## Routine checks

Run the read-only checks from the installed plugin root or through the
namespaced skill:

```text
$codex-buddy-reviewer:buddy-review show status
$codex-buddy-reviewer:buddy-review run local doctor checks
$codex-buddy-reviewer:buddy-review show local data status
```

Equivalent direct commands are:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" mode status --cwd "/path/to/repository"
node "<plugin-root>/scripts/buddy-review.mjs" doctor --cwd "/path/to/repository"
node "<plugin-root>/scripts/buddy-review.mjs" data status --cwd "/path/to/repository"
```

The normal doctor invocation makes no network or model call. Use
`--provider-check` only with explicit authorization for one bounded health call
per configured reviewer. A `warn` can be a disabled workspace or an unverified
manual host state; read the individual checks instead of treating the aggregate
as a product verdict.

Do not share raw `doctor --json` or `data status --json` output without
redaction. These diagnostics can include absolute workspace and private-state
paths, provider/model identifiers, and local inventory details.

## Updating the plugin

Review the target tag before changing the installation. Use a new immutable
release tag and let the marketplace manage the cache:

```bash
codex plugin marketplace upgrade codex-buddy-reviewer --json
codex plugin add codex-buddy-reviewer@codex-buddy-reviewer --json
codex plugin list --json
```

If the marketplace source itself must move to a specific release tag, replace
it deliberately rather than pointing it at `main`:

```bash
codex plugin remove codex-buddy-reviewer@codex-buddy-reviewer --json
codex plugin marketplace remove codex-buddy-reviewer --json
codex plugin marketplace add pnascimento9596/codex-buddy-reviewer --ref vX.Y.Z --json
codex plugin add codex-buddy-reviewer@codex-buddy-reviewer --json
```

After every update:

1. Confirm the installed version and Git marketplace source with
   `codex plugin list --json` and `codex plugin marketplace list --json`.
2. Start a fresh Codex task.
3. Review and trust hook changes through Codex's normal prompt.
4. Run offline doctor.
5. Re-check the workspace mode configuration; upgrades must not silently
   change the provider, model, scope, confidence threshold, or continuous-review
   consent.
6. If a pet package changed, refresh Settings → Pets and inspect the selected
   native companion with `/pet`.

## Rollback

The known rollback target for this lane is `v0.5.1`. Roll back only to a
published immutable tag after confirming its release and artifact identity.
Do not retag or mutate `v0.6.0`.

```bash
codex plugin remove codex-buddy-reviewer@codex-buddy-reviewer --json
codex plugin marketplace remove codex-buddy-reviewer --json
codex plugin marketplace add pnascimento9596/codex-buddy-reviewer --ref v0.5.1 --json
codex plugin add codex-buddy-reviewer@codex-buddy-reviewer --json
codex plugin list --json
```

After rollback, disable review before changing configuration, start a fresh
Codex task, re-run doctor, and confirm the mode state. Keep the release assets
and tag unchanged; rollback is a local consumer change, not a publication
operation.

## Local data and retention

Automatic review data is private and workspace-scoped. Content-bearing
receipts and renderer events have bounded retention; cleanup is opportunistic,
not a daemon. Provider temporary state is also bounded and ownership-checked.

Inspect first:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" data status \
  --cwd "/path/to/repository"
```

To purge the current workspace's review content:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" mode disable \
  --cwd "/path/to/repository"
node "<plugin-root>/scripts/buddy-review.mjs" data purge \
  --cwd "/path/to/repository" --confirm-purge
```

Purge refuses while review mode or a live egress capability is active. It
removes exact workspace review content and eligible attributable provider
temporary runs. It preserves provider authentication, shared pet installation
state, unresolved setup rollback evidence, other workspaces, and unsafe or
ambiguous runs. Add `--include-settings` only when you explicitly intend to
remove workspace mode, reviewer, consent, presentation, circuit, and egress
settings as well.

After upgrading from older marketplace builds, run the disable/status/purge
sequence once if the old build may have written under a different plugin-data
root. The current status command enumerates the installed plugin data roots and
the legacy durable fallback; do not manually delete paths from its output.

## Provider and platform posture

Current operator adapters are exactly:

- `claude` through Claude Code
- `ollama` for local Ollama or Ollama Cloud
- `opencode` for explicitly configured routed connections

There is no silent provider fallback. If a configured lane fails, the failure
remains attributed; one healthy lane can produce an attributed partial result.
No Grok review route is part of the current operator surface.

Windows x64 live provider contact remains fail-closed unless the packaged
protocol-2 helper verifies current-user-only private-state DACLs on an
ACL-capable volume and `CODEX_BUDDY_WINDOWS_EGRESS_ENABLE=1` is explicitly set.
`CODEX_BUDDY_WINDOWS_EGRESS_BLOCK=1` overrides that opt-in. ARM64,
non-ACL volumes, missing or stale verification, and the two Lane J setup-failure
attempts do not prove live Windows review; native Windows Codex host e2e remains
UNRUN.

## Release maintenance

A future release must use the protected release workflow from protected `main`.
Before publication, bind all tests, reviews, artifacts, host evidence, and
attestations to one exact source SHA. A new commit invalidates old source-bound
evidence. After publication, verify the immutable tag, GitHub Release, asset
checksums, distribution commit, anonymous downloads, and attestations before
calling the release complete.

The repository's release controls prohibit force-pushes, history rewrites,
manual tag movement, silent provider substitution, app-bundle patches, missing-
baseline evidence, and fabricated manual or visual host attestations. Keep
those constraints boring. Boring is how releases avoid becoming archaeology.

For the current publication identity and unresolved owner-only governance
follow-ups, see [v0.6.0 release note](releases/v0.6.0.md),
[readiness ledger](releases/v0.6.0-readiness.md), and
[GOVERNANCE-TODO.md](GOVERNANCE-TODO.md).
