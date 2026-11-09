// The registry reading the account axis's model suites and its field's suite are driven with.
// Each fixture is a function, so no case is handed an object a previous case held.

import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderReadiness,
} from "@ai-sidekicks/contracts/provider/account/record";

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";

import type { AccountRegistryReading } from "./axis.js";
import {
  listedAccount,
  type ListedProviderAccount,
} from "#renderer/lib/provider-accounts/listing.js";
import { providerSectionOf } from "#renderer/store/providers/name.js";
import { providerSectionsFixture } from "#renderer/store/providers/sections.test-support.js";

/** The instant every stored observation in these suites was taken at. */
export const OBSERVED_AT = "2026-09-01T10:00:00.000Z";

/**
 * One registry account id, branded as the contract brands one. A cast, because parsing it
 * through the schema would test the schema rather than the model.
 */
export function registryAccountId(value: string): ProviderAccountId {
  return value as ProviderAccountId;
}

/**
 * One registry row, in the registered shape and nothing narrower. A cast, because overrides may
 * move it to the other health arm, which a spread over the union cannot narrow to.
 */
export function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    accountId: registryAccountId("acct-team"),
    provider: "claude" as ProviderId,
    observedAccountEmail: "sam@example.com",
    observedAccountPlan: "team",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: OBSERVED_AT,
    observedAuthMode: "oauthSubscription",
    signedInAt: null,
    signInNeededAtEstimate: null,
    probeEnabled: true,
    lastRefreshObservedAt: null,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
    ...overrides,
  } as ProviderAccount;
}

/** A served registry reading over the accounts a case cares about, as the registry lists them. */
export function served(
  accounts: readonly ProviderAccount[],
  readiness: readonly ProviderReadiness[] = [],
): AccountRegistryReading {
  return {
    phase: "read",
    readRefusal: undefined,
    accounts: listedFixtureAccounts(accounts),
    readiness,
  };
}

/**
 * `accounts` as a view lists them, each labeled from its provider's fixture section; an account
 * its provider has not named is left out.
 */
export function listedFixtureAccounts(
  accounts: readonly ProviderAccount[],
): readonly ListedProviderAccount[] {
  return accounts.flatMap(
    (account) =>
      listedAccount(account, providerSectionOf(providerSectionsFixture(), account.provider)) ?? [],
  );
}

/**
 * The `claude` entry that resolved to one account and awaits a sign-in. The `signIn`
 * arm's `accountId` equals `resolvedAccountId` because the contract's parser refuses any
 * other pairing.
 */
export function resolvedTo(accountId: string): ProviderReadiness {
  return {
    provider: "claude" as ProviderId,
    state: "reauthRequired",
    resolvedAccountId: registryAccountId(accountId),
    remedy: {
      kind: "signIn",
      accountId: registryAccountId(accountId),
    },
  } as ProviderReadiness;
}
