# 0002. Windows current-user-only DACL private-state epic (v0.6)

- Status: accepted
- Date: 2026-08-07
- Lane: lane-g Phase 5 (design only; zero provider calls); **amended lane-h Phase 1**
  (empirical template + filesystem contract; still proposed until gate-lift evidence)
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
| Runtime / PLUGIN_DATA root | `resolveRuntimeDataDir` (`PLUGIN_DATA`; write path) + `enumerateRuntimeDataDirs` (`PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`, discovered `<CODEX_HOME>/plugins/data/codex-buddy-reviewer*`, durable fallback) | automatic-reviews, outbox, turns, circuits; **stricter union**: ensure+verify the active write root and every enumerated root before Windows ownership-assurance claims |
| Manual review store | `store.mjs` under data dir | temp dir `0700` then rename |
| Provider temporary parent | `providerTempParent(os.tmpdir())` → `…/codex-buddy-provider-v1-<userKey>` (`TEMP_PARENT_PREFIX` in `temp-state.mjs`; schema labels are `codex-buddy-provider-temp-v1/v2`) | Windows path currently records `windows_acl_unverified` |
| Provider temporary run dirs | `run-*` children of that parent | may hold selected OpenCode auth entries transiently; these are the real content roots to secure |
| Atomic write temp inodes + final files | `writePrivateJsonAtomic` / exclusive writers in `state.mjs` | mode temp **before** rename on POSIX; temps are same-parent as destination — directory OI\|CI inheritance provides the **other-user access boundary** under a verified private parent; final (and any full-template-verified) children still require `ensure_private_file` after create/rename so owner + protected DACL match the leaf template |
| File-lock / lease paths | `withFileLock` siblings under the same roots | must receive the same private DACL as other children |
| Packaged helper path | `bin/win32-x64/buddy-job-supervisor.exe` | integrity pin already; not private state but trusted TCB for DACL ops |

Ancestor chain: from each root up to (but not including) a reviewed trust
anchor (volume root or user profile). Each ancestor must be a directory, not a
symlink/junction escape, and must not be replaceable mid-operation without
detection. Ancestor DACLs are **not** required to match the Buddy leaf
template (profile roots are SYSTEM-owned with additional ACEs); ancestor
checks refuse unexpected reparse points and re-verify identity around
capability issue / provider spawn.

### Empirical DACL template (lane-h Phase 1)

Evidence: GitHub Actions run `31226627271` on `windows-latest` (head
`f0c4d627…`), summary sha256
`a0856610248ec04c76fa85a43cf91bbd0a57d7abf8fdc7d4f2ffbd2727f4458a`.
External capture: lane-h `phase-1-acl-probe/` + `phase-1-template.md`.

**Observation:** real profile/LOCALAPPDATA/TEMP and fresh `mkdir` children
always carry **SYSTEM** and **Administrators** Allow-FullControl ACEs.
Admin-token creators get owner **BUILTIN\Administrators**, not the user SID.
A template that permits only a single OWNER ACE rejects every real machine.

**Buddy-created leaf template (ensure + verify):**

1. Leaf is a directory or regular file, **not** an unexpected reparse point.
2. DACL is **protected** (inheritance disabled) on the leaf.
3. **Owner SID == current process user SID** (ensure sets owner explicitly).
4. Explicit ALLOW ACEs **only** for this permitted set (order irrelevant):
   - Current user SID — `FILE_ALL_ACCESS`
   - `NT AUTHORITY\SYSTEM` (`S-1-5-18`) — `FILE_ALL_ACCESS`
   - `BUILTIN\Administrators` (`S-1-5-32-544`) — `FILE_ALL_ACCESS`
   - Directories: each ACE carries `OBJECT_INHERIT | CONTAINER_INHERIT`,
     propagation none (default **inheritance** design — see below).
   - Files: no inheritance flags on the ACEs.
5. **Forbidden** any other ALLOW principal, including Everyone (`S-1-1-0`),
   Users (`S-1-5-32-545`), Authenticated Users (`S-1-5-11`), INTERACTIVE
   (`S-1-5-4`), and any other user SID.
6. **No DENY ACEs** on the explicit DACL we accept.

**Administrators-allow is tolerated on purpose.** The product model protects
against **other local (non-admin) users** and **inherited wide ACLs**, not
against local Administrators, SYSTEM, or a malicious same-user process.
SECURITY/PRIVACY must state that plainly when the gate lifts.

**Inheritance default (access boundary vs full leaf template):** directory
template uses OI|CI so same-parent atomic temps and lock files **inherit the
permitted ACE set** without a helper round-trip per write. That is sufficient
as the **other-local-user access boundary** while the parent remains a
verified private directory: non-admin users never receive an Allow ACE.

Inheritance does **not** automatically make a child satisfy the full leaf
template above. On Windows, a newly created child:

- receives inheritable ACEs from the parent, but typically does **not** get
  `SE_DACL_PROTECTED` copied as a protected leaf control bit;
- gets its **owner** from the creating token’s default owner (often
  `BUILTIN\Administrators` on admin tokens), not from the parent directory
  owner.

Therefore:

1. **Roots and any path that must pass `verify_private_*` full template**
   (capability issue, provider temp roots, durable state roots) are created or
   repaired with `ensure_private_dir` / `ensure_private_file` so owner is the
   current user and the DACL is protected.
2. **Hot-path child writes** may rely on OI|CI for the access boundary under a
   verified private parent without a helper call on every byte write.
3. After atomic rename (or for any child that will later be verified as a
   full-template leaf), Node **must** call `ensure_private_file` (or an
   equivalent helper-backed secure create) so the final inode meets owner +
   protected-DACL requirements — inheritance alone is not that step.
4. Phase 2 measures helper round-trip cost for ensure-per-write vs
   inheritance-only access boundary, and proves with CI whether an inherited
   child is other-user-inaccessible even before ensure_private_file.

`ensure_private_file` is therefore required for full-template children, not
merely an optional repair tool. Phase 3 wiring must not treat “parent was
ensured” as “child passes verify_private_file”.

Conceptual ensure SDDL shape:

```text
O:<user-sid>D:P(A;OICI;FA;;;<user-sid>)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)
```

### Filesystem capability contract

`CODEX_BUDDY_DATA_DIR`, `PLUGIN_DATA`, and temp bases can point at volumes
without ACL support (exFAT/FAT32) or at UNC paths where ACL APIs are not
honestly available.

- Detect ACL capability (persistent ACLs via volume information / equivalent).
- **Fail closed** with distinct code
  `windows_private_state_filesystem_acl_unavailable`.
- Never silent downgrade; never claim privacy the volume cannot provide.
- ARM64 helper absence uses a **distinct** code
  `windows_private_state_helper_arch_unavailable` so users are not told ACL
  support is generally unimplemented.

### Node vs helper responsibilities

**Node (JS) can:**

- resolve and realpath candidates;
- refuse symlinks where `fs` APIs allow;
- chmod/mode on platforms that honor them (not a Windows ACL substitute);
- call a tightly protocol-scoped helper and parse **structured** results
  (never treat `icacls` text as authority);
- keep the fail-closed gate until every prerequisite path proves green;
- inject an explicit capability/verification object into platform policy
  (not a module-level singleton).

**Node cannot (product bar):**

- authoritatively create or verify current-user-only DACLs without native code;
- safely reason about inherited ACEs, BUILTIN groups, or integrity levels from
  pure JS.

**Packaged win32-x64 helper should be extended** (preferred over a second
binary) with an explicit subcommand/protocol for:

1. `ensure_private_dir <path>` — create if missing; apply the Phase 1 template
   (protected DACL; owner = current user; permitted ACE set with OI|CI).
2. `ensure_private_file <path>` — create/rewrite a file with the file form of
   the template.
3. `verify_private_dir` / `verify_private_file` — reopen by handle, verify
   owner SID == current user, verify DACL matches the template, verify not an
   unexpected reparse point.
4. `verify_private_tree <path> --ancestors-until <anchor>` — walk ancestors
   for reparse/escape; leaf must match template.
5. optional `secure_temp_run` for provider temp `run-*` creation under the
   real parent prefix `codex-buddy-provider-v1-`.
6. filesystem ACL capability probe used by Node before claiming private state.

**Protocol version 2** with an explicit compatibility contract: a protocol-1
helper encountered at runtime fails closed to the existing gate (no assumed
DACL capability). Structured JSON results on stdin/stdout for DACL commands;
Job Object control protocol remains the existing authenticated pipe family
under the same binary, version-gated.

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
| Inheritance from parent ACEs | disable inheritance on Buddy leaves; explicit permitted ACL only | defending a malicious same-user process with SeBackup/SeRestore or ACL-write rights |
| Junction / symlink swap on ancestors | open-by-id / re-verify after create; refuse unexpected reparse points | kernel-level TOCTOU against equal-privilege attackers beyond best-effort handle checks |
| Replacement races on root path | create with restrictive ACL atomically; verify handle identity | hostile code running as the same user throughout |
| Stale state from older versions | migrate or refuse roots that fail verify; never chmod-weaker | cross-user multi-tenant hosts (unsupported) |
| Ancestor swap after verify | re-check ancestors at capability issue and before provider spawn | continuous FS filter drivers |
| Helper binary substitution | existing sha256 pin + path allowlist | compromised admin installing a different pin |
| Non-ACL volumes | filesystem capability probe; fail closed | pretending FAT/exFAT is private |
| Local Administrators / SYSTEM | documented non-goal; ACEs tolerated in template | hiding admin-equivalent access |

Product already declines to claim protection against a malicious same-user
process. DACL work raises the bar for **other local users and inherited wide
ACLs**, and makes “private state” an honest label on NTFS.

### Phase 3 Node wiring and closed-gate contract

Lane-H Phase 3 adds an explicit, deeply frozen verification value covering the
durable data root, active runtime data root, and provider temporary parent.
On `win32`, the builder resolves the hash-pinned helper once, requires helper
capability protocol 2, probes persistent filesystem ACL capability for every
root, then performs `ensure_private_dir` followed by `verify_private_dir` for
each root. Later integrity checkpoints use verify-only operations: they never
repair a root and thereby hide a TOCTOU failure. Provider temporary `run-*`
directories receive `ensure_private_dir` after creation, and private JSON final
files receive `ensure_private_file` after atomic rename or exclusive link.

The verification value is passed explicitly through platform policy and
provider dispatch. There is no module-level “last verified” singleton. POSIX
create, mode, and ownership behavior is unchanged.

Production provider egress is controlled by the compile-time constant
`WINDOWS_PROVIDER_EGRESS_GATE_LIFTED` (Phase 5): `true` lifts the gate after
packaged-helper proof, `false` keeps win32 live egress closed. The pure policy can
represent the eventual verified allow path for unit testing, but the production
wrapper enables it only through the constant. Phase 5 remains the only
authorized constant flip, after packaged-helper proof. The permanent emergency
control `CODEX_BUDDY_WINDOWS_EGRESS_BLOCK=1` takes precedence and re-blocks
Windows egress even after a future gate lift.

> **0.5.1 disposition (2026-08-08):** the production constant was flipped to
> `false` for the security-fix release so v0.5.1 never ships a lifted gate while
> the Phase 6 sealed-scan findings H01–H06 remain unremediated. This is a
> release-posture change, not a design change: the constant is re-lifted for the
> v0.6.0-rc.1 promotion head after the Phase 2 remediation and the Phase 4
> full re-seal pass.

Distinct fail-closed results identify non-ACL filesystems, unavailable helper
architecture (including unavailable ARM64 packaging), unavailable helper,
protocol mismatch, kill-switch engagement, and useful root verification
failures. While the Phase 3 production constant is false, aggregate automatic
surfaces may continue to report the generic
`windows_private_state_acl_unavailable` blocker.

### TOCTOU terminal-state contract

Windows root integrity is checked at three provider-lifecycle boundaries:

| Point | Required terminal behavior |
|---|---|
| Before capability issue | Refuse cleanly. Issue no capability and enter no provider executor. |
| After capability spend, before executor entry | Settle the consumed capability exactly once as **definite non-execution**, conservatively block further mutation/dispatch, and do not charge the provider-quality circuit. |
| After provider entry / at execution terminal state | Classify a detected DACL failure as `platform_integrity` containment, discard the provider outcome, and do not charge the provider-quality circuit. |

The executor error carries non-public typed metadata distinguishing
`definite_non_execution` from `containment`. Public receipts retain only the
bounded failure code, `platform_integrity` stage, and a non-diagnostic message.
Raw helper output and root paths do not enter provider prompts or default
receipts.

### Provider temporary status migration

The historical `windows_acl_unverified` ownership-assurance marker remains a
valid and observable state after upgrade. It is emitted whenever Windows DACL
verification is absent, skipped, or blocked by the closed gate. A caller that
supplies a current explicit verification for the exact provider temporary root
receives `windows_dacl_verified`. The POSIX marker remains
`posix_uid_and_mode_verified`.

### Adversarial CI constructibility (Phase 1d)

On the observed unelevated admin runner, all of the following were
constructible and therefore **must** appear in the Windows suite: wide-ACL
(Users) reject, Everyone reject, junction reject, symlink/reparse reject,
inheritance-disabled positive path, directory rename replacement re-verify,
wrong-owner reject after ensure resets owner. Non-ACL filesystem is
**untestable on the NTFS runner** and is recorded as such — covered by
capability-probe unit tests / documented skip reason, never silently dropped.

### Removing the fail-closed gate

The constant and call sites in `src/provider-egress-platform.mjs` come out
**only** in the same reviewed change that:

1. lands helper DACL ensure/verify with protocol tests (protocol 2);
2. wires ensure+verify into every root class above before any live snapshot or
   capability issue on `win32`;
3. proves Windows CI (x64) matrix paths: create fresh root, reject wide ACL,
   reject junction escape, reject wrong owner, survive rename atomic writers,
   helper missing/wrong hash/protocol mismatch fail closed, non-ACL FS fail
   closed, kill-switch re-blocks;
4. proves **packaged** helper bytes (not only ephemeral CI builds) on the
   matrix, or records packaged verification UNRUN and **does not lift**;
5. updates SECURITY/PRIVACY/ARCHITECTURE wording without claiming same-user
   malware protection and with the Administrators/SYSTEM honesty paragraph;
6. records readiness evidence (CI run IDs, helper sha256, platform matrix,
   which adversarial cases ran vs untestable and why, explicit WINDOWS HOST
   E2E UNRUN until a later lane).

Documentation alone never removes the gate.

Policy functions must take an **explicit verification/capability input**
(helper present at pinned hash, protocol 2, roots verified, filesystem
ACL-capable, kill-switch disengaged) — not only a platform string.

## Consequences

- v0.6.0 is a **minor** version: state-layer behavior and product surface change
  (Windows live review may become available on x64 under verified private
  state).
- Host e2e on Windows becomes meaningful only after the gate lift; until a
  Windows Codex host is observed, ship path is RC + honest UNRUN host e2e.
- POSIX paths unchanged aside from any shared API shaping.
- Packaging: protocol bump requires rebuilt `bin/win32-x64` pin, helpers.json
  provenance, release-boundary and publication scans over the committed exe.
- Successor implementation after design: lane-h Phases 2–8.

## Alternatives considered

1. **Keep gate forever** — rejects a real Windows user segment; declined.
2. **JS-only icacls subprocess** — brittle parsing, weaker verify, easy to get
   inheritance wrong; declined as primary control (may appear only as a
   debug aid, never as the gate).
3. **Separate ACL helper binary** — extra pin surface; deferred unless Job
   Object extension proves unsafe.
4. **OWNER-only ACE with zero SYSTEM/Administrators** — empirically rejects
   real Windows defaults and admin-token semantics; declined.
5. **Per-file ensure on every atomic write** — correct but a latency foot-gun
   on Windows hot paths; declined as default in favor of OI|CI inheritance
   with measurement in Phase 2.


## Readiness evidence (Phase 5)

Gate lift is authorized only with the following anchors (machine-captured):

| Item | Value |
|---|---|
| Helper sha256 (win32-x64) | `22884692f20edb592d57cb3ea00d03dfa857bfe148a9625c986916fa83110fe1` |
| Helper bytes | 162816 |
| Packaged-from CI run | `31233008243` (head `d420938`; native identical on later main) |
| Protocol | capability 2 / job wire 1 / dacl 2 |
| Phase 2 PR | #80 |
| Phase 3 PR | #81 |
| Phase 4 PR | #82 |
| Phase 1 ACL probe run | `31226627271` |
| Windows matrix | windows-latest Node 22 and 24 |
| Packaged-byte CI | hash-verify + DACL protocol suite against committed `bin/win32-x64` |
| Adversarial CI cases | fresh root ensure/verify; Users/Everyone reject; deny ACE; junction; rename writers; protocol mismatch; wrong hash; non-ACL volume untestable on NTFS runner (recorded) |
| ARM64 | still unavailable |
| Kill-switch | `CODEX_BUDDY_WINDOWS_EGRESS_BLOCK=1` |
| **WINDOWS HOST E2E** | **UNRUN** — no Windows Codex host session observed in this lane |

Threat-model honesty after lift: protection against other local non-admin users and inherited wide ACLs on NTFS; **not** protection against local Administrators, SYSTEM, or a malicious same-user process.
