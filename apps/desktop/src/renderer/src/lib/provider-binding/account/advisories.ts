// The sentences beside the account picker. Each is true of every producer of the stored
// health state, including the background observer, which reads only local credential state:
// `authenticated` means a credential is present and not locally known dead, not that the
// provider accepts it. A remedy is named as an act, never as a command to run.

import type {
  ProviderAccount,
  ProviderReadiness,
} from "@ai-sidekicks/contracts/provider/account/record";

import {
  accountPlaneRemedySentence,
  PROVIDER_READINESS_STATE_WORDS,
} from "#renderer/lib/provider-accounts/sentences.js";
import { formatDateTime } from "#renderer/lib/wire/figures.js";
import { advisoryChoiceIn, type AccountAxisReading, type AccountChoice } from "./axis.js";

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
    `The observation at ${observedAt} found this account's login expired.`,
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

/**
 * Every advisory line this account carries: what was stored, then its state and the one remedy
 * that applies, in the Providers page's words. Never empty. The stored instant is written in
 * `locale`, the machine's clock locale.
 */
export function accountAdvisoriesFor(choice: AccountChoice, locale: string): readonly string[] {
  const advisories = [storedHealthAdvisoryFor(choice, locale)];
  const { readiness } = choice;
  if (readiness === undefined) {
    return advisories;
  }
  advisories.push(PROVIDER_READINESS_STATE_WORDS[readiness.state](readiness.provider));
  const remedyAdvisory = remedyAdvisoryFor(readiness);
  if (remedyAdvisory !== undefined) {
    advisories.push(remedyAdvisory);
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
  const readiness = reading.kind === "served" ? reading.providerReadiness : undefined;
  return readiness === undefined ? undefined : remedyAdvisoryFor(readiness);
}

/** The stored reading as one sentence: what was found, and when it was found. */
function storedHealthAdvisoryFor(choice: AccountChoice, locale: string): string {
  const { healthObservedAt } = choice;
  if (healthObservedAt === null) {
    return NEVER_OBSERVED_ADVISORY;
  }
  // `formatDateTime` answers an em dash for a stamp it cannot read, so a malformed instant
  // costs the sentence its date, not the field.
  return OBSERVED_HEALTH_ADVISORIES[choice.healthState](formatDateTime(healthObservedAt, locale));
}

/**
 * The one remedy a readiness entry names, in the Providers page's own sentence, never a command.
 * Both readers use it, so a person meets the same sentence whether or not an account resolved.
 */
function remedyAdvisoryFor(readiness: ProviderReadiness): string | undefined {
  const { remedy } = readiness;
  return remedy === undefined
    ? undefined
    : accountPlaneRemedySentence(remedy.kind, readiness.state, readiness.provider);
}
