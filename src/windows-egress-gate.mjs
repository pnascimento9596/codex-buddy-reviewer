// Single source of truth for the Windows live-egress gate flip (Phase 5).
// Kept free of imports so state.mjs and provider-egress-platform.mjs can share
// it without cycles.
//
// When true, win32 live review is allowed only if helper pin + protocol 2,
// filesystem ACLs, root ensure/verify, and kill-switch checks all pass.
// CODEX_BUDDY_WINDOWS_EGRESS_BLOCK=1 still forces fail-closed without a release.
//
// v0.6.0-rc.1 promotion candidate: H01-H06 remediation and the deferred
// kill-switch default fix are merged. This deliberate lift is the exact
// configuration reviewed by the Phase 4 full re-seal; no RC may publish unless
// that re-seal passes without an RC-blocking finding.
export const WINDOWS_PROVIDER_EGRESS_GATE_LIFTED = true;
