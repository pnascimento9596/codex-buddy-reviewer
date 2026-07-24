# Claude Code host port (v0.5.x design)

Status: implemented in source for hook input normalization and runtime path
resolution. Full Claude Code interactive host observation remains manual.

## Host detection

| Signal | Host |
|---|---|
| `PLUGIN_ROOT` / `PLUGIN_DATA` | Codex |
| `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` | Claude Code |
| Payload has `prompt_id` and no `turn_id` | Claude Code |

`hooks/hooks.json` expands `${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}` so one
manifest works for both hosts.

## Turn identity

Codex supplies `session_id` + `turn_id`. Review keys hash opaque forms of both.

Claude Code common hook fields include `session_id` and (v2.1.196+) `prompt_id`,
not `turn_id`. Buddy normalizes:

```text
turn_id = "claude:" + prompt_id
```

UserPromptSubmit and Stop for the same prompt share `prompt_id`, so the turn
key is exact and collision-safe across the turn. Missing `prompt_id` fails
closed (no invented cross-event identity).

## State root

Runtime state uses `PLUGIN_DATA` or `CLAUDE_PLUGIN_DATA` only. Never under the
reviewed repository. Mode and pets still use the Codex-home Buddy data dir when
the CLI is invoked outside a plugin context.

## Stop continuation

Codex and Claude both accept top-level:

```json
{ "decision": "block", "reason": "..." }
```

for Stop continuation feedback. Buddy keeps that envelope. Claude also accepts
`systemMessage` and `hookSpecificOutput.additionalContext` for non-blocking
messages; fail-open paths already use `systemMessage`.

## Skills and pets

The Buddy skill remains Codex-oriented (`/buddy-review`). On Claude Code the
plugin skill is namespaced (`/codex-buddy-reviewer:buddy-review`). There is no
pet surface on Claude Code; pet install commands no-op or document host limits.

## Reviewer independence

When the configured reviewer uses the same model family as the implementing
host (Claude Code host + `claude` adapter), docs should warn that independence
is reduced. Default recommendation: use Ollama, Grok, or OpenCode as the
reviewer when the implementer is Claude Code.

## Reviewer recursion

Buddy-in-Claude-Code with the `claude` adapter as reviewer is allowed with a
warning, not a hard block. The privacy gate and structured schema still apply.
Operators who need independence should choose a non-Claude reviewer seat.

## Manual host checklist (unverified here)

1. Install plugin via Claude marketplace or `--plugin-dir`.
2. Confirm `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` are set for hook
   processes.
3. Trust hooks when prompted.
4. Enable mode for a disposable Git workspace.
5. Run a turn that changes files; observe UserPromptSubmit baseline context.
6. Observe one Stop continuation with Buddy `decision: block` reason text.
7. Confirm no second Stop loop.
8. Confirm state files land under `CLAUDE_PLUGIN_DATA`, not the repo.
