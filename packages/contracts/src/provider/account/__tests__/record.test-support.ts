// The provider account record the account tests start from, kept as one body.

/** The account id every shared account fixture carries. */
export const ACCOUNT_ID = "acct_01J8XYZ";

/** The instant the shared account fixture was signed in and last observed. */
export const TIMESTAMP = "2026-08-31T00:00:00.000Z";

/** A valid, healthy, default Claude subscription account, with `overrides` laid over it. */
export function validProviderAccount(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    provider: "claude",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: TIMESTAMP,
    observedAuthMode: "oauth_subscription",
    loggedInAt: TIMESTAMP,
    lastRefreshObservedAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
    ...overrides,
  };
}
