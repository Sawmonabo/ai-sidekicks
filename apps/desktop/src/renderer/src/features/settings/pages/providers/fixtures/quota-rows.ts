// What the account plane's reading says about one account, once it is on this page.
//
// Pure derivations over one reading (which rows belong to this account, whether an observation
// is behind its account, how old an observation is, how far off a re-login estimate is). Which
// reading is current is not one of them: `store/provider-accounts/provider-account-fold.ts` is
// the one implementation of quota supersession, so rows are selected here and never folded, and
// the parameter is the readout whose `usageWindows` is the fold's superseded set. No health
// verdict, readiness state or remedy is computed here; they arrive decided and render as came.

import type {
  ProviderAccount,
  ProviderAccountUsageWindow,
  ProviderReadiness,
} from "@ai-sidekicks/contracts/provider-account";

import type { ProviderAccountReadout } from "../provider-account-readout.js";
import { MILLISECONDS_PER_DAY, parseInstant } from "@renderer/lib/instant.js";

/**
 * The current reading for one `(accountId, limitId)` pair, plus whether it is behind.
 *
 * `behindAccountGeneration` is carried because a percentage cannot say it: a credential-home
 * rebuild does not clear stored readings, so a figure from an older generation is true about
 * the provider and stale about this account.
 */
export interface AccountQuotaRow {
  readonly window: ProviderAccountUsageWindow;
  readonly behindAccountGeneration: boolean;
}

/**
 * The rows the account plane's reading holds for one account, as the table draws them.
 *
 * A selection, never a fold: which reading is current is settled before a row reaches here,
 * and every current row for this account is carried through unchanged. Rows are ordered by the
 * provider's label where published and by `limitId` otherwise, so the table does not reshuffle
 * between reads; the fold's own order is by account first, the wrong key for one account's table.
 */
export function accountQuotaRowsFrom(
  registry: Pick<ProviderAccountReadout, "usageWindows">,
  account: ProviderAccount,
): readonly AccountQuotaRow[] {
  return registry.usageWindows
    .filter((window) => window.accountId === account.accountId)
    .sort((left, right) => quotaSortKey(left).localeCompare(quotaSortKey(right)))
    .map((window) => ({
      window,
      behindAccountGeneration: window.observedCredentialGeneration < account.credentialGeneration,
    }));
}

/**
 * How many whole days a re-login estimate sits after the sign-in it is anchored to, or
 * `undefined` where either stamp is unreadable (zero means "the same day", an unparseable stamp
 * is no answer).
 *
 * Measured from the anchor, not from now: the registry publishes an estimate from `loggedInAt`,
 * and a countdown from the clock would read as a deadline and tick.
 */
export function estimatedReloginDaysAfterSignIn(
  loggedInAtIso: string,
  expectedReloginAtIso: string,
): number | undefined {
  const signedIn = parseInstant(loggedInAtIso);
  const expected = parseInstant(expectedReloginAtIso);
  if (signedIn.kind === "malformed" || expected.kind === "malformed") {
    return undefined;
  }
  return Math.round(
    (expected.epochMilliseconds - signedIn.epochMilliseconds) / MILLISECONDS_PER_DAY,
  );
}

/**
 * How long ago an observation was taken, in whole days, or `undefined` where the stamp cannot
 * be read.
 *
 * The page uses it only to decide how loudly to present an observation's age; an unreadable
 * age costs the row its emphasis and never its figure.
 */
export function observationAgeInDays(
  observedAtIso: string,
  nowMilliseconds: number,
): number | undefined {
  const observed = parseInstant(observedAtIso);
  if (observed.kind === "malformed") {
    return undefined;
  }
  return Math.floor((nowMilliseconds - observed.epochMilliseconds) / MILLISECONDS_PER_DAY);
}

/**
 * The readiness entry for one provider, or `undefined` where the read carried none.
 *
 * The reply carries one entry per selected provider, so an absence is a reply that broke the
 * contract; it is answered with `undefined` and not a fabricated `indeterminate`. It takes the
 * projection rather than the whole reply, which is what the console's one account-plane reader
 * publishes.
 */
export function readinessForProvider(
  readiness: readonly ProviderReadiness[],
  provider: ProviderAccount["provider"],
): ProviderReadiness | undefined {
  return readiness.find((entry) => entry.provider === provider);
}

/** What a quota row sorts on: the provider's own label, else its limit identifier. */
function quotaSortKey(window: ProviderAccountUsageWindow): string {
  return window.label ?? window.limitId;
}
