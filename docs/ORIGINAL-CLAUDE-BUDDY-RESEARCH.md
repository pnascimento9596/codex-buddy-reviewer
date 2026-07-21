# Original Claude Code Buddy Research

## Purpose

Codex Buddy Reviewer is inspired by the feel of Claude Code's short-lived `/buddy` companion, not by its implementation or artwork. This note records the public behavior study used to separate historical fact from assumptions and to define a clean-room product boundary.

## Correct feature window

The native terminal companion was available for roughly April 1 through April 8, 2026, not May. Public issue evidence shows `/buddy` working in Claude Code 2.1.90 on April 2. Another report says it worked in 2.1.96 and was absent in 2.1.97 on April 8.

Primary references:

- [Anthropic issue 42677, terminal Buddy working in 2.1.90](https://github.com/anthropics/claude-code/issues/42677)
- [Anthropic issue 45517, present in 2.1.96 and missing in 2.1.97](https://github.com/anthropics/claude-code/issues/45517)
- [Claude Code 2.1.89 public npm artifact](https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.89.tgz)
- [Claude Code 2.1.96 public npm artifact](https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.96.tgz)
- [Claude Code 2.1.97 public npm artifact](https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.97.tgz)

Someone who remembers using it in May may have retained an older installed CLI. The public evidence does not support a native May release window.

## What the original did

Clean-room inspection of the public npm artifacts supports this behavioral summary:

- The pet rendered in the terminal. The desktop app did not expose the same display, according to the April 2 issue.
- A separate companion reaction request started after the main Claude stream completed. It was not a continuous code reviewer running alongside implementation.
- The request used a small bounded digest: up to 12 recent user or assistant messages at 300 characters each, up to 1,000 characters of recent tool-result text, a 5,000-character transcript ceiling, and up to three prior reactions at 200 characters each. It did not inspect the user's screen.
- Normal reactions used a 30-second cooldown. Named address, test failures, error-like output, nonzero execution, and a diff over roughly 80 changed lines could bypass that cooldown.
- The reaction request was asynchronous, not awaited by the main turn, and bounded by roughly 10 seconds. The companion UI could therefore react after the main response without blocking the entire coding turn.
- The terminal renderer advanced animation on a roughly 500-millisecond tick, displayed a reaction for about 10 seconds, faded it during the last three seconds, and used a very short compact-text projection. These are presentation timings, not evidence of continuous model review.
- The speech bubble was UI-side rather than automatically injected back into Claude's context. Users had to copy a reaction into the conversation if they wanted the main agent to investigate it. [Anthropic issue 44898 documents that boundary](https://github.com/anthropics/claude-code/issues/44898).
- The local artifacts do not prove which server-side model generated a reaction. Model attribution claims should therefore remain `unknown` unless Anthropic publishes an authoritative statement.

This explains the original feature's speed and charm, but it also corrects a common assumption: the companion did not continuously examine exact repository state and did not provide an independently validated code-review receipt.

## Public replacement inspected

The community project [1270011/claude-buddy](https://github.com/1270011/claude-buddy) recreates a persistent companion after the native feature disappeared. Its architecture is useful evidence that developers value the interaction, but it is not the review kernel used here. Its companion comments are produced through the main Claude workflow and it retains companion memory, while Codex Buddy Reviewer requires independent provider lanes, exact Git evidence, no cross-session reviewer memory, and bounded local receipts.

The replacement is MIT licensed, but this repository does not need to copy its prompts, code, names, or assets to implement the independent-review design.

## Clean-room boundary

This project may reproduce public behavior concepts such as a persistent companion, bounded reactions, progress state, and concise comments. It must not copy:

- Anthropic's minified source code;
- private or reconstructed prompt text;
- proprietary sprite sheets or character assets;
- internal endpoint implementations;
- implementation-specific randomization or animation tables.

Byte, Mochi, Orbit, Bella, and Lupo are project assets with their own documented provenance and redistribution permission.

## Design decision for Codex Buddy Reviewer

The best parts to preserve are immediacy, an always-available companion, and a short useful comment after the main agent finishes. The review architecture should be stronger than the historical reaction system:

1. Capture exact private Git checkpoints, never screenshots or visible UI state.
2. Let one or two independent reviewer connections see the same privacy-filtered evidence.
3. Review at most two stable generations while implementation continues.
4. At Stop, adopt only a receipt whose full checkpoint and evidence identity exactly matches the final state.
5. If the exact review is pending, publish `Code review and suggestions are in progress.` through the transcript/outbox boundary.
6. Present at most three sentences and 700 characters while retaining full validated detail in the private local receipt.
7. Keep provider invocations fresh and isolated, with no persistent reviewer chat or cross-session memory.

This achieves the intended speed without making correctness depend on terminal layout, hidden activity rows, or whatever happens to be visible on screen.
