// The sentences beside the account picker. Each is true of every producer of the stored
// health state, including the background observer, which reads only local credential state:
// `authenticated` means a credential is present and not locally known dead, not that the
// provider accepts it. A remedy is named as an act, never as a command to run.

import type { ProviderAccount, ProviderRemedy } from "@ai-sidekicks/contracts/provider-account";

import { formatDateTime } from "@renderer/lib/wire-figures.js";
import { advisoryChoiceIn, type AccountAxisReading, type AccountChoice } from "./account-axis.js";

/**
 * What the observation found, per health state, given when it was taken. Total over the
 * contract's union; each sentence says what was observed, never that the account will work.
 */
const OBSERVED_HEALTH_ADVISORIES: Readonly<
  Record<ProviderAccount["healthState"], (observedAt: string) => string>
> = {
  authenticated: (observedAt) =>
    `The observation at ${observedAt} found a credential in this ` +
    "account's home and nothing local reporting it dead. Whether the " +
    "provider still accepts it is decided when a run starts.",
  reauth_required: (observedAt) =>
    `The observation at ${observedAt} found this account needing a ` +
    "fresh sign-in before a run can use it.",
  home_missing: (observedAt) =>
    `The observation at ${observedAt} found no credential home where this account expects one.`,
  indeterminate: (observedAt) =>
    `The observation at ${observedAt} did not decide about this account.`,
};

/**
 * Said wherever the account carries no observation time. Its own sentence, because a
 * never-observed account and an undecided probe both project `indeterminate` and only the
 * timestamp tells them apart.
 */
const NEVER_OBSERVED_ADVISORY = "This account has never been observed.";

/** The stored reading as one sentence: what was found, and when it was found. */
function storedHealthAdvisoryFor(choice: AccountChoice, locale: string | undefined): string {
  const { healthObservedAt } = choice;
  if (healthObservedAt === null) {
    return NEVER_OBSERVED_ADVISORY;
  }
  // `formatDateTime` answers an em dash for a stamp it cannot read, so a malformed instant
  // costs the sentence its date, not the field.
  return OBSERVED_HEALTH_ADVISORIES[choice.healthState](formatDateTime(healthObservedAt, locale));
}

/**
 * Names the act that closes a readiness entry, never a command: the remedy's content is the
 * daemon's. Both readers use this one table, so a person meets the same sentence whether or
 * not an account resolved.
 */
const REMEDY_ADVISORIES: Readonly<Record<ProviderRemedy["kind"], string>> = {
  register: "No account is registered for this provider.",
  choose_default: "Accounts are registered for this provider and none of them is the default.",
  sign_in: "Signing this account in again is what run admission is waiting for.",
  paste_token:
    "This account cannot refresh itself. A fresh token minted at the " +
    "provider and pasted in is what run admission is waiting for.",
  look_again: "Nothing is wrong that can be seen from here. The next check may settle it.",
};

/**
 * Every advisory line this account carries: what was stored, then what run admission last
 * made of it. Never empty. `locale` formats the stored instant.
 */
export function accountAdvisoriesFor(choice: AccountChoice, locale?: string): readonly string[] {
  const advisories = [storedHealthAdvisoryFor(choice, locale)];
  const { readiness } = choice;
  if (readiness === undefined) {
    return advisories;
  }
  advisories.push(`Run admission last read this provider as ${readiness.state}.`);
  if (readiness.remedy !== undefined) {
    advisories.push(REMEDY_ADVISORIES[readiness.remedy.kind]);
  }
  return advisories;
}

/**
 * The remedy sentence for an unpinned axis whose readiness entry resolved to no account the
 * picker can show, so no row's advisories could carry it. Silent when `accountId` pins one.
 */
export function unresolvedDefaultAdvisoryIn(
  reading: AccountAxisReading,
  accountId: string | undefined,
): string | undefined {
  if (accountId !== undefined || advisoryChoiceIn(reading, undefined) !== undefined) {
    return undefined;
  }
  const remedy = reading.kind === "served" ? reading.providerReadiness?.remedy : undefined;
  return remedy === undefined ? undefined : REMEDY_ADVISORIES[remedy.kind];
}
