---
name: buddy-review
description: Toggle, inspect, diagnose, or reversibly set up workspace-scoped automatic independent review after Codex finishes a coding turn; manage Buddy pet packages and presentation choices; or operate the headless renderer. Use when the user selects buddy-review from the command menu or asks about Buddy Review. This skill never directly controls Codex's native pet window.
---

# Buddy Review Control

Translate the user's request into one allowlisted action. With no explicit action, use `toggle` for review mode because `/buddy-review` is intentionally a one-step toggle.

Review-mode actions are `toggle`, `enable`, `disable`, or `status`:

1. Walk upward from this file until you find one directory containing both `.codex-plugin/plugin.json` and `scripts/buddy-review.mjs`; use that directory as the plugin root. Stop if that exact root cannot be found.
2. Resolve the current Git repository root. If the current task is outside Git, explain that automatic code review needs a Git workspace and stop.
3. Run exactly this command, passing every value as a separately quoted argument:

   ```bash
   node "<plugin-root>/scripts/buddy-review.mjs" mode <action> --cwd "<repo-root>"
   ```

   When the user explicitly requests reviewer configuration, append only the documented flags under **Supported optional configuration** as separate quoted arguments before running the command.

4. Report the resulting ON/OFF state, ordered primary and optional secondary provider/model connections, workspace scope, and that enabling authorizes bounded allowlisted patch egress to each configured connection after eligible turns. Explain that two lanes run concurrently, one success produces an attributed partial result, and Buddy never retries or falls back to an unconfigured provider.
5. For the animated companion, tell the user to run the first-party `/pet` command once and choose a built-in or installed Buddy pet in Codex Settings. The host persists its open state, selection, position, and animation surface.

Pet actions are `pets`/`pet list`, `pet status`, `pet install <buddy-pet-id>`, `pet update <buddy-pet-id>`, `pet remove <buddy-pet-id>`, `pet restore <backup-id>`, or `pet reconcile`. Run exactly:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" pet <action> [identifier]
```

For install/update/remove, only accept pet IDs printed by `pet list`. For restore, only accept a backup ID printed by a prior `pet remove` result or `pet status`; never synthesize a path or identifier. Every pet mutation and reconciliation must be an explicit user request. Report the command result and the native-host step honestly: Settings → Pets → Refresh, select the appearance, then enter `/pet` once. Buddy cannot select or wake it programmatically.

Presentation actions are `presentation status` or `presentation set`. `set` requires at least one closed value:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" presentation set \
  [--pet-id <native:selected|id-printed-by-pet-list>] \
  [--personality <precise|warm|wry>] \
  --cwd "<repo-root>"
```

Presentation is local and cosmetic. It does not select the native host pet, change review authorization, increment review-mode revision, alter findings, or cause provider egress. Mood is derived from review state. XP grants exactly 10 points per unique durable completed review, regardless of findings, no-findings, or defensible abstention; failures earn no completion credit.

The worker-summary claim advisory is disabled by default and has a distinct egress consent. Status or disable may be run directly. Enable only after the user explicitly asks to send the bounded final worker summary to the current primary provider, and always include the confirmation flag:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" summary-guard status --cwd "<repo-root>"
node "<plugin-root>/scripts/buddy-review.mjs" summary-guard enable \
  --cwd "<repo-root>" --confirm-summary-egress
node "<plugin-root>/scripts/buddy-review.mjs" summary-guard disable --cwd "<repo-root>"
```

The advisory shares the primary review call, is separately labeled, and its closed fields can never be promoted into a code finding. A secondary reviewer always receives technical evidence only. Changing the primary provider/model makes prior summary consent stale and fail closed; changing only the secondary does not widen summary egress. Do not claim that the optional packet cannot influence the primary model's technical output; the guarantee is structural separation plus independent validation. Do not describe it as hidden chain-of-thought, reasoning extraction, or transcript access.

Diagnostics are read-only and make no provider call by default:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" doctor --cwd "<repo-root>"
```

Only add `--provider-check` after explicit user authorization for one bounded network/model health call per configured reviewer, with a maximum of two calls. The checks run concurrently, send no repository evidence, and return exact per-role pass/fail plus aggregate pass, warn, or fail status. A partial result is `warn`; no connection is substituted. This tests connectivity and strict one-field output handling, not review quality. Doctor cannot prove host hook trust, command-menu discovery, native pet selection, or visual Running/Ready animation.

Guided setup is a deliberate plan/apply workflow:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" setup plan --cwd "<repo-root>" [closed options]
node "<plugin-root>/scripts/buddy-review.mjs" setup apply --cwd "<repo-root>" \
  --plan-id "<exact-id>" --plan-digest "<exact-sha256>"
node "<plugin-root>/scripts/buddy-review.mjs" setup rollback --cwd "<repo-root>" \
  --plan-id "<exact-id>" --plan-digest "<exact-sha256>"
```

Always show the plan before apply. Apply and rollback require explicit user requests and the exact generated ID/digest. Never invent either value. Setup installs or updates a hash-pinned pet first and enables review last; rollback restores mode first and the pet second. Its immutable receipts resume recognized process-crash states, including the update-rollback midpoint, while refusing unexpected hashes, ownership, backups, or revisions. It never modifies global `AGENTS.md`, trusts hooks, selects a host pet, or wakes `/pet`.

Workspace data actions are `data status` and `data purge`. Status is read-only:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" data status --cwd "<repo-root>"
```

Purge is an explicit destructive action. Run it only when the user asks to purge Buddy-owned local data for the exact current Git workspace. First disable automatic review for that workspace, then run:

```bash
node "<plugin-root>/scripts/buddy-review.mjs" data purge \
  --cwd "<repo-root>" --confirm-purge
```

Pass `--include-settings` only when the user explicitly asks to remove the workspace's Buddy mode, connection, presentation, summary-consent, and circuit settings too. Purge refuses while review mode is enabled or an egress capability is live. It must never delete provider CLI authentication, arbitrary plugin data, another workspace's data, or any path supplied by the user.

Headless renderer actions are `renderer register`, `next`, `ack`, `status`, `unregister`, and `prune`. Pass only documented closed flags from `renderer --help`. Register, unregister, and ack change local renderer state. Bare `renderer prune` is read-only; only `renderer prune --apply` deletes. New events never persist worker summaries. `--include-worker-summary` can expose only a still-retained legacy v1 summary and requires an explicit user request. Apply deletes eligible v1 or v2 events only through the minimum acknowledged sequence of every active consumer and after the effective minimum age. No active consumer means nothing is eligible. The requested minimum age can shorten retention but cannot extend the 24-hour privacy ceiling. Run the dry run first unless the user explicitly asks for immediate apply. Lifecycle pruning hard-expires aged v1 and v2 content even without a registered renderer and compacts the legacy v1 index under the outbox lock.

## Supported optional configuration

Only pass these flags when the user explicitly requests them:

- `--provider grok --model grok-4.5`
- `--provider ollama --model glm-5.2:cloud`
- `--provider claude --model claude-opus-4-8`
- `--provider opencode --model openai/gpt-5.6`
- `--also-provider <grok|ollama|claude|opencode>` with optional `--also-model <id>` and `--also-effort <level>`
- `--single-reviewer` to clear the configured secondary connection
- `--effort <level>`
- `--confidence <0..1>`
- `--max-patch-bytes <integer>`
- `--timeout-seconds <1..480>`

The supported adapter IDs are exactly `claude`, `grok`, `ollama`, and `opencode`. Claude Max uses the direct Claude adapter. Grok and Ollama local/Cloud use their direct adapters. ChatGPT Pro uses `opencode` with an OpenCode OpenAI OAuth connection. Kimi is allowed only through `opencode` with the exact `provider/model` identifier already configured in the user's OpenCode connection. Direct `codex` and direct `kimi` adapters are unsupported because strict no-tools and no-inherited-context isolation has not been proven for those subscription routes. OpenCode projects only the selected provider auth entry; never copy, print, or request the user's auth store or ambient credentials.

Claude, Grok, and OpenCode accept effort values `low`, `medium`, `high`, `xhigh`, and `max`. Ollama accepts only `low`, `medium`, and `high`. Reject an unsupported provider/effort combination rather than changing it or contacting the model.

Never interpolate unvalidated free-form text into the command. Provider and model values must come from the closed adapter choices above or an explicit user-supplied OpenCode `provider/model` token accepted by the CLI. Reject unknown actions or flags. `--also-provider`, `--also-model`, and `--also-effort` must describe one complete secondary reviewer and cannot be combined with `--single-reviewer`. Do not modify Codex configuration, arbitrary pet files, global instruction files, or the reviewed repository. Pet-file writes are allowed only through the catalog/setup CLI above, only after an explicit request, and only for allowlisted `buddy-*` packages and private registry/backups.

## Product boundary

The command-menu entry is a skill invocation selected by typing `/buddy-review`; it is not a third-party native slash-command registration. The plugin cannot programmatically wake, select, or make the native pet speak. Review text is delivered through the audited Codex task transcript, while the native pet supplies persistent animation and task-state signaling.
