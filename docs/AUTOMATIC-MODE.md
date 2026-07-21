# Automatic Mode

## Activation

Automatic review is opt-in per canonical Git workspace. The supported command-menu workflow is:

```text
/buddy-review
```

Select **Buddy Review** from the menu and send it. Codex inserts the plugin skill mention; the skill runs the allowlisted `mode toggle --continuous-review` command and prints the resulting state. This one-step invocation is the explicit authorization for bounded intermediate evidence when the resulting state is ON. A toggle to OFF clears that authorization. Explicit `enable`, `disable`, and `status` requests are also supported.

This is not a third-party registration in Codex's closed first-party slash-command enum. It is the supported skill-in-command-menu path and should be described that way.

Generic raw mode enable and toggle commands remain final-only. Only `--continuous-review` records purpose-specific consent for privacy-filtered intermediate change evidence to reach every configured reviewer. It can spend up to two speculative review calls per reviewer during a turn, plus one exact final fallback call when no matching completed result is available. Final-only mode performs no speculative provider calls. Policy v2 and ambiguous policy v3 records migrate fail-closed to final-only policy v4.

## What a snapshot means

Buddy never reads the screen. Its snapshot is a private Git repository checkpoint produced from `HEAD`, the index, the worktree, and safe untracked content under the bounded privacy contract. It is independent of terminal size, display scaling, open panels, collapsed tool calls, and whether Codex is running in the CLI or desktop app.

The full snapshot digest is an identity and freshness signal. Reviewers do not receive an opaque whole-workspace screenshot or unrestricted repository access. They receive the exact bounded, privacy-filtered diff and grounding evidence constructed between the private baseline and one stable checkpoint.

The evidence describes changes observed during the turn window. It is not actor telemetry. A human, formatter, generator, IDE, or another process changing the same worktree is indistinguishable from the coding agent.

## Lifecycle

### UserPromptSubmit

For an enabled root turn, the hook:

- canonicalizes the repository root;
- captures a stable private baseline tree under one aggregate monotonic capture budget shared by both stability passes;
- opportunistically terminalizes abandoned state and prunes eligible turn state, receipts, and v1/v2 outbox content without blocking active turns;
- stores a hash of the prompt, never the prompt text;
- emits a local `turn_started` event;
- adds a small context note telling the worker that Buddy is active;
- when continuous review is enabled and separately consented, launches one detached bounded worker after the baseline is durable.

Subagent and nested events, suppressed reviewer sessions, and a second launch for the same turn are ignored. The detached payload contains only the canonical working directory, opaque session and turn identity inputs, a random worker nonce, and private data-directory metadata. It does not contain prompt text, tool input, tool output, model responses, transcripts, or credentials.

### Continuous checkpoint worker

The worker uses filesystem mutation notifications as a latency hint and exact Git checkpoint polling as the authority. This matters because Codex currently does not expose every file edit as a portable plugin hook. Correctness does not depend on `PostToolUse`, UI state, or the terminal transcript.

For each eligible stable generation, the worker:

1. waits for the repository to settle and confirms the same exact checkpoint twice;
2. builds bounded evidence from the original baseline to that checkpoint;
3. computes an exact review key from full checkpoint and evidence digests plus the ordered configuration;
4. screens privacy coverage and writes a durable speculative-attempt fence;
5. atomically authorizes the executable reviewer set;
6. runs one or two configured reviewer lanes independently and concurrently;
7. cancels in-flight provider process groups when a newer exact checkpoint supersedes the reviewed generation;
8. writes a full private terminal receipt only after strict result validation.

At most two speculative generations launch per turn. A completed speculative receipt is useful only when its exact key matches the Stop checkpoint. The worker does not keep a persistent provider chat, replay prior conversational context, or carry reviewer memory into another turn.

The detached worker has a strict six-hour absolute lifetime and periodically revalidates the workspace mode while it is idle. Expiry clears idle ownership so the exact Stop path can proceed. If a provider attempt was already fenced, expiry cancels that provider process domain without treating the cancellation as a reviewer-quality failure, and the durable fence still prevents ambiguous replay.

### Stop

For the matching enabled root turn, the hook:

- ignores an existing Stop continuation;
- acquires a unique-claim turn lock before mutable final capture;
- recovers completed delivery state or checks a durable prior-attempt key before recapturing inputs;
- requires the exact matching baseline;
- revokes and cleans the snapshot if mode was disabled, and abstains if review configuration changed mid-turn;
- captures a stable exact final checkpoint and builds the final bounded evidence;
- computes the exact final review key;
- atomically requests the exact final key; if the worker has not fenced a provider attempt, Stop takes over immediately, while an active or durable attempt remains conservative and is never replayed;
- adopts a terminal receipt only when that exact key matches;
- avoids a duplicate provider call while ownership of the exact final attempt is ambiguous;
- otherwise performs the normal exact final review with no retry, substitution, or hidden provider fallback;
- validates each result independently, including old-side citations for complete deleted files;
- combines successful results deterministically without a synthesis model;
- writes a terminal receipt and immutable event with ordered attributed outcomes;
- returns one read-only continuation that preserves the preceding worker summary and appends only the compact Buddy paragraph.

When the final exact result is not ready, the local `turn_finished` event detail is exactly:

```text
Code review and suggestions are in progress.
```

The native Codex pet cannot display arbitrary plugin bubbles. It continues to show host-owned Running and Ready animation. An optional renderer can display the progress event and later completion event.

## Compact visible output

The transcript and `review_completed.detail` use the same deterministic paragraph. It is:

- at most three sentences;
- at most 700 characters;
- single-paragraph and terminal-safe;
- prioritized toward the highest-value validated defect and recommendation;
- able to include one optimization, partial-review warning, cleanup warning, summary note, or defensible no-finding result when space permits.

This compression is a presentation layer, not lossy storage. The private receipt retains the validated structured result, per-reviewer attribution, disagreements, connection failures, grounding, comments, and operational metadata for bounded recovery and local inspection.

## Summary-claim advisory limitation

Worker-summary egress is a separate purpose-specific consent record. It is disabled by default, bound to the exact ordered primary provider/model and its own revision, and included in the final review identity. The secondary reviewer remains technical-only.

The summary does not exist during implementation. If the summary-claim advisory is enabled, Buddy deliberately skips speculative background review for that turn and performs the ordinary exact Stop review so the screened summary packet and technical evidence share one final authorized request. This is an honest latency tradeoff, not a silent fallback. Changing the primary connection makes old summary consent stale and fail closed.

## Configuration

Defaults:

| Setting | Value |
|---|---|
| scope | workspace |
| provider | `ollama` |
| model | `glm-5.2:cloud` |
| effort | `high` |
| secondary reviewer | disabled |
| continuous review | final-only by default; explicit `--continuous-review` consent required |
| speculative generation cap | 2 per turn |
| confidence | `0.75` |
| patch cap | 256 KiB |
| provider timeout | 480 seconds |
| presentation profile | separate local state; `native:selected` / `precise` |
| summary-claim advisory | disabled; separate explicit consent; final-only when enabled |

Example dual-reviewer configuration:

```bash
node scripts/buddy-review.mjs mode enable \
  --cwd "/path/to/repository" \
  --provider claude --model claude-opus-4-8 --effort high \
  --also-provider grok --also-model grok-4.5 --also-effort high \
  --continuous-review
```

Use final-only review when intermediate provider calls are not worth the added egress, latency overlap, or subscription usage:

```bash
node scripts/buddy-review.mjs mode enable \
  --cwd "/path/to/repository" \
  --no-continuous-review
```

Both lanes receive the same exact technical evidence and run concurrently for a given generation. Primary and secondary order is stable in receipts, attribution, and renderer events. One successful lane is sufficient for a partial completed review, while the failed lane remains visible and is never replaced.

## Supported connections

| Subscription or connection | Buddy configuration | Boundary |
|---|---|---|
| Claude Max | `--provider claude --model claude-opus-4-8` | direct authenticated Claude Code CLI |
| Grok or SuperGrok | `--provider grok --model grok-4.5` | direct authenticated Grok CLI; a configured OpenCode xAI route is also possible |
| Ollama local | `--provider ollama --model <local-model>` | direct local Ollama CLI |
| Ollama Cloud | `--provider ollama --model <cloud-model>:cloud` | direct authenticated Ollama CLI |
| ChatGPT Plus or Pro | `--provider opencode --model openai/<model>` | OpenCode ChatGPT OAuth connection |
| Kimi or Moonshot through OpenCode | `--provider opencode --model <configured-moonshot-provider>/<model>` | selected configured OpenCode provider entry only |
| Ollama Cloud through OpenCode | `--provider opencode --model <configured-ollama-provider>/<model>` | selected OpenCode Ollama Cloud connection; direct `ollama` remains available |
| Other configured OpenCode provider | `--provider opencode --model <provider>/<model>` | selected configured OpenCode provider entry only |

The implemented adapter IDs are exactly `claude`, `grok`, `ollama`, and `opencode`. ChatGPT OAuth, Kimi/Moonshot API-backed models, SuperGrok, Ollama Cloud, and other third-party connections can be selected only when their exact provider/model is already configured in OpenCode; they are routed connections, not additional Buddy adapters. Direct Codex CLI and direct Kimi CLI are not supported because their strict no-tools and no-inherited-context boundaries have not been proven. Claude Pro or Max must use Buddy's direct `claude` adapter with Claude Code and must not be routed through OpenCode. OpenCode receives only the selected provider authentication entry inside a disposable deny-all environment. Buddy never asks the user to paste tokens into its configuration.

## Failure semantics

| Condition | Behavior |
|---|---|
| non-Git workspace | control skill refuses activation |
| mode disabled or nested agent | hooks no-op |
| continuous review disabled | final-only Stop review |
| continuous consent missing or invalid | background worker does not contact a provider |
| summary guard enabled | background worker skips; exact Stop review handles the summary packet |
| background launch or watcher unavailable | final Stop path remains available |
| missing baseline | abstain, no whole-tree fallback |
| unstable capture or exceeded capture budget | fail closed for egress |
| newer checkpoint appears during review | cancel the superseded provider process domain; do not publish its findings |
| two speculative generations already launched | stop speculative work; exact final fallback remains available |
| exact completed receipt exists at Stop | adopt it; no provider rerun |
| exact final attempt remains ambiguous | do not duplicate the provider call |
| no observed changes | local `no_findings`, no provider call |
| incomplete or excluded evidence | no clean assurance |
| one reviewer lane fails or has an open circuit | publish the successful lane as attributed partial review |
| every reviewer lane fails | degraded receipt/event; preserve the worker result |
| validated review succeeds but temporary cleanup fails | preserve review and emit bounded cleanup warning |
| duplicate Stop with live delivery claim | no second continuation inside retry window |
| crash with terminal receipt | recover exact receipt and compact presentation |
| crash after durable attempt without receipt | abstain; never repeat that ambiguous attempt |

## Trust and installation

Codex discovers `hooks/hooks.json` at the plugin's default path. The plugin manifest deliberately has no top-level `hooks` field because the locally installed validator does not accept it and discovery does not require it. Codex still requires an explicit hook trust review, and any hook-definition change invalidates the previous trust hash.
