# ADR 0001: Keep v0.5 renderer delivery headless and local

- Status: accepted
- Date: 2026-07-18

## Decision

Version 0.5 will not ship a separate GUI renderer, speech-bubble process, local
HTTP server, or network listener. The first-party Codex pet remains the
always-on animated status surface. Review findings, engineering comments, and
the preserved worker summary remain in the task transcript.

The existing renderer protocol is the supported extension boundary. It is a
workspace-scoped, private-filesystem pull/ack protocol with explicit consumer
registration, opaque cursors, immutable events, conservative retention, and
worker-summary delivery disabled by default. Nothing is pushed into an
untrusted process, and no port is opened.

## Rationale

A sidecar would add installation, signing, auto-update, accessibility,
window-management, crash-recovery, and same-user IPC attack surfaces without
improving review correctness. The native pet already supplies persistence,
animation, task-state transitions, wake/tuck behavior, and navigation. The
auditable Codex transcript is a better home for code-review detail than a
transient speech bubble.

## Reconsideration gate

Reconsider a sidecar only when host acceptance is complete and real usage shows
that transcript navigation is insufficient. Any future implementation must:

- consume the existing pull/ack protocol rather than read arbitrary Buddy state;
- open no network listener and make no network request;
- keep worker summaries opt-in and findings terminal-safe;
- ship as a separately signed, sandboxed, reversible component;
- preserve the native pet and transcript as the fully supported baseline;
- include accessibility, multi-display, crash, update, and uninstall tests.

Until those gates are met, the renderer protocol is intentionally an extension
contract, not a promise that a GUI sidecar will be shipped.
