export const WINDOWS_PROVIDER_EGRESS_FAILURE_CODE = 'windows_private_state_acl_unavailable';

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

export function providerEgressPlatformPolicy(platform = process.platform) {
  return platform === 'win32' ? WINDOWS_BLOCKER : SUPPORTED;
}

export function assertProviderEgressPlatformAllowed(platform = process.platform) {
  const policy = providerEgressPlatformPolicy(platform);
  if (policy.allowed) return policy;
  const error = new Error(`${policy.summary} ${policy.detail}`);
  error.failureCode = policy.failureCode;
  throw error;
}
