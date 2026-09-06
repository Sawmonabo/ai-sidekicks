// What the registry reply says about one account, once the readings have been folded.
//
// PURE, AND SEPARATE FROM THE READ FOR THAT REASON. Every rule here is a derivation
// over one reply — which quota reading is current, whether an observation is behind
// the account it describes, how old a stored observation is, and how far off a
// re-login estimate is. Each of them is a place a surface could quietly disagree with
// the daemon, and each is drivable with no bridge and no React.
//
// WHAT IS DELIBERATELY NOT HERE. No health verdict, no readiness state, and no remedy.
// All three arrive on the reply already decided and are rendered as they came: the
// page's own rules forbid treating a health reading as a claim of authentication and
// forbid computing a remedy at all.

import type {
  ProviderAccount,
  ProviderAccountListResponse,
  ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts";

import { MILLISECONDS_PER_DAY, compareInstants, parseInstant } from "../../../../core/index.js";

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
 * Fold one account's quota readings: newest observation wins per limit.
 *
 * THE KEY IS `limitId` AND NEVER `windowMins`. One pinned provider surface publishes
 * three distinct limits that all run over 10080 minutes, so a window-keyed fold
 * collapses them and which one survives depends on the order the array happened to
 * arrive in. That is the exact defect the re-key exists to remove, and re-introducing
 * it here would put it back one layer up.
 *
 * `observedAt` decides, and `source` breaks ONLY an exact tie — the registered
 * ordering rule, with `probe` preferred because a deliberate probe is a reading
 * somebody asked for and a run-derived one is a side effect of traffic.
 *
 * Rows are returned ordered by the provider's own label where it published one and by
 * `limitId` otherwise, so the table does not reshuffle between reads.
 */
export function foldAccountQuotaRows(
  account: ProviderAccount,
  usageWindows: readonly ProviderAccountUsageWindow[],
): readonly AccountQuotaRow[] {
  const currentByLimitId = new Map<string, ProviderAccountUsageWindow>();
  for (const observed of usageWindows) {
    if (observed.accountId !== account.accountId) {
      continue;
    }
    const held = currentByLimitId.get(observed.limitId);
    if (held === undefined || supersedes(observed, held)) {
      currentByLimitId.set(observed.limitId, observed);
    }
  }
  return [...currentByLimitId.values()]
    .sort((left, right) => quotaSortKey(left).localeCompare(quotaSortKey(right)))
    .map((window) => ({
      window,
      behindAccountGeneration: window.observedCredentialGeneration < account.credentialGeneration,
    }));
}

/**
 * Whether a candidate reading replaces the one currently held for its limit.
 *
 * ORDERED BY THE MOMENT AND NEVER BY THE TEXT. Two RFC 3339 stamps naming one instant
 * differ as strings the moment one carries an offset and the other a `Z`, and a
 * `+01:00` stamp sorts AFTER the `Z` stamp it precedes — so a text comparison would
 * keep the older reading whenever a provider changed how it spells a time. The tie
 * the `source` rule breaks is a tie of MOMENTS for the same reason: two spellings of
 * one instant are one reading arriving twice, not a newer reading superseding an
 * older, and only the moment comparison says so.
 */
function supersedes(
  candidate: ProviderAccountUsageWindow,
  held: ProviderAccountUsageWindow,
): boolean {
  const ordering = compareInstants(
    parseInstant(candidate.observedAt),
    parseInstant(held.observedAt),
  );
  if (ordering !== 0) {
    return ordering > 0;
  }
  return candidate.source === "probe" && held.source !== "probe";
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
 * The readiness entry for one provider, or `undefined` where the reply carried none.
 *
 * The reply is required to carry exactly one entry per provider it selected, so an
 * absence here is a reply that did not do what the contract says. It is answered with
 * `undefined` rather than a fabricated `indeterminate`, because a state this console
 * invented would be indistinguishable on screen from one the daemon computed.
 */
export function readinessForProvider(
  reply: ProviderAccountListResponse,
  provider: ProviderAccount["provider"],
): ProviderAccountListResponse["readiness"][number] | undefined {
  return reply.readiness.find((entry) => entry.provider === provider);
}
