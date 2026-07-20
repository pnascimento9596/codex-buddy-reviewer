# Repository Instructions

This repository is an outbound code-review boundary. Treat privacy, scope attribution, deterministic validation, and controlled failure as product contracts.

## Invariants

- Automatic review remains disabled by default and workspace-scoped; preserve explicit consent, turn-window attribution language, deterministic deduplication, and circuit-breaker behavior.
- Never send excluded path names or contents to a provider.
- Never silently change providers, models, scopes, or confidence thresholds.
- External reviewers remain read-only and receive no shell, write, web, memory, or subagent capability.
- Every published finding must validate against a changed path and a current line range.
- `no_findings` and `abstain` are successful protocol outcomes; never manufacture findings.
- Default receipts omit patch contents and raw provider diagnostics.
- Provider timeouts must terminate the process group.
- Preserve strict structured output and reject unknown properties or terminal controls.
- Never claim exclusive agent authorship from a baseline-to-final worktree delta; say changes were observed during the turn.
- Never use missing-baseline fallback evidence, private desktop IPC, app-bundle patches, or silent provider substitution.

## Changes

Inspect the provider CLI contract before changing arguments. Add adversarial tests for changes to evidence capture, path policy, result validation, subprocess handling, persistence, or invocation consent. Run `npm run check` plus the Codex plugin and skill validators before publishing.
