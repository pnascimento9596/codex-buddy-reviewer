---
name: review
description: Run a fresh, independent, read-only review of the current Git working tree or a branch diff through Grok or GLM. Use after Codex finishes code work, when the user asks for a second engineer or another perspective, or when they explicitly request Grok, GLM, or a buddy review. Do not use this skill to edit code or install automatic hooks.
---

# Independent Buddy Review

Run the plugin's manual reviewer in the foreground and present its validated result as an independent second-engineer opinion.

## Workflow

1. Resolve the plugin root as the directory two levels above this file.
2. Inspect the target repository's Git status and diff summary so the requested scope is understood.
3. Translate the explicit user request into only the documented flags below. Reject unknown or free-text tokens. Invoke the command with every resolved value passed as a separately quoted argument:

   ```bash
   node "<plugin-root>/scripts/buddy-review.mjs" review --cwd "<repo-root>" [documented flags]
   ```

   Never splice raw skill arguments or user text into a shell command.

4. Default to `--provider grok --scope working-tree` unless the user names another provider or scope.
5. For GLM through Ollama Cloud, add `--provider ollama --model glm-5.2:cloud`.
6. For a committed branch review, require an explicit base and add `--scope branch --base <ref>`.
7. Wait for the foreground process to finish. Present its status, summary, and any findings. Keep clear that these are reviewer findings, not independently proven facts.
8. Do not modify the reviewed code unless the user separately asks for fixes.

## Safety Rules

- Never bypass the evidence collector's path policy or send excluded files manually.
- Run only after the user explicitly requests a Buddy, Grok, or GLM review. Patch egress must not be triggered implicitly.
- Never give the external reviewer extra tools, memory, subagents, or write permission.
- A clean `no_findings` result is valid; never demand findings.
- Preserve an `abstain` result when evidence is incomplete or confidence is too low.
- Retain patch evidence in receipts only when the user explicitly requests `--retain-evidence`.
- Do not install hooks, alter Codex configuration, or toggle automatic mode from this manual one-shot skill. Use the separate `buddy-review` control skill when the user requests automatic review.
- Report provider failures exactly. Do not silently switch models or providers.

## Useful Arguments

- `--dry-run --no-store`: inspect sanitized evidence metadata without calling a model.
- `--json`: return the validated result as machine-readable JSON.
- `--confidence <0..1>`: change the publication threshold; default is `0.75`.
- `--max-patch-bytes <n>`: bound the outbound sanitized patch.
- `--timeout-seconds <n>`: set a hard reviewer deadline.
- `--no-store`: avoid writing a local receipt.

Read [references/review-contract.md](references/review-contract.md) when explaining the result contract, privacy behavior, or provider boundary.
