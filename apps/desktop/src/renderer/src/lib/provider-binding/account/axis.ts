// Which provider accounts the account field may pin, which one its advisories speak for,
// and what the registry stored about each. Provider-scoped: an unchosen driver answers no
// choices, and a driver name is matched against the provider set, never assumed to be one.
// Readiness is per account, never per provider. Nothing here gates: the spawn probe decides.

import {
  type ProviderAccount,
  type ProviderReadiness,
} from "@ai-sidekicks/contracts/provider/account/record";
import { PROVIDER_NAMES, type ProviderName } from "@ai-sidekicks/contracts/provider/name";

import type { ListedProviderAccount } from "#renderer/lib/provider-accounts/listing.js";
import { findReadRefusal, type WireReadState } from "#renderer/lib/reads/lifecycle.js";

/**
 * The narrow slice of the window's account registry reading this axis reads; the full readout
 * satisfies it structurally, and a test can pass a plain object.
 */
export interface AccountRegistryReading extends WireReadState {
  /** Every account the registry carries, in the order the daemon sent them. */
  readonly accounts: readonly ListedProviderAccount[];
  /** Each provider's readiness entry and its one remedy, as the last read computed it. */
  readonly readiness: readonly ProviderReadiness[];
}

/** One account the axis may take, with the stored reading that renders beside it. */
export interface AccountChoice {
  readonly accountId: string;
  /** What the account is named by. */
  readonly label: string;
  readonly isProviderDefault: boolean;
  readonly healthState: ProviderAccount["healthState"];
  /** `null` where no observation has ever been recorded for this account. */
  readonly healthObservedAt: string | null;
  /**
   * The readiness entry that resolved to this account. Absent on every other account, since
   * the projection is per provider.
   */
  readonly readiness: ProviderReadiness | undefined;
}

/**
 * What the account axis can offer right now. Five arms, because the four that are not a
 * list would each read as "no accounts exist" if rendered as an empty picker.
 */
export type AccountAxisReading =
  | { readonly kind: "driver-unchosen" }
  | { readonly kind: "reading" }
  | { readonly kind: "refused" }
  | { readonly kind: "unknown-provider"; readonly driverName: string }
  | {
      readonly kind: "served";
      readonly provider: ProviderName;
      /**
       * This provider's own readiness entry, derived once in {@link accountAxisReadingFor} so
       * no component re-finds it. Absent where the read carried none for this provider.
       */
      readonly providerReadiness: ProviderReadiness | undefined;
      readonly choices: readonly AccountChoice[];
    };

/**
 * The accounts this driver's provider carries, in the registry's own order (the default is
 * marked on its row, not hoisted).
 */
export function accountAxisReadingFor(
  registry: AccountRegistryReading,
  driverName: string | undefined,
): AccountAxisReading {
  if (driverName === undefined || driverName === "") {
    return { kind: "driver-unchosen" };
  }
  // Decidable without the registry: a refused read must not be named as the reason a picker
  // is missing when the driver was the obstacle.
  const provider = providerForDriver(driverName);
  if (provider === undefined) {
    return { kind: "unknown-provider", driverName };
  }
  // Through the phase-aware accessor: a reading whose newest read served carries no
  // refusal, though an earlier one failed.
  if (findReadRefusal(registry) !== undefined) {
    return { kind: "refused" };
  }
  if (registry.phase === "reading") {
    return { kind: "reading" };
  }
  const providerReadiness = registry.readiness.find((entry) => entry.provider === provider);
  const choices = registry.accounts
    .filter((account) => account.provider === provider)
    .map((account) => accountChoiceFor(account, providerReadiness));
  return { kind: "served", provider, providerReadiness, choices };
}

/** The choice this axis is currently on, or `undefined` where the value names none. */
export function chosenAccountIn(
  reading: AccountAxisReading,
  accountId: string | undefined,
): AccountChoice | undefined {
  if (reading.kind !== "served" || accountId === undefined) {
    return undefined;
  }
  return reading.choices.find((choice) => choice.accountId === accountId);
}

/**
 * The choice the advisories speak for: the pinned one, else the account the readiness entry
 * resolved to. The entry, not `isProviderDefault`, decides, because it is what the spawn
 * path's resolution reached. A pinned value the registry lacks answers nothing rather than
 * falling through to the default.
 */
export function advisoryChoiceIn(
  reading: AccountAxisReading,
  accountId: string | undefined,
): AccountChoice | undefined {
  if (accountId !== undefined) {
    return chosenAccountIn(reading, accountId);
  }
  const resolvedAccountId =
    reading.kind === "served" ? reading.providerReadiness?.resolvedAccountId : undefined;
  return chosenAccountIn(reading, resolvedAccountId);
}

/**
 * Whether a pinned account is one this driver's provider carries. `true` wherever nothing
 * could tell (unread, refused, unknown provider), so an unread registry never marks a
 * caller's account unknown.
 */
export function registryCarriesAccount(reading: AccountAxisReading, accountId: string): boolean {
  return (
    reading.kind !== "served" || reading.choices.some((choice) => choice.accountId === accountId)
  );
}

/**
 * The provider a driver name speaks for, or `undefined`. The one place the form's driver
 * string is narrowed to the contract's closed provider set.
 */
function providerForDriver(driverName: string | undefined): ProviderName | undefined {
  return driverName === undefined
    ? undefined
    : PROVIDER_NAMES.find((provider) => provider === driverName);
}

/**
 * One registry row, carrying this provider's readiness entry only where it resolved to that
 * row, so a provider's verdict is never attached to a row it was not computed for.
 */
function accountChoiceFor(
  account: ListedProviderAccount,
  providerReadiness: ProviderReadiness | undefined,
): AccountChoice {
  return {
    accountId: account.accountId,
    label: account.label,
    isProviderDefault: account.isDefault,
    healthState: account.healthState,
    healthObservedAt: account.healthObservedAt,
    readiness:
      providerReadiness?.resolvedAccountId === account.accountId ? providerReadiness : undefined,
  };
}
