// Single source of truth for the Windows live-egress gate flip (Phase 5).
// Kept free of imports so state.mjs and provider-egress-platform.mjs can share
// it without cycles.
//
// When true, the capability is present: win32 live review is allowed only if
// explicit opt-in, helper pin + protocol 2, filesystem ACLs, root ensure/verify,
// and kill-switch checks all pass.
// CODEX_BUDDY_WINDOWS_EGRESS_BLOCK=1 still forces fail-closed without a release.
// CODEX_BUDDY_WINDOWS_EGRESS_ENABLE=1 is the explicit runtime opt-in.
//
// v0.6.0 stable promotion: H01-H06 remediation and the deferred kill-switch
// default fix are merged. This deliberate lift is the exact configuration
// reviewed by the Phase 4 full re-seal; stable publication still requires the
// protected release workflow's complete verification gates.
export const WINDOWS_PROVIDER_EGRESS_GATE_LIFTED = true;
