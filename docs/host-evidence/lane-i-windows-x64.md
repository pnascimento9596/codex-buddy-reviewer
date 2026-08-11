# Lane I Phase 5 — Windows x64 evidence record

Evidence class: **machine-captured, human-unreviewed**.

## Scope and result

Phase 5 used disposable, branch-only GitHub Actions workflows on hosted `windows-latest` x64 runners. The workflow was deliberately never merged into `main`: it downloads an LLM and exists only to establish host viability, while `.github/workflows/` is itself on the reviewed publication surface.

**Disposition: UNRUN with settling evidence.** Windows x64 live provider egress through the Buddy CLI did not complete within the bounded viability exercise. The RC therefore relies on protected Windows unit/integration evidence and the explicit residual statement below; it does not claim live Windows provider execution.

> Windows x64 live egress and DACL private-state evidence through a local model remains UNRUN. Codex-on-Windows host integration also remains UNRUN. Protected Windows x64 CI proves the packaged helper and private-state controls; the branch-only viability runs settled the remaining local-model execution gap without credentials or provider-data egress.

## Protected source identity

- Protected-main source under test: `d8228facae2eb48bb3df6f4256cf445c6341282d`.
- Source tree: `1a995b50eeb2df2637fb2b90b1cbe4211c734af6`.
- Phase 4 protected-main validation: run `31363656621`, success at that exact source.
- Packaged Windows x64 helper SHA-256: `22884692f20edb592d57cb3ea00d03dfa857bfe148a9625c986916fa83110fe1` (bound by `native/windows/helpers.json` and checked in every viability workflow before provider setup).
- Windows ARM64 remains blocked because no reviewed `win32-arm64` helper is packaged.

## Branch-only viability attempts

Each branch had one commit whose only changed path was `.github/workflows/lane-i-phase5-windows-evidence.yml`; each workflow asserted its event SHA, clean checkout, single-parent relationship to protected main, parent tree, helper manifest/hash, and tree-only publication boundary. No branch opened a PR or merged.

| Attempt | Run | Evidence commit | Settling result |
|---|---:|---|---|
| v1 | `31364790858` | `5676f86` | NOT_PROVEN before inference: doctor rejected `--timeout-seconds 180`; documented CLI maximum is 120. |
| v2 | `31365838681` | `11746d9` | NOT_PROVEN before inference: provider doctor returned `transport_exit` in 701 ms. Artifact preserved the typed failure. |
| v3 | `31366346234` | `73e615b` | Diagnostic harness failed before inference because PowerShell reserves `<`; no product conclusion. |
| v4 | `31366571859` | `c37fa07` | Diagnostic probe captured the Windows standalone-CLI failure: `Error: could not locate ollama app` in 115 ms. The independently started server was healthy and served `/api/version` and `/api/tags`; local `qwen3:0.6b` pulled with digest `7df6b6e0…`. |
| v5 | `31367108470` | `ee7cbe8` | Timed out after the explicit 45-minute job bound while the pinned official installer-layout step remained active; provider probe/review never started and no artifact was produced. |

The v4 diagnosis was source-settled against Ollama `v0.32.6`: Windows `ollama run` performs a heartbeat/start-app preflight and the standalone archive lacks `ollama app.exe`. The final pinned official-installer-layout attempt used `OllamaSetup.exe` SHA-256 `526e47db7c295d017e9514df5bb20c6f32b3d1170f2c8bb9c59b53185f5bd6ff`; it did not complete within the 45-minute bound. This settles local-model CLI viability as unavailable under the bounded hosted-runner exercise; no further workflow variants were attempted.

No reviewer credential was placed in Actions. The model was local-only (`OLLAMA_NO_CLOUD=1`, loopback `OLLAMA_HOST`) and the small-model quality was not treated as a product gate.

## Evidence actually obtained

- Native GitHub-hosted Windows x64 runner execution.
- Packaged helper hash/manifest binding before provider setup.
- Tree-only publication-boundary pass against the exact protected-main parent.
- Pinned Codex CLI installation and host-version probe.
- Pinned Ollama bytes and local model pull on the standalone-layout attempts.
- Healthy loopback Ollama server and exact local model digest on v4.
- Typed fail-closed provider-doctor outcome (`transport_exit`) rather than provider substitution or fabricated findings.
- Sanitized NOT_PROVEN artifacts uploaded before failure where the workflow reached the evidence step.

## Residual and release effect

The existing protected Windows matrix remains the authoritative DACL/private-state evidence: packaged-byte protocol checks, fresh root ensure/verify, junction leaf and ancestor refusal, wrong-owner refusal, schema-v1 proof rejection, assured-path verification, kill-switch issuance/executor blocks, provider-temp platform-integrity classification without provider-circuit charge, and multi-root purge/tombstone behavior. Phase 5 did not independently turn those protected tests into a live Codex host claim.

Under the owner brief’s Phase 5e fallback, this limitation does not block `v0.6.0-rc.1`. It must remain visible in the RC note, readiness ledger, current-state report, and Lane J promotion criteria.

## Lane J bounded recheck

Lane J used the two authorized branch-only attempts `31510839580` and `31511573245` as the final Windows live-egress experiment. Both failed before provider setup: the first exposed a null PowerShell clean-status probe, and the second exposed a branch-parent assertion in the retry workflow. Both therefore recorded zero doctor calls, zero live turns, and zero provider inferences. The result is **NOT OBSERVED**, not a provider failure and not live-host proof.

The terminating fallback is explicit opt-in through `CODEX_BUDDY_WINDOWS_EGRESS_ENABLE=1`. The default remains disabled after private-state verification, and `CODEX_BUDDY_WINDOWS_EGRESS_BLOCK=1` remains an unconditional kill switch. No third Windows attempt was made.
