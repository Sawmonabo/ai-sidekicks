// The registry reading the account axis's two model suites are driven with. Each fixture is
// a function, so no case is handed an object a previous case held.

import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderReadiness,
} from "@ai-sidekicks/contracts/provider/account/record";

import type { AccountRegistryReading } from "./axis.js";
import { listedAccount } from "#renderer/lib/provider-accounts/listing.js";

/** The instant every stored observation in these suites was taken at. */
export const OBSERVED_AT = "2026-09-01T10:00:00.000Z";

/**
 * One registry account id, branded as the contract brands one. A cast, because parsing it
 * through the schema would test the schema rather than the model.
 */
export function registryAccountId(value: string): ProviderAccountId {
  return value as ProviderAccountId;
}

/** One registry row, in the registered shape and nothing narrower. */
export function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    accountId: registryAccountId("acct-team"),
    provider: "claude",
    observedAccountEmail: "sam@example.com",
    observedAccountPlan: "team",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: OBSERVED_AT,
    observedAuthMode: "oauth_subscription",
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    lastRefreshObservedAt: null,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
    ...overrides,
  };
}

/** A served registry reading over the accounts a case cares about, as the registry lists them. */
export function served(
  accounts: readonly ProviderAccount[],
  readiness: readonly ProviderReadiness[] = [],
): AccountRegistryReading {
  return {
    phase: "read",
    readRefusal: undefined,
    accounts: accounts.flatMap((account) => listedAccount(account) ?? []),
    readiness,
  };
}

/**
 * The `claude` entry that resolved to one account and awaits a sign-in. The `sign_in`
 * arm's `accountId` equals `resolvedAccountId` because the contract's parser refuses any
 * other pairing.
 */
export function resolvedTo(accountId: string): ProviderReadiness {
  return {
    provider: "claude",
    state: "reauth_required",
    resolvedAccountId: registryAccountId(accountId),
    remedy: {
      kind: "sign_in",
      accountId: registryAccountId(accountId),
    },
  };
}
