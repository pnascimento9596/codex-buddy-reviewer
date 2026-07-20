# Changelog

All notable changes to Codex Buddy Reviewer are documented here. The project uses release-candidate versions until the exact generated artifact has passed both automated validation and the manual Codex host/visual acceptance contract.

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

### Changed

- Minimum supported Node.js version is now 22.
- Pet discovery and presentation validation are catalog-driven instead of hard-coded to five package IDs.
- Bella and Lupo are now publicly redistributable alongside Byte, Mochi, and Orbit under the repository license, with explicit owner authorization recorded in their provenance files.
- Manual review storage is opt-in, automatic content retention is bounded, new v2 renderer events persist `worker_summary: null`, retained legacy v1 summaries remain default-denied, and workspace data has an explicit status and purge workflow.
- CI now targets Ubuntu and macOS on Node 22, Windows on Node 22, and Ubuntu on Node 24 with immutable action pins.
- Provider execution records privacy-safe capability audit metadata on both successful and failed terminal receipts.
- Worker-summary advisory consent is primary-only. A configured secondary always receives technical evidence only, and changing the secondary cannot widen summary egress.
- OpenCode projects only the selected model provider's auth entry into a disposable deny-all environment and does not forward ambient provider credentials or the remaining auth inventory.

### Security

- Capability settlement never infers success from a dead process or elapsed deadline; ambiguous crashes remain unresolved and can conservatively block later revocation commands.
- Provider-capable Windows execution has no direct-process fallback when containment is requested.
- Secret scanning fails closed when a candidate is too large or cannot be validated as exact UTF-8 text.
- Direct Codex CLI and direct Kimi CLI adapters remain disabled until strict no-tools and no-inherited-context subscription execution can be proven.
- Provider credentials remain owned by existing CLI or OpenCode connections. Buddy does not persist or log credential values, and stale Buddy-owned provider temporary directories are removed through a bounded ownership-checked scavenger.

### Release status

- This is an RC. A final `v0.5.0` tag remains blocked until the generated artifact passes the fresh-task host runbook, including command discovery, hook trust, one-continuation/no-loop behavior, combined visible output, and native pet visual-state observations.
- The final gate also requires exact-head cross-platform CI, the reviewed hash-pinned Windows x64 Job Object helper in the positive artifact, frozen-diff RepoPrompt and independent Grok/Opus reviews, and a fresh completed Deep Security Scan. No fresh scan or real host acceptance is claimed by this entry.
