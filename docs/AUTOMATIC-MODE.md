# Automatic Mode

## Activation

Automatic review is opt-in per canonical Git workspace. The supported command-menu workflow is:

```text
/buddy-review
```

Select **Buddy Review** from the menu and send it. Codex inserts the plugin skill mention; the skill runs the allowlisted `mode toggle` command and prints the resulting state. Explicit `enable`, `disable`, and `status` requests are also supported.

This is not a third-party registration in Codex's closed first-party slash-command enum. It is the supported skill-in-command-menu path and should be described that way.

## Lifecycle

### UserPromptSubmit

For an enabled root turn, the hook:

- canonicalizes the repository root;
- captures a stable private baseline tree under one aggregate monotonic capture budget shared by both stability passes;
- opportunistically terminalizes abandoned turn state and prunes eligible turn state, automatic receipts, and v1/v2 outbox content without blocking active turns;
- stores a hash of the prompt, never the prompt text;
- emits a local `turn_started` event;
- adds a small context note telling the worker that Buddy is active.

Subagent/nested events and suppressed reviewer sessions are ignored.

### Stop

For the matching enabled root turn, the hook:

- ignores an existing Stop continuation;
- acquires a unique-claim turn lock before any mutable Stop capture;
- recovers completed delivery state or checks a durable prior-attempt key before recapturing mutable Stop inputs;
- requires the exact matching baseline;
- revokes and cleans the snapshot if mode was disabled, and abstains if the review configuration changed mid-turn;
- captures a stable final tree under the same bounded capture contract;
- computes the deterministic review key and recovers any already-published receipt;
- diffs baseline to final;
- enters the workspace provider lane, checks the exact mode and optional summary-consent revisions under short locks, and checks each configured reviewer circuit;
- writes one durable turn-attempt marker and atomically issues one exact-bound single-use egress capability for every executable configured reviewer, so batch authorization cannot publish only part of the reviewer set;
- releases configuration locks before spending those capabilities and launching one or two ordered reviewer lanes concurrently, while preserving a completed mode/summary mutation as a drain-backed revocation barrier;
- makes exactly one attempt per configured executable reviewer, with no retry, substitution, or provider fallback;
- validates each result independently, including explicit old-side citations for complete deleted files, then combines successful results deterministically without a synthesis model;
- when separately consented, sends the bounded worker-summary packet only to the ordered primary reviewer and validates that advisory independently from the technical result; the secondary remains technical-only;
- writes a terminal receipt and immutable event with ordered, attributed reviewer outcomes, including partial failures or open circuits;
- returns one read-only continuation that preserves the immediately preceding worker summary and adds the independent result.

If the baseline is missing, Buddy abstains. It never reviews the whole worktree as a fallback.

## Attribution language

The evidence is a bounded snapshot-to-snapshot Git delta for the turn window. It includes committed and uncommitted changes visible at Stop and removes unchanged pre-existing dirty content, subject to the current RC completeness limits. The sealed pre-fix RC scan proved that invalid UTF-8 Git pathnames could be omitted while branch or automatic evidence was reported complete. The current implementation captures Git path records as raw bytes and rejects non-round-tripping UTF-8 before provider approval. That remediation has focused coverage and still requires the fresh exact-final scan plus native Linux gate before stable release.

It is not actor telemetry. If a human, formatter, generator, IDE, or another process changes the same working tree during the window, its bytes are indistinguishable. User-facing output must say “changes observed during this turn,” not “changes made by the agent.”

## Synchronous delivery tradeoff

v0.5 runs the reviewer synchronously in Stop because the native Codex pet has no plugin API for arbitrary later notifications. This keeps the task Running and lets the validated review be included in the audited response during the normal host lifecycle.

The tradeoff is latency: the task can remain active up to the provider deadline. Delivery is durable but not magical: Buddy records `prepared`, claims delivery with a random token/lease, records `stdout_written` only from the hook write callback, and records `observed` only when Codex invokes the continued Stop with `stop_hook_active`. A crash after stdout becomes externally visible but before observation remains ambiguous and can cause a later replay to duplicate the continuation. A detached worker is appropriate only when a sidecar or reliable next-turn unread-result delivery is available.

## Configuration

Defaults:

| Setting | Value |
|---|---|
| scope | workspace |
| provider | `ollama` |
| model | `glm-5.2:cloud` |
| effort | `high` |
| secondary reviewer | disabled |
| confidence | `0.75` |
| patch cap | 256 KiB |
| provider timeout | 480 seconds |
| presentation profile | separate local state; `native:selected` / `precise` |
| summary-claim advisory | disabled; separate explicit consent |

Mode state includes a policy version, configuration revision, first consent timestamp, one ordered primary reviewer, and an optional ordered secondary reviewer. Enabling is authorization for bounded allowlisted patch egress to each configured connection after eligible turns. The two descriptors must be complete, and the same provider/model connection cannot occupy both positions. `--also-provider` adds or replaces the secondary connection, with optional `--also-model` and `--also-effort`; `--single-reviewer` clears it. A changed provider gets its adapter default model unless a model is supplied explicitly.

Provider-capable turns are serialized by a provider-lane lease. Under a short mode lock, Buddy writes the attempt marker and atomically issues a durable capability for each executable reviewer, bound to the exact revision, connection configuration, prompt, schema, and deadline. A mode mutation commits its new revision, snapshots active capabilities from the prior revision, releases the lock, and waits for positive settlement before returning. Thus the state can already read disabled while the command is still draining authorized calls, but once the command completes no captured prior-revision capability remains live. Dead PIDs or elapsed deadlines do not count as settlement; ambiguous crashes favor safe unavailability over a false revocation success. Existing private receipts are preserved. Pet ID, personality, mood, and XP are not mode fields and cannot revoke or re-key an in-flight review.

Worker-summary egress uses a separate purpose-specific consent record. It is disabled by default, bound to the exact ordered primary provider/model and its own revision, and included in the deterministic review identity. Under a short consent lock, Buddy constructs and hashes the exact bounded packet and binds it only to the primary capability. A configured secondary receives technical evidence only. A consent disable commits a new revision and drains only capabilities issued under the revoked revision before returning. Changing the primary provider/model makes old summary consent stale and therefore fail closed. Changing only the secondary does not widen summary egress. The advisory has a closed schema and independent validation, but it shares the primary model call with technical review; the guarantee is that advisory fields cannot be promoted into technical findings, not that the model's technical response is mathematically invariant to the optional summary packet.

Example dual-reviewer configuration:

```bash
node scripts/buddy-review.mjs mode enable \
  --cwd "/path/to/repository" \
  --provider claude --model claude-opus-4-8 --effort high \
  --also-provider grok --also-model grok-4.5 --also-effort high
```

Both lanes receive the same bounded technical evidence and run concurrently. The primary and secondary order is stable in receipts, transcript attribution, and renderer events. One successful lane is sufficient for a partial completed review, but the failed lane remains visible and is never replaced. If neither lane succeeds, Buddy emits a degraded result and preserves the worker response.

## Supported connections

| Subscription or connection | Buddy configuration | Boundary |
|---|---|---|
| Claude Max | `--provider claude --model claude-opus-4-8` | direct authenticated Claude Code CLI |
| Grok | `--provider grok --model grok-4.5` | direct authenticated Grok CLI |
| Ollama local | `--provider ollama --model <local-model>` | direct local Ollama CLI |
| Ollama Cloud | `--provider ollama --model <cloud-model>:cloud` | direct authenticated Ollama CLI |
| ChatGPT Pro | `--provider opencode --model openai/<model>` | OpenCode OpenAI OAuth connection |
| Kimi through OpenCode | `--provider opencode --model <configured-kimi-provider>/<model>` | selected OpenCode provider connection only |
| Other configured OpenCode provider | `--provider opencode --model <provider>/<model>` | selected OpenCode provider connection only |

The OpenCode adapter copies only the selected provider entry from the user's OpenCode auth store into a disposable deny-all environment. It does not forward ambient provider secrets or the rest of the auth inventory. Direct Codex CLI and direct Kimi CLI are not supported because strict no-tools and no-inherited-context isolation has not yet been proven for those subscription paths. Claude Max should use the direct Claude adapter; Buddy does not route that subscription through OpenCode.

Effort validation is provider-specific and occurs before persistence, capability spend, or provider dispatch. Claude, Grok, and OpenCode accept `low`, `medium`, `high`, `xhigh`, and `max`. Ollama accepts only `low`, `medium`, and `high`.

## Failure semantics

| Condition | Behavior |
|---|---|
| non-Git workspace | control skill refuses activation |
| mode disabled | hooks no-op |
| nested agent | hooks no-op |
| missing baseline | abstain, no whole-tree fallback |
| unstable capture | fail open, no egress |
| aggregate capture deadline/path/byte/Git/object budget exceeded | durable capture-stage terminal state; no provider call |
| reviewable ignored content changed or could not be bounded | abstain without transmitting its name/content |
| no observed changes | local `no_findings`, no provider call |
| incomplete/excluded evidence | no clean assurance |
| index/worktree representations diverge or an opaque submodule stays dirty | abstain; transmit no patch for that path |
| one of two reviewer lanes fails or has an open circuit | publish the successful lane with attributed partial status; no retry or fallback |
| every configured reviewer lane fails or is unavailable | degraded receipt/event; preserve worker result |
| validated review succeeds but disposable-state cleanup fails | preserve the review and emit only the bounded `temporary_state_cleanup_failed` warning; do not expose cleanup paths or errors |
| three consecutive failures for one provider/model | only that reviewer circuit opens for 30 minutes |
| duplicate Stop while delivery has a live claim | no second continuation inside the retry window |
| hook stdout callback fails | do not mark stdout written; durable receipt remains replayable |
| unobserved delivery after retry window | reconstruct continuation from durable receipt, no provider rerun |
| crash after durable attempt, with terminal receipt | recover and replay the original receipt/key |
| crash after durable attempt, without terminal receipt | abstain on retry; never repeat provider attempt |
| unresolved issued/consumed egress capability after an ambiguous crash | later mode/summary mutation times out instead of inferring safe drain from PID death or deadline |
| hook parent is SIGKILLed during a POSIX provider call | IPC-liveness supervisor immediately kills the provider process group; durable attempt still prevents replay |
| Windows verified Job helper unavailable or invalid | fail closed with `isolation_failed`; never retry by directly spawning the provider |
| Stop continuation | mark prepared/claimed/stdout-written delivery observed, then no-op via `stop_hook_active` |
| stale attempt beyond TTL | terminalize `prior_attempt_incomplete`, then prune; never re-authorize provider |
| stale baseline beyond TTL | terminalize `baseline_expired`, then prune private objects |

## Trust and installation

Codex discovers `hooks/hooks.json` at the plugin's default path. The plugin manifest deliberately has no top-level `hooks` field because it is unnecessary and the locally installed validator does not yet accept it. Codex still requires an explicit hook trust review, and any hook-definition change invalidates the previous trust hash.
