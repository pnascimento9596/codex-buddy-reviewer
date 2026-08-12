# Daily use

This guide covers the published `v0.6.0` Codex plugin. Review mode is
workspace-scoped and disabled until you explicitly enable it. Buddy never
changes providers, models, scopes, or confidence thresholds on its own.

## One-time installation

Use the immutable release tag, not `main`:

```bash
codex plugin marketplace add pnascimento9596/codex-buddy-reviewer --ref v0.6.0
codex plugin add codex-buddy-reviewer@codex-buddy-reviewer --json
codex plugin list --json
```

The installed entry should report:

- plugin: `codex-buddy-reviewer`
- version: `0.6.0`
- marketplace: `codex-buddy-reviewer`
- source type: Git, with the repository `pnascimento9596/codex-buddy-reviewer`

Start a fresh Codex task after installation or upgrade. If Codex asks you to
trust the changed `hooks/hooks.json`, inspect the file and approve it through
the host's normal trust flow. Do not bypass hook trust merely to make a check
green.

## Choose the companion

The companion is a native Codex host feature. Buddy can install the package,
but it cannot select or wake the native pet programmatically.

1. Invoke the namespaced skill and install one package:

   ```text
   $codex-buddy-reviewer:buddy-review pet install buddy-byte
   ```

   Other public IDs are `buddy-mochi`, `buddy-orbit`, `buddy-bella`, and
   `buddy-lupo`.
2. In Codex Settings → Pets, choose **Refresh** and select the installed pet.
3. Run the first-party `/pet` command once.

## Configure a workspace

Use the installed skill for normal operation:

```text
$codex-buddy-reviewer:buddy-review show status
$codex-buddy-reviewer:buddy-review run local doctor checks
```

For a conservative daily configuration, use one explicit Ollama Cloud
reviewer and final-only review. The equivalent direct command from a source
checkout or installed plugin root is:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" mode enable \
  --cwd "/path/to/repository" \
  --provider ollama \
  --model glm-5.2:cloud \
  --no-continuous-review
```

This enables review for that Git workspace without authorizing intermediate
provider calls during the turn. The final Stop hook may make the one exact
review call when the workspace changed. Change the provider or model only by
naming it explicitly.

If you want bounded background review, make that additional egress choice
explicit:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" mode enable \
  --cwd "/path/to/repository" \
  --provider ollama \
  --model glm-5.2:cloud \
  --continuous-review
```

Continuous review can send up to two stable intermediate evidence packets plus
one exact final fallback per configured reviewer during a turn. It is not a
fallback chain. A failed reviewer remains failed; Buddy does not silently
substitute another connection.

A second reviewer is optional and independent:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" mode enable \
  --cwd "/path/to/repository" \
  --provider claude \
  --model claude-opus-4-8 \
  --also-provider ollama \
  --also-model glm-5.2:cloud \
  --no-continuous-review
```

Use only connections that are authenticated through their own normal CLI
flow. Buddy does not accept pasted tokens or copy an auth store into its
configuration.

## A normal work session

1. Start a fresh Codex task after changing plugin or hook versions.
2. Confirm the workspace and mode state:

   ```bash
   node "<plugin-root>/scripts/buddy-review.mjs" mode status \
     --cwd "/path/to/repository"
   ```
3. Work normally. Buddy captures a private Git baseline at prompt submit and
   reviews only changes observed after that baseline.
4. Let the Codex turn reach Stop. Buddy either adopts an exact matching local
   result or performs the exact final fallback. A pending result is reported as
   `Code review and suggestions are in progress.` rather than being invented.
5. Read the compact transcript paragraph for the visible result. Full
   attributed findings and connection outcomes remain in bounded local state.
6. Check local health when diagnosing a problem:

   ```bash
   node "<plugin-root>/scripts/buddy-review.mjs" doctor \
     --cwd "/path/to/repository"
   ```

The default doctor command is read-only and makes no provider call. Add
`--provider-check` only when you explicitly want one bounded health call per
configured reviewer. A health check proves connectivity and strict output
handling, not review quality.

## What leaves the machine

A configured reviewer receives the bounded, privacy-screened technical packet:
allowlisted relative paths, changed-line metadata, bounded patch evidence,
hashes, and generic incompleteness counts. It does not intentionally receive
the original prompt, excluded path names or contents, Codex transcripts, tool
input/output, credentials, memory, or unrestricted repository access.

This is an evidence-grounded reviewer, not an editor. It never applies or
merges a finding. Treat each finding as an allegation until you reproduce it
locally.

## Disable or inspect data

Disable workspace review without deleting settings:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" mode disable \
  --cwd "/path/to/repository"
```

Inspect the bounded local inventory before cleanup:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" data status \
  --cwd "/path/to/repository"
```

Purging is explicit and destructive. Disable review first, then run the
confirmation-gated purge only when you mean to remove this workspace's Buddy
review content. Provider CLI authentication and shared pet packages are not
removed by that purge.

For the update, rollback, retention, and provider/platform runbook, see
[MAINTENANCE.md](MAINTENANCE.md).
