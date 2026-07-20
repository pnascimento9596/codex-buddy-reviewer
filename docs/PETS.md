# Pets and Customization

## Recommended v0.5 setup

Use Codex's native floating pet as Buddy's persistent animated presence:

1. Install a packaged companion, for example `node scripts/buddy-review.mjs pet install buddy-byte`.
2. Open Codex Settings → Pets, select **Refresh**, and choose the appearance.
3. Run `/pet` once to wake it.
4. Run the `buddy-review` command-menu skill to toggle the review behavior.

The host persists pet selection, position, size, and open state. During the task, the native pet derives animation from Codex task status: active review remains Running; completed unread output becomes Ready.

With one or two configured reviewers, Buddy publishes local `review_started` events for each executable provider/model lane and one `review_completed` event containing ordered attributed outcomes. A partial result keeps the failed or open lane visible instead of substituting a provider. The companion mood and XP derive from the durable aggregate completion, not from a claim that every reviewer succeeded.

## Supported boundary

The plugin cannot currently:

- wake/tuck the native pet;
- select or resize it;
- force a specific animation;
- add new semantic animation-state names;
- push arbitrary pet speech bubbles or tray messages.

Those actions are private host behavior, not public plugin APIs. Buddy will not patch the app bundle, call private Electron IPC, or use UI automation as a product dependency.

## Packaged companions

The repository contains five hash-pinned V2 packages. The positive public release artifact contains all five:

| Name | Package ID | Scope | Character |
|---|---|---|---|
| Byte | `buddy-byte` | public | curious robot engineer |
| Mochi | `buddy-mochi` | public | warm cream-and-orange cat |
| Orbit | `buddy-orbit` | public | small floating alien |
| Bella | `buddy-bella` | public | tan-and-white dog |
| Lupo | `buddy-lupo` | public | white speckled dog |

`public` means the original project artwork is cleared for redistribution in the generated public artifact under the repository's Apache-2.0 distribution. Bella and Lupo received explicit owner authorization for public redistribution on 2026-07-19. The catalog and installer are content-driven rather than hard-coded to these five IDs; scope and redistribution remain enforced as packaging and provenance contracts.

```bash
node scripts/buddy-review.mjs pet list
node scripts/buddy-review.mjs pet status
node scripts/buddy-review.mjs pet install buddy-bella
node scripts/buddy-review.mjs pet update buddy-bella
node scripts/buddy-review.mjs pet remove buddy-bella
node scripts/buddy-review.mjs pet restore <backup-id>
node scripts/buddy-review.mjs pet reconcile
```

Installation does not select, wake, resize, animate, or speak through the native pet. Those remain explicit host/user actions. Ownership registries are isolated by canonical physical Codex home, so two genuinely separate homes remain independent while symlink aliases to the same home share one lock and ownership record.

Install/update/remove/restore are journaled as immutable intent, filesystem, registry, and completion steps. A later explicit `pet reconcile` converges exact known states; ambiguous external changes become `needs_attention` and are never overwritten. Update publishes the new hash-pinned package and keeps an exact recoverable backup. Private JSON files and their parent directories are synced on POSIX after publication; cross-platform power-loss semantics and same-user ancestor-swap races remain explicit limits.

## Local companion presentation

Buddy's transcript/outbox presentation is separate from Codex's host pet selection:

```bash
node scripts/buddy-review.mjs presentation status --cwd "/path/to/repository"
node scripts/buddy-review.mjs presentation set \
  --cwd "/path/to/repository" \
  --pet-id buddy-bella \
  --personality warm
```

Available personalities are `precise`, `warm`, and `wry`. Mood is deterministically derived from `idle`, `working`, `reviewing`, `success`, `findings`, `abstain`, or `error`. Utterances are static bounded strings selected from personality/state/review-key, not model-generated text. Each unique durable completed review earns exactly 10 XP whether it returns findings, no findings, or a defensible abstention. Replays are deduplicated by review key, and failures earn no completion XP. These cosmetics never alter review mode, findings, confidence, severity, or provider egress.

## Current V2 sprite contract

For the updated desktop runtime inspected on 2026-07-17, a V2 custom pet uses:

- an 8-column × 11-row sprite sheet;
- exact dimensions 1536 × 2288;
- PNG or WebP;
- `spriteVersionNumber: 2` in `pet.json`;
- a sprite path that remains within the pet directory.

Rows map to fixed host states:

| Row | State | Frames used |
|---:|---|---:|
| 0 | idle | 0–5 |
| 1 | running right | 0–7 |
| 2 | running left | 0–7 |
| 3 | waving | 0–3 |
| 4 | jumping | 0–4 |
| 5 | failed | 0–7 |
| 6 | waiting | 0–5 |
| 7 | running | 0–5 |
| 8 | review/ready | 0–5 |
| 9–10 | 16 pointer-facing directions | 8 each |

The app-bundled V2 `hatch-pet` contract is authoritative for this desktop build; the older user-installed hatch skill may still describe V1.

## Artwork and QA

Byte, Mochi, and Orbit are original AI-assisted artwork produced for this project rather than copies of the former Claude Code pet. Bella and Lupo preserve their original companion identities while adding the required V2 look rows. All five are cleared for public redistribution under the repository license.

Every checked-in sheet is a lossless transparent WebP with the exact V2 dimensions, validated state occupancy, no transparent RGB residue, and a catalog SHA-256. Direction rows also receive focused continuity and blind-read review. CI validates RIFF/chunk structure, exactly one non-animated VP8/VP8L image bitstream, optional VP8X agreement, exact canvas/grid/cell geometry, and catalog hashes. That structural gate reports `full_pixel_decode: false`; the app-bundled hatch validator and human `/pet` inspection remain the semantic/visual release gates.

## Richer renderer decision

v0.5 intentionally ships no sidecar, GUI process, or network listener. If speech bubbles, finding drill-down, reviewer-specific animations, or delayed background reviews become non-negotiable, a later separately reviewed adapter can consume the versioned outbox protocol. Evidence, consent, provider calls, receipts, and validation must remain in the plugin. See `docs/decisions/0001-no-renderer-sidecar-for-v0.5.md`.
