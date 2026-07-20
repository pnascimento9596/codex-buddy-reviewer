# Privacy

Codex Buddy Reviewer is a local Codex plugin. It has no hosted Buddy service, no telemetry endpoint, and no Buddy account system.

## Credential custody

Buddy does not deliberately persist provider credentials in its configuration, receipts, logs, repository, or release artifact. Authentication stays with the connections you already configured:

- Claude Code for Claude subscriptions or supported Anthropic credentials
- Grok CLI for xAI or SuperGrok access
- Ollama for local or Ollama Cloud models
- OpenCode for selected OAuth or API-backed provider connections, including OpenAI and configured Kimi providers

On supported POSIX hosts, the adapter transiently exposes the minimum authentication environment or selected connection entry needed by the chosen CLI. OpenCode receives only the selected provider entry inside a disposable environment. Grok receives the path to its existing authentication file. A selected CLI may materialize private authentication state inside Buddy's temporary run. New run markers store only the provider, PID, timestamps, random run ID, a short display key, and a full SHA-256 workspace binding. They do not store the raw workspace path. Buddy removes the run after the provider settles. A later provider launch can quarantine and remove an exact marked run after 24 hours only when UID, private modes, marker binding, stable directory identity, and non-live PID checks pass. The provider temporary filesystem must expose a positive nanosecond creation time for stable identity. Buddy fails closed before creating a provider run when that identity is unavailable, and it never falls back to the reuse-prone device-and-inode pair alone. PID reuse or no later Buddy activity can delay cleanup. Legacy v1 markers remain eligible for that POSIX age-based cleanup but are intentionally unattributed and cannot be selected by workspace purge. These values are never valid repository configuration.

## What can leave the machine

External review is disabled until the user enables it for one Git workspace. An authorized reviewer can receive only the final locally screened technical review packet and, when separately consented, a bounded worker-summary advisory packet for the primary reviewer.

The technical packet can include:

- allowlisted relative paths and changed-line metadata
- a bounded patch for complete transmitted paths
- hashes, truncation indicators, and generic incompleteness counts

The design does not intentionally send the original user prompt, excluded path contents, Codex transcripts, provider stderr, credentials, memory, tools, or repository access. Privacy coverage must be current and complete before an approved provider request can be issued. Missing, unstable, incompatible, or over-budget coverage blocks provider contact.

Buddy cannot control service-side logging or retention by Anthropic, xAI, OpenAI, Ollama Cloud, Kimi, or another selected provider. The provider account, connection, and service policy govern data after an authorized request reaches that provider.

## Local operational state

The always-on workflow needs bounded local state for opt-in configuration, crash recovery, at-most-once provider execution, and one safe continuation. This state lives outside the reviewed repository under Codex plugin data or the user-level Buddy data directory. POSIX paths are checked as private user-owned state. The current Node implementation does not verify a user-only Windows DACL for the default or a custom `CODEX_BUDDY_DATA_DIR` or `PLUGIN_DATA` path. Real Windows ACL evidence is a release blocker, not an implied guarantee.

Windows v0.5 RC therefore disables all live reviewer contact. Manual live review, automatic turn hooks, doctor provider checks, live evaluation, and the canonical provider dispatcher fail closed before Buddy creates a turn snapshot, review prompt, provider capability, provider subprocess, or provider temporary run. Read-only status, pet management, configuration, local dry runs, and offline validation remain available. This is an enforced product gate, not documentation-only guidance.

| Data | Default behavior |
|---|---|
| Provider credentials | Never deliberately persisted in Buddy configuration, receipts, logs, source, or release artifacts; selected CLI state can exist transiently in a private temporary run |
| Manual review receipt | Not stored unless `--store` is explicit |
| Raw manual patch | Not stored unless both `--store` and `--retain-evidence` are explicit |
| Worker summary | Preserved in the Codex transcript. New v2 renderer events store null; a still-retained legacy v1 event can contain it and is default-denied by the renderer projection |
| Automatic content receipt | Unobserved content becomes eligible 24 hours after completion; observed content becomes eligible 24 hours after recorded presentation observation; content-free replay protection remains |
| Renderer event content | Eligible for deletion after 24 hours; acknowledgments can shorten but not extend that age threshold |
| Provider temporary state | Removed after a normal supported POSIX run; stale non-live POSIX runs can be removed after the bounded TTL; Windows live runs are disabled and residue from an older build is reported but preserved |
| Workspace mode and connection selection | Stored locally until disabled or explicitly purged with settings |
| Guided setup journal | Unstarted expired plans and terminal journals older than 24 hours are removed opportunistically; unresolved state is preserved for recovery |

Buddy is not a background service. Turn state, automatic receipts, and outbox hard expiry are handled by an eligible lifecycle prune. `renderer prune --apply` handles an acknowledged renderer prefix. Provider startup scavenges exact eligible provider temporary runs, and setup activity prunes only safely classified setup records. Unrelated Buddy commands do not guarantee that another subsystem's eligible files are removed. A workspace with no later eligible activity can retain already-eligible local files. The explicit purge command below is the immediate operator-controlled cleanup path for exact review content and, on POSIX, attributable non-live provider temporary runs. It is not a complete Buddy footprint eraser.

Installed marketplace users can select `/buddy-review` and ask it to show local data status. The direct command below is for a source checkout or an advanced operator already running from the plugin root:

```bash
node scripts/buddy-review.mjs data status --cwd "/path/to/repository"
```

Status reports workspace review and settings bytes, bounded provider temporary counts and bytes grouped by provider, and aggregate setup and pet state that remains outside review-content purge. Provider temporary markers and status do not contain the raw workspace path. The JSON status form is still local diagnostic output because the wider result includes the canonical workspace path plus exact durable private-state paths. Redact it before sharing.

Installed marketplace users can ask `/buddy-review` to disable review and purge the current workspace's Buddy content. The skill resolves its own installed path and asks for the required explicit action. The equivalent direct commands are:

```bash
node scripts/buddy-review.mjs mode disable --cwd "/path/to/repository"
node scripts/buddy-review.mjs data purge --cwd "/path/to/repository" --confirm-purge
```

Workspace reviewer selection, mode, summary consent, pet presentation, and circuit settings are preserved by default. Remove them only with the explicit settings option:

```bash
node scripts/buddy-review.mjs data purge \
  --cwd "/path/to/repository" \
  --confirm-purge \
  --include-settings
```

Purge refuses to run while workspace review mode or a live egress capability is active. It preflights every review-content target before mutation. It removes only exact hashed workspace review content plus attributable provider temporary runs whose recorded PID is not live and whose POSIX ownership proof remains stable. Live runs, other workspaces, malformed or incomplete inventories, legacy unattributed runs, and external provider CLI authentication are preserved. On Windows, an attributed leftover provider run blocks workspace purge because Node does not yet prove the parent DACL and Buddy will not use a marker alone as deletion authority.

Setup plans and journals are shared transaction state. Status inventories their aggregate files and bytes. Purge invokes the existing workspace-aware setup pruner only for expired never-started plans or terminal records beyond retention. Partial, malformed, active, `needs_attention`, or otherwise unresolved rollback evidence is preserved. The shared pet install registry and backups are reported and never removed by review-content purge, even with `--include-settings`.

## Repository and release privacy

Credentials, session material, prompt exports, runtime receipts, local paths, personal contact data, and scan workspaces do not belong in source, fixtures, documentation, Git history, or release artifacts. CI scans complete reachable history, and the positive runtime artifact is scanned again after construction.

Release publication adds a separate bounded complete-history gate. It checks raw path signatures in every reachable blob, personal addresses and receipt content in candidate text blobs, tracked and historical pathnames, commit messages, author and committer names or emails, annotated-tag messages and tagger identity, supplemental signed or merge-tag headers, and ref names. GitHub noreply identities and reserved `.invalid` fixture addresses are accepted. Any other reviewed public contributor address requires an explicit repeated `--allow-email` entry; it is never inferred from local Git configuration. Full history requires a clean, non-shallow repository. Clean CI also runs the exact-index `--tree-only` mode, while ordinary local dirty-tree validation remains usable.

The public source branch begins at one reviewed parentless commit with GitHub noreply author metadata. The former private development history has a private local backup and is not reachable from public refs. Replacing refs in the existing GitHub repository does not prove immediate physical deletion of every unreachable or cached private object. The public branch passes complete-history secret scanning, personal-path and privacy scans, and the publication boundary before visibility changes. The positive release artifact remains a separate independently verified boundary.

Bella and Lupo are approved public project assets. Their publication does not authorize any unrelated personal data or credentials.

## Reporting a privacy issue

Do not include a real credential, private patch, receipt, provider output, or raw `doctor --json` response in a public issue. Use a synthetic reproduction and follow [SECURITY.md](SECURITY.md) for reporting guidance.
