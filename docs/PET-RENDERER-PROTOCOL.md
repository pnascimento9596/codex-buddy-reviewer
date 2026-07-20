# Pet Renderer Protocol

## Status

The producer writes immutable local JSON event files. Event schema v2 adds a workspace-monotonic sequence, companion presentation, and a separately validated summary advisory while preserving the v1 deterministic event-ID contract. New events never persist the worker summary. A headless local pull, acknowledgment, and retention module is available for an optional renderer. No standalone GUI, daemon, network listener, or native-pet control is part of this protocol.

## Producer location and identity

```text
<PLUGIN_DATA>/outbox/<workspace-hash>/<session-hash>/<event-id>.json
<PLUGIN_DATA>/outbox/<workspace-hash>/_protocol/legacy-index.json
<PLUGIN_DATA>/outbox/<workspace-hash>/_protocol/producer.json
```

Workspace, session, and turn values are hashes; raw session IDs and absolute repository paths are not emitted. `event_id` remains SHA-256 over the canonical v1 semantic identity and payload, excluding `occurred_at` and the v2 `sequence`. Retrying the same semantic event therefore returns the same immutable event after an upgrade instead of publishing a v2 duplicate.

Every newly published v2 event receives a positive workspace-scoped sequence while holding the outbox workspace lock. The event file is published before the producer high-water mark advances. Recovery raises a stale high-water mark to the largest observed sequence; gaps are valid and consumers must not infer missing data from a gap alone.

## v1 compatibility and migration

Existing v1 event bytes are never rewritten in place. On first v2 access, Buddy:

1. validates the immutable v1 files;
2. sorts them by `occurred_at`, then `event_id`;
3. records deterministic sequence assignments in `legacy-index.json`;
4. starts v2 allocation after the largest assigned or observed sequence.

If an older producer publishes another v1 file after initial migration, Buddy preserves it and appends a new migration assignment after the current high-water mark. A missing, mismatched, duplicated, symlinked, malformed, or digest-invalid event/index fails closed; the renderer never silently edits or discards it. Aged v1 content is compacted under the same workspace lock by atomically updating the migration index before deleting eligible immutable event files. The producer high-water mark is retained, so a crash cannot reuse an old sequence.

Readers normalize both versions as `{ sequence, event }`. Unknown event schema versions are rejected explicitly.

## Event types and presentation states

Event types:

- `mode_changed`
- `turn_started`
- `turn_finished`
- `review_started`
- `review_completed`
- `review_degraded`

Presentation states:

- `idle`
- `working`
- `reviewing`
- `success`
- `findings`
- `abstain`
- `error`

These are renderer semantics, not direct commands to Codex's native fixed pet animation rows.

## Consumer protocol

Consumer state is separate from producer files:

```text
<PLUGIN_DATA>/renderers/<workspace-hash>/<consumer-id>.json
```

A consumer ID must match `[a-z0-9][a-z0-9._-]{0,63}`. The state records its last acknowledged sequence/event and, when applicable, one pending delivered batch. It never stores repository paths or event contents.

The first headless action set is deliberately narrow:

```text
renderer register --consumer <id>
renderer next --consumer <id> [--limit 1..100] [--include-worker-summary]
renderer ack --consumer <id> --cursor <opaque-token>
renderer status --consumer <id>
renderer unregister --consumer <id>
renderer prune [--dry-run|--apply] [--min-age-hours <n>]
```

`next` does not acknowledge. Before returning a non-empty batch, Buddy atomically records an unpredictable pending cursor. Calling `next` again before `ack` returns the same immutable batch and cursor. `ack` accepts only that exact active consumer cursor, advances monotonically through the delivered event, and clears the pending batch. An unknown, stale, forged, wrong-consumer, or inactive-consumer cursor is rejected.

`unregister` marks the consumer inactive, preserves its last acknowledged sequence and event, clears the pending batch, and permanently invalidates that pending cursor. It also releases the consumer from the active retention quorum. Re-registering keeps the acknowledged watermark but starts with no pending cursor, so the next pull reads afresh after the last acknowledged sequence. Events pruned while the consumer is inactive are not resurrected. Delivery is at least once while a consumer remains registered; consumers must also deduplicate by `event_id`.

## Renderer projection and payload policy

Allowed producer data:

- bounded sanitized headline/detail;
- validated review status/summary;
- validated findings/comments with allowlisted relative paths and line numbers;
- provider/model labels;
- deterministic review key.
- optional closed companion fields: pet ID label, personality, mood, XP, completed-review count, and static utterance;
- optional independently validated summary advisory and exact summary quote/offset metadata.

Forbidden producer data:

- raw user prompt;
- the worker summary in every newly produced v2 event;
- raw patch or excluded path names;
- raw provider stdout/stderr;
- credentials or configuration paths;
- absolute repository path;
- arbitrary tool commands, inputs, or outputs;
- unvalidated model output.

Every newly produced v2 event stores `worker_summary: null`. The `--include-worker-summary` option exists only for bounded local compatibility with a still-retained v1 event created by an older producer. It cannot cause a new event to store the summary. The projection closes and reconstructs every field rather than forwarding arbitrary stored properties. Terminal and bidi controls are escaped again at the adapter boundary.

Consumers must render every string as untrusted text, never HTML or executable content. They cannot inject events, call a provider, alter review mode/evidence, or control the native Codex pet through this protocol.

## Retention and restart behavior

Consumer state is atomically persisted and survives restart. `renderer prune` is a dry run by default. `renderer prune --apply` is the separate acknowledgment-based path. It requires at least one active consumer, deletes only through the minimum acknowledged sequence across all active consumers, and can delete acknowledged v1 or v2 events after the effective minimum age. No active consumer returns `no_active_consumers` and deletes nothing. A requested minimum above 24 hours cannot extend the privacy ceiling. An offline consumer can delay early acknowledgment-based deletion, but it cannot extend content retention beyond the non-extendable 24-hour age threshold. Explicit `unregister` preserves only the acknowledged watermark, clears and invalidates any pending cursor, and releases the consumer from the active retention quorum. Re-registration pulls afresh after that watermark from events that still exist.

Lifecycle hard-expiry pruning removes aged v1 and v2 events even when no consumer is registered. Legacy index compaction happens under the outbox workspace lock and producer high-water state prevents sequence reuse. If a process stops after index publication but before every eligible v1 file is unlinked, a surviving event can be conservatively reindexed at a new higher sequence and redelivered. Consumers already have at-least-once semantics and must deduplicate by `event_id`.

Buddy has no permanent background daemon. Physical deletion occurs on the next lifecycle prune, applied renderer prune, or explicit workspace data purge after content reaches its age threshold.

No app-bundle patching, private Electron IPC, UI automation dependency, host pet wake/selection/animation control, or network-exposed renderer is supported.
