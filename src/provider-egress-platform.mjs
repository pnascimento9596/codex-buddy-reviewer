import {
  WINDOWS_PRIVATE_STATE_FAILURE_CODES,
  windowsPrivateStateVerificationIsComplete
} from './windows-private-state-roots.mjs';
import { WINDOWS_PROVIDER_EGRESS_GATE_LIFTED } from './windows-egress-gate.mjs';

export const WINDOWS_PROVIDER_EGRESS_FAILURE_CODE = 'windows_private_state_acl_unavailable';
export { WINDOWS_PROVIDER_EGRESS_GATE_LIFTED } from './windows-egress-gate.mjs';
export const WINDOWS_PROVIDER_EGRESS_KILL_SWITCH = 'CODEX_BUDDY_WINDOWS_EGRESS_BLOCK';

const WINDOWS_BLOCKER = Object.freeze({
  allowed: false,
  failureCode: WINDOWS_PROVIDER_EGRESS_FAILURE_CODE,
  summary: 'Live reviewer contact is disabled on Windows in this RC.',
  detail: 'Buddy does not yet create and verify current-user-only DACLs for durable review state and provider temporary roots. No evidence snapshot or provider prompt will be created for live review.'
});

const SUPPORTED = Object.freeze({
  allowed: true,
  failureCode: null,
  summary: 'Live reviewer contact is available on this platform.',
  detail: null
});

function blocked(failureCode, summary, detail) {
  return Object.freeze({ allowed: false, failureCode, summary, detail });
}

export function readWindowsEgressKillSwitch(env = process.env) {
  return env?.[WINDOWS_PROVIDER_EGRESS_KILL_SWITCH] === '1';
}

export function evaluateProviderEgressPlatformPolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Provider egress platform policy input must be an object');
  }
  const platform = input.platform ?? process.platform;
  if (platform !== 'win32') return SUPPORTED;
  const arch = input.arch ?? process.arch;
  const verification = input.verification ?? null;
  const killSwitch = input.killSwitch ?? readWindowsEgressKillSwitch(input.env);
  const gateLifted = input.gateLifted === true;

  if (killSwitch) {
    return blocked(
      'windows_private_state_kill_switch',
      'Live reviewer contact is disabled by the Windows egress kill-switch.',
      `${WINDOWS_PROVIDER_EGRESS_KILL_SWITCH}=1 forces Windows provider egress to remain fail-closed.`
    );
  }
  if (!gateLifted) return WINDOWS_BLOCKER;
  if (arch !== 'x64') {
    return blocked(
      WINDOWS_PRIVATE_STATE_FAILURE_CODES.helperArch,
      `Live reviewer contact is unavailable on Windows ${arch}.`,
      verification?.message ?? 'No verified Windows private-state helper is packaged for this architecture.'
    );
  }
  if (verification?.arch !== arch) {
    return blocked(
      WINDOWS_PRIVATE_STATE_FAILURE_CODES.helper,
      'Live reviewer contact is disabled because the Windows helper architecture is unverified.',
      'The private-state verification architecture must match the active process architecture.'
    );
  }
  if (!windowsPrivateStateVerificationIsComplete(verification)) {
    return blocked(
      verification?.failure_code ?? WINDOWS_PROVIDER_EGRESS_FAILURE_CODE,
      'Live reviewer contact is disabled because Windows private-state verification failed.',
      verification?.message ?? 'All durable, runtime, and provider temporary roots must pass helper pin, protocol-2, filesystem ACL, ensure, and DACL verification.'
    );
  }
  return SUPPORTED;
}

export function providerEgressPlatformPolicy(input = {}) {
  return evaluateProviderEgressPlatformPolicy({
    ...input,
    gateLifted: WINDOWS_PROVIDER_EGRESS_GATE_LIFTED
  });
}

export function assertProviderEgressPlatformAllowed(input = {}) {
  const policy = providerEgressPlatformPolicy(input);
  if (policy.allowed) return policy;
  const error = new Error(`${policy.summary} ${policy.detail}`);
  error.failureCode = policy.failureCode;
  throw error;
}
