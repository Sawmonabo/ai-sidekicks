// What the account plane's reading says about one account, once it is on this page.
//
// PURE, AND SEPARATE FROM THE READ FOR THAT REASON. Every rule here is a derivation
// over one reading — which of its rows belong to this account, whether an observation
// is behind the account it describes, how old a stored observation is, and how far off
// a re-login estimate is. Each of them is drivable with no bridge and no React.
//
// WHICH READING IS CURRENT IS NOT ONE OF THEM, AND THAT IS THE POINT OF THE SIGNATURE.
// `Spec-029 §Per-limit provider quota` states supersession as two rules in one order —
// newest wins by observation time, EXCEPT that a same-window reading never moves
// backward, the exception evaluated first — and `bridge/quotas/provider-quota-fold.ts`
// is the console's one implementation of it. This module used to fold the rows a second
// time on the way to the table, with the exception missing: a later reading below the
// high-water mark replaced the higher one on its timestamp alone, so this page could
// show 20% for a window the canonical feed was holding at 90% and the composer's chip
// was still reporting. A second rule for one decision does not stay in step, and the
// gate goes green while the two surfaces disagree.
//
// So the rows are SELECTED and never folded, and the parameter is the READOUT rather
// than an array of wire rows: `ProviderQuotaReadout.usageWindows` is the fold's own
// superseded set, one row per `(accountId, limitId)` with the high-water guard already
// applied, and the only thing that composes one is the node's single account-plane
// reader. A caller cannot hand this function raw wire rows to fold, because raw wire
// rows are not a readout.
//
// WHAT IS DELIBERATELY NOT HERE. No health verdict, no readiness state, and no remedy.
// All three arrive on the reply already decided and are rendered as they came: the
// page's own rules forbid treating a health reading as a claim of authentication and
// forbid computing a remedy at all.

import type {
  ProviderAccount,
  ProviderAccountUsageWindow,
  ProviderReadiness,
} from "@ai-sidekicks/contracts";

import type { ProviderQuotaReadout } from "../../../../bridge/index.js";
import { MILLISECONDS_PER_DAY, parseInstant } from "../../../../core/index.js";

/**
 * The current reading for one `(accountId, limitId)` pair, plus whether it is behind.
 *
 * `behindAccountGeneration` is carried rather than recomputed at render because it is
 * the one thing a percentage on its own cannot say: a credential-home rebuild does not
 * clear stored readings — the provider-side allowance keeps running while the home is
 * empty — so a figure taken two generations ago is true about the provider and stale
 * about this account, and the page has to say which.
 */
export interface AccountQuotaRow {
  readonly window: ProviderAccountUsageWindow;
  readonly behindAccountGeneration: boolean;
}

/**
 * The rows the account plane's reading holds for one account, as the table draws them.
 *
 * A SELECTION AND NEVER A FOLD. Which reading is current for a `(accountId, limitId)`
 * pair is settled before a row reaches this function, by the one implementation of that
 * rule; every seated row for this account is carried through, and none is dropped,
 * replaced, or re-ranked here. A second answer to that question is the defect this
 * signature exists to make unwritable.
 *
 * Rows are ordered by the provider's own label where it published one and by `limitId`
 * otherwise, so the table does not reshuffle between reads. Ordering is a presentation
 * rule and is this page's to make — the fold's own order is by account first, which is
 * the wrong key for a table that is already about one account.
 */
export function accountQuotaRowsFrom(
  registry: ProviderQuotaReadout,
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

/** What a quota row sorts on: the provider's own label, else its limit identifier. */
function quotaSortKey(window: ProviderAccountUsageWindow): string {
  return window.label ?? window.limitId;
}

/**
 * How many whole days a re-login estimate sits after the sign-in it is anchored to,
 * or `undefined` where either stamp is unreadable.
 *
 * `undefined` rather than a zero, because zero is a real answer meaning "the same day"
 * and a stamp the console could not parse is not an answer at all.
 *
 * WHOLE DAYS, AND MEASURED FROM THE ANCHOR RATHER THAN FROM NOW. The registry
 * publishes this as an estimate mode-dispatched from `loggedInAt`, never as a deadline
 * the daemon can vouch for, so what is true about it is the interval it was derived
 * from — "about thirty days after sign-in". A countdown from the current clock would
 * read as a deadline, would tick, and would be a poll in everything but name.
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
 * How long ago an observation was taken, in whole days, or `undefined` where the
 * stamp cannot be read.
 *
 * The page uses this only to decide how loudly to present an observation's age. It
 * never withholds one: "a stale `healthObservedAt` renders with its timestamp rather
 * than being hidden", so an unreadable age costs the row its emphasis and never its
 * figure.
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
 * The reply is required to carry exactly one entry per provider it selected, so an
 * absence here is a reply that did not do what the contract says. It is answered with
 * `undefined` rather than a fabricated `indeterminate`, because a state this console
 * invented would be indistinguishable on screen from one the daemon computed.
 *
 * It takes the PROJECTION rather than the whole reply, because the console holds one
 * reader of the account plane and what that reader publishes is the registry folded —
 * accounts, quota rows, and this list as three members rather than a reply object. A
 * signature naming the reply would have made a caller reassemble one to ask.
 */
export function readinessForProvider(
  readiness: readonly ProviderReadiness[],
  provider: ProviderAccount["provider"],
): ProviderReadiness | undefined {
  return readiness.find((entry) => entry.provider === provider);
}
