// Single source of truth for the Windows live-egress gate flip (Phase 5).
// Kept free of imports so state.mjs and provider-egress-platform.mjs can share
// it without cycles.
//
// When true, win32 live review is allowed only if helper pin + protocol 2,
// filesystem ACLs, root ensure/verify, and kill-switch checks all pass.
// CODEX_BUDDY_WINDOWS_EGRESS_BLOCK=1 still forces fail-closed without a release.
export const WINDOWS_PROVIDER_EGRESS_GATE_LIFTED = true;
