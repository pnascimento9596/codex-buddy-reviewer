# Provenance and Public Repository Research

The v0.1 through v0.5 implementation is independently written. No third-party source code is included. Public repositories and current OpenAI product contracts informed the architecture and test requirements.

Version 0.3 adds original AI-assisted Byte, Mochi, and Orbit artwork created for this project. Bella and Lupo are V2 packages derived from user-owned companion source artwork. The owner explicitly authorized public redistribution under the repository's Apache-2.0 distribution on 2026-07-19. Package-specific machine-readable records live beside each atlas under `assets/pets/`.

The README workflow infographic at `docs/assets/buddy-review-workflow.png` is original AI-assisted artwork generated specifically for this project on 2026-07-19. It uses no third-party source asset and is distributed under the repository's Apache-2.0 license.

## Pet asset rights records

Every public pet provenance file records a machine-validated rights basis, rights-holder role, authorization source, Apache-2.0 license expression, exact public grant text, and derived atlas SHA-256. The exact grant is:

> The rights holder licenses this asset and its derivative works to the public under the Apache License, Version 2.0.

Byte, Mochi, and Orbit use the `original-project-asset` basis. Their records identify the project owner as the rights-holder role. A separate authorization date was not preserved, so the date is explicitly `null` with status `not-recorded`.

Bella and Lupo use the narrower `source-asset-owner-attestation` basis. The project owner attested on 2026-07-19 that they own each source asset and authorize the packaged asset and its derivatives for public distribution under Apache-2.0. The public record retains only the role, grant, date, and authorization category. It does not retain a personal identity, conversation transcript, credential, or local filesystem path.

Repository history proves that all five packaged atlases were first recorded on 2026-07-18. It does not contain the original source files, selected generation outputs, generation tool identity, or transformation date. Those unavailable facts remain `null` with status `not-recorded`; they are not inferred from the commit timestamp. Each record does pin the checked-in derived `spritesheet.webp` to the same SHA-256 as the public pet catalog.

`src/pet-catalog.mjs` and the deterministic atlas gate enforce the closed record shape and internal consistency for every checked-in available public pet. A changed license grant, inconsistent owner role, missing owner-attestation date, unknown identity or path field, or mismatched derived-asset hash makes the package invalid. The validator cannot prove that an attestation or historical date is true by syntax alone. Checked-in tests separately pin every current unavailable value and the verified first repository record date.

## Closest public product match: Fiora Buddy

- Repository: [fiorastudio/buddy](https://github.com/fiorastudio/buddy)
- Inspected commit: `adcbcbea4b529d3bcfda3a8a7d21e8cf50b43de8`
- Inspected package/release state: `@fiorastudio/buddy@1.0.6` on 2026-07-18
- License observed during inspection: MIT
- Research-only fork: [pnascimento9596/buddy](https://github.com/pnascimento9596/buddy)

This was the closest live GitHub match to the former Claude `/buddy` product: a persistent MCP companion with personality, XP, memory, and host-supplied code feedback. It is legally forkable with its MIT notice, but it is not the right technical base for Buddy Reviewer. Its central `buddy_observe` path reacts to a short summary and optional claims supplied by the same host model; it does not capture a Git delta or call an independent reviewer. Its Codex setup relies on MCP, global instruction injection, and prompt compliance rather than a Stop-grounded review lifecycle.

The pinned default branch built successfully during inspection, but a clean-color local run produced 899 passes and 9 failures out of 908 tests. Its repository has no build/test GitHub Actions workflow at that revision, and the dependency audit reported five high and five moderate advisories in the full tree, including two high and three moderate production advisories. The audit also confirmed that Codex installation is MCP plus direct global hook/instruction mutation, not a native Codex plugin or Stop-grounded reviewer. A user-controlled graph output path reaches a shell-string file opener; this is another concrete reason not to adopt the implementation unchanged. Converting the architecture would require replacing its observer, Codex lifecycle, evidence/privacy boundary, provider model, result grounding, delivery state, installer, and file-opening boundary while retaining a larger SQLite/MCP/onboarding surface. The release decision is therefore to keep this repository independent, keep the public fork only as a research comparison, consider clean-room presentation ideas with attribution, and avoid claiming that Fiora's summary reaction is equivalent to evidence-grounded review.

Useful non-core ideas for later include a `doctor` command, guided setup, local mood/XP presentation, and an opt-in anti-sycophancy reasoning channel. Any personality layer must wrap validated findings rather than alter their severity, path, citation, or technical wording.

## Primary reviewer reference: Sendbird

- Repository: [sendbird/cc-plugin-codex](https://github.com/sendbird/cc-plugin-codex)
- Inspected commit: `84340bb6bc2616f73de8b0287bc5ef7c724acede`
- Inspected release state: `v1.3.0` on 2026-07-17
- License observed during inspection: Apache-2.0

It was the strongest public fork candidate found because it already demonstrated Codex lifecycle hooks, reviewer orchestration, state handling, and a broad test suite. Buddy did not fork it because the desired product required a different core contract: exact private baseline/final trees, provider-neutral Grok/GLM adapters, strict structured results, grounded optional comments, deterministic per-review receipts, fail-open continuation, and excluded-name privacy.

Patterns examined but not copied unchanged included bounded hook input, nested-session suppression, hook wiring, atomic state, hook trust readiness, unread-result delivery, Stop gates, and process orchestration. Buddy's current files are original implementations based on independently derived requirements and official contracts.

## Optional external renderer reference: Clawd on Desk

- Repository: [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)
- Inspected commit: `87907e8446aaa5fa37045d7186026b813c137b73`
- Source license observed during inspection: AGPL-3.0
- Artwork license observed during inspection: all rights reserved; copying/modification/distribution prohibited without permission

Clawd demonstrates a richer always-on Electron overlay, Codex session tracking, animation states, and Codex Pet package import. Its source and artwork are not suitable for incorporation into this Apache-licensed plugin. If richer speech bubbles become worthwhile, the safe architecture is a separately installed adapter that consumes Buddy's sanitized versioned outbox; do not copy Clawd assets or give a renderer access to private snapshots/raw receipts.

## Multi-subscription reviewer comparison: crev

- Repository: [caiokf/crev](https://github.com/caiokf/crev)
- Inspected commit: `e177522546e11c71d37e7826f7cbbc3edd13a0ba`
- Inspected package state: `@caiokf/crev@0.9.0` on 2026-07-19
- License observed during inspection: MIT

crev independently validates the core user need: use existing AI subscriptions to run several reviewer CLIs in parallel. It supports reusable reviewer schemas, many runtimes, normalized JSON output, and optional model-based triage. It is the closest public match found for Buddy's multi-subscription value proposition.

It is not the right fork base for this Codex plugin. Its documented reviewers can read repository files, review output is stored under `.crev/reviews`, its runtime boundary is delegated to a general adapter dependency, and its command lifecycle is a standalone review run. Buddy requires a native Codex hook lifecycle, private baseline and final snapshots, an allowlisted provider packet, canonical pre-egress approval, at-most-once automatic execution, validated transcript continuation, bounded local retention, and native pet composition. Retrofitting those contracts would replace the product core. Buddy therefore remains independently written. No crev or Valet source is included.

## Pet overlay comparison: Claude Pet Companion

- Repository: [zzp1221/claude-code-pet](https://github.com/zzp1221/claude-code-pet)
- Inspected commit: `cbfae6f3d087e00add71a440be65260dd6170017`
- Inspected state: Windows Tauri companion on 2026-07-19
- License observed during inspection: none declared by the GitHub repository

Claude Pet Companion demonstrates a separate Tauri overlay driven by Claude Code hooks, including Codex-format pet imports and richer permission prompts. It targets Claude Code and Windows, not the supported first-party Codex pet contract. The absence of a declared repository license also makes its source and assets unavailable for reuse. Buddy does not copy it. The comparison reinforces the current boundary: keep Codex's native pet first-party, and keep any future richer overlay optional and isolated behind the sanitized renderer protocol.

## Upstream reverse companion

- Repository: [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
- Inspected commit: `db52e28f4d9ded852ab3942cea316258ae4ef346`

This was useful for understanding app-server runtime, read-only sandboxing, provider/auth separation, structured output, and cancellation patterns. No source was copied.

## OpenAI product contracts

The design was checked against current official documentation for Codex hooks, plugins, skills, developer commands, slash commands, and pets. Hook schemas were also checked against the installed Codex desktop engine after the user's application update.

## Attribution policy

Before copying or materially adapting implementation code later:

1. Re-pin the exact source commit.
2. Re-check its license and notices.
3. Record every copied/materially adapted path and commit here.
4. Preserve all required notices.
5. Keep Buddy's stricter consent, privacy, schema, receipt, timeout, and advisory contracts.
