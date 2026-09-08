// The registry reading the account axis's two model suites are driven with.
//
// TYPED ROWS, WHERE `account-registry.test-support.ts` HOLDS A WIRE REPLY. That module
// answers what a scripted daemon puts on `providerAccount.list`, which is untyped by
// construction because the bridge's own parser is what turns it into rows. This one
// answers the other side of that parse: the rows a model suite hands the axis
// directly, in the registered shape and nothing narrower. Two roles, so two modules —
// and one home each, which is why neither suite writes a row of its own.
//
// A FUNCTION PER FIXTURE rather than a held object, so one case's reading is never the
// object a previous case was handed: nothing here mutates one today, and a fixture
// that could be mutated across cases is the shape that makes a suite order-dependent
// later.

import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderReadiness,
} from "@ai-sidekicks/contracts";

import type { AttachAccountRegistryReading } from "./account-axis.js";

/** The instant every stored observation in these suites was taken at. */
export const OBSERVED_AT = "2026-09-01T10:00:00.000Z";

/**
 * One registry account id, branded the way the contract brands one.
 *
 * The cast is this tree's established shape for a branded wire id in a fixture
 * (`settings/pages/provider-accounts/shell/quota-rows.test.ts`): the brand exists to
 * stop a caller passing any string on the wire, and a test that parsed one through
 * the schema would be asserting the schema rather than the model under test.
 */
export function registryAccountId(value: string): ProviderAccountId {
  return value as ProviderAccountId;
}

/** One registry row, in the registered shape and nothing narrower. */
export function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    accountId: registryAccountId("acct-team"),
    provider: "claude",
    displayLabel: "Team",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: OBSERVED_AT,
    observedAuthMode: "oauth_subscription",
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    ...overrides,
  };
}

/** A served registry reading over the accounts a case cares about. */
export function served(
  accounts: readonly ProviderAccount[],
  readiness: readonly ProviderReadiness[] = [],
): AttachAccountRegistryReading {
  return { phase: "read", readRefusal: undefined, accounts, readiness };
}

/**
 * The `claude` entry that resolved to one account and is waiting on a sign-in.
 *
 * The `sign_in` arm on purpose, and its `accountId` is the entry's own
 * `resolvedAccountId` because the contract's parser refuses any other pairing: the arm
 * names a credential home, and a home belonging to a different account is the
 * cross-account election the account plane exists to refuse.
 */
export function resolvedTo(accountId: string): ProviderReadiness {
  return {
    provider: "claude",
    state: "reauth_required",
    resolvedAccountId: registryAccountId(accountId),
    remedy: {
      kind: "sign_in",
      accountId: registryAccountId(accountId),
      signInInvocation: "claude login",
      credentialHomePath: `/homes/${accountId}`,
    },
  };
}
