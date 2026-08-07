# 0002. Windows current-user-only DACL private-state epic (v0.6)

- Status: proposed
- Date: 2026-08-07
- Lane: lane-g Phase 5 (design only; zero provider calls)
- Supersedes: none (implements the deferred gate already named in
  `src/provider-egress-platform.mjs` and stable-readiness)

## Context

v0.5.0 ships fail-closed Windows live provider egress:

```js
WINDOWS_PROVIDER_EGRESS_FAILURE_CODE = 'windows_private_state_acl_unavailable'
```

POSIX private state uses UID + mode (`0700` dirs, `0600` files) with
realpath / non-symlink checks. Node on Windows does not expose a dependable
owner-SID or effective-DACL verification API that matches the product bar, so
the platform gate refuses live review rather than claiming protection it cannot
prove.

A packaged `win32-x64` Job Object helper is already verified in-artifact
(`bin/win32-x64/buddy-job-supervisor.exe`, `native/windows/helpers.json`
status `verified`). ARM64 remains `unavailable`. That helper is the natural
extension surface for create/verify of current-user-only DACLs.

## Decision

### Private-state roots that need current-user-only DACL create + verify

Every durable and temporary root that can hold review content, capabilities,
provider auth material, or turn snapshots — and every ancestor that must not
be attacker-swappable under the same user — must be created and re-verified:

| Root class | Resolver / producer | Notes |
|---|---|---|
| Durable mode/data root | `resolveDataDir` (`CODEX_BUDDY_DATA_DIR` or default under home) | mode, presentation, summary-guard, egress registry, rejected responses, optional co-located automatic roots |
| Runtime / PLUGIN_DATA root | `resolveRuntimeDataDir` (`PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA`) | automatic-reviews, outbox, turns, circuits |
| Manual review store | `store.mjs` under data dir | temp dir `0700` then rename |
| Provider temporary parent | `providerTempParent(os.tmpdir())` → `…/codex-buddy-provider-temp-<userKey>` | v2 markers; Windows path currently records `windows_acl_unverified` |
| Provider temporary run dirs | children of the parent | may hold selected OpenCode auth entries transiently |
| Atomic write temp inodes | `writePrivateJsonAtomic` / exclusive writers in `state.mjs` | mode temp **before** rename (already required to avoid chmod-after-rename races) |
| File-lock / lease paths | `withFileLock` siblings under the same roots | must inherit verified parent DACLs |
| Packaged helper path | `bin/win32-x64/buddy-job-supervisor.exe` | integrity pin already; not private state but trusted TCB for DACL ops |

Ancestor chain: from each root up to (but not including) a reviewed trust
anchor (volume root or user profile). Each ancestor must be a directory, not a
symlink/junction escape, and must not be replaceable mid-operation without
detection.

### Node vs helper responsibilities

**Node (JS) can:**

- resolve and realpath candidates;
- refuse symlinks where `fs` APIs allow;
- chmod/mode on platforms that honor them (not a Windows ACL substitute);
- call a tightly protocol-scoped helper and parse structured results;
- keep the fail-closed gate until every prerequisite path proves green.

**Node cannot (product bar):**

- authoritatively create or verify current-user-only DACLs without native code;
- safely reason about inherited ACEs, BUILTIN groups, or integrity levels from
  pure JS.

**Packaged win32-x64 helper should be extended** (preferred over a second
binary) with an explicit subcommand/protocol for:

1. `ensure_private_dir <path>` — create if missing with owner-only DACL
   (no inherit-only holes; disable inheritance; explicit OWNER ALLOW
   FILE_ALL_ACCESS; no Everyone/Users allow);
2. `verify_private_dir <path>` — reopen by handle, verify owner SID == current
   user, verify DACL matches the template, verify not a reparse point unless
   explicitly allowed;
3. `verify_private_tree <path> --ancestors-until <anchor>` — walk ancestors;
4. optional `secure_temp_run` for provider temp creation under the parent.

Protocol remains versioned JSON on stdin/stdout (same containment family as
Job Object control). Fail closed on any verify mismatch.

**New native surface** only if extending the Job Object helper would conflate
lifetime-critical process control with ACL filesystem work under a single
failure domain. Default: extend the existing helper; split only with evidence.

### ARM64 posture

Unchanged by this design decision: **win32-arm64 remains unavailable** until a
separately reviewed, hash-pinned helper is packaged. The egress gate stays
fail-closed on ARM64 Windows even after x64 DACL work lands, unless the same
PR that removes the gate also ships and verifies ARM64 helper bits. The epic
does **not** require ARM64 to ship v0.6.0, but readiness evidence must name
ARM64 as still blocked if the helper is x64-only.

### Threat model

| Widening | Mitigation must prove | Explicitly out of scope |
|---|---|---|
| Inheritance from parent ACEs | disable inheritance; explicit ACL only | defending a malicious same-user process with SeBackup/SeRestore or ACL-write rights |
| Junction / symlink swap on ancestors | open-by-id / re-verify after create; refuse unexpected reparse points | kernel-level TOCTOU against equal-privilege attackers beyond best-effort handle checks |
| Replacement races on root path | create with restrictive ACL atomically; verify handle identity | hostile code running as the same user throughout |
| Stale state from older versions | migrate or refuse roots that fail verify; never chmod-weaker | cross-user multi-tenant hosts (unsupported) |
| Ancestor swap after verify | re-check ancestors at capability issue and before provider spawn | continuous FS filter drivers |
| Helper binary substitution | existing sha256 pin + path allowlist | compromised admin installing a different pin |

Product already declines to claim protection against a malicious same-user
process. DACL work raises the bar for **other local users and inherited wide
ACLs**, and makes “private state” an honest label on NTFS.

### Removing the fail-closed gate

The constant and call sites in `src/provider-egress-platform.mjs` come out
**only** in the same reviewed change that:

1. lands helper DACL ensure/verify with protocol tests;
2. wires ensure+verify into every root class above before any live snapshot or
   capability issue on `win32`;
3. proves Windows CI (x64) matrix paths: create fresh root, reject wide ACL,
   reject junction escape, reject wrong owner, survive rename atomic writers;
4. updates SECURITY/PRIVACY/ARCHITECTURE wording without claiming same-user
   malware protection;
5. records readiness evidence (CI run IDs, helper sha256, platform matrix).

Documentation alone never removes the gate.

## Consequences

- v0.6.0 is a **minor** version: state-layer behavior and product surface change
  (Windows live review may become available on x64).
- Host e2e on Windows becomes meaningful only after the gate lift.
- POSIX paths unchanged aside from any shared API shaping.
- Successor implementation: external `LANE-H-windows-dacl.md`.

## Alternatives considered

1. **Keep gate forever** — rejects a real Windows user segment; declined.
2. **JS-only icacls subprocess** — brittle parsing, weaker verify, easy to get
   inheritance wrong; declined as primary control (may appear only as a
   debug aid, never as the gate).
3. **Separate ACL helper binary** — extra pin surface; deferred unless Job
   Object extension proves unsafe.
