// What a watcher of the account-plane reading sees, and the parts it is made of.
//
// This declares what every view in the window renders from the account plane: the quota rows,
// the registry's account list and its readiness projection, three folds of one reply. It is
// pure: composition opens no tail, takes no read, and calls nothing back.

import type {
  ProviderAccount,
  ProviderAccountUsageWindow,
  ProviderReadiness,
} from "@ai-sidekicks/contracts/provider-account";

import type { UnreadableDeliveryReading } from "@renderer/services/wire-reads/unreadable-deliveries.js";
import type { WireReadState } from "@renderer/services/wire-reads/read-lifecycle.js";
import type { ProviderLoginCompletion } from "@renderer/services/provider-accounts/provider-account-deliveries.js";
import type { ProviderAccountFold } from "@renderer/store/provider-accounts/provider-account-fold.js";

/**
 * The empty projection, named once so an unread registry shares one frozen array.
 *
 * @consumedBy the Providers settings page's quota readout
 */
export const NO_READINESS: readonly ProviderReadiness[] = Object.freeze([]);

/** What the account plane answered, and why it did not where it did not. */
export interface ProviderAccountReadout extends UnreadableDeliveryReading, WireReadState {
  /**
   * Every account the registry carries, `accountId` to `displayLabel`.
   *
   * Folded from the same read and tail as the quota rows, so a view naming a paying account
   * needs no second fetch. Empty until the read has served: a missing entry means "not
   * read", not "no such account", and a consumer renders nothing for one rather than
   * falling back to the handle.
   */
  readonly accountLabels: ReadonlyMap<string, string>;
  /**
   * Every account the registry carries, whole, in the order the daemon sent them.
   *
   * This window has one reader of the registry. `providerAccount.list` answers with the
   * accounts, the readiness projection and the quota rows in one snapshot, so a page taking
   * its own read would be a second reading of one registry with a second arrival order.
   * Empty until the read has served, so an absent row means "not read".
   */
  readonly accounts: readonly ProviderAccount[];
  /**
   * What run admission would answer for each provider, as the last read computed it.
   *
   * Read-time, not folded from the tail: the projection is the daemon's, derived by the same
   * resolution the spawn path performs, and the subscription carries no readiness frame. A
   * re-read keeps it current, which is why a settled sign-in asks for one.
   */
  readonly readiness: readonly ProviderReadiness[];
  /**
   * The quota rows the fold currently holds, one per `(accountId, limitId)`.
   *
   * The wire rows, already superseded: a consumer renders them as they came and folds them
   * no further, because a second supersession rule downstream would drift from the first
   * with both views still rendering.
   */
  readonly usageWindows: readonly ProviderAccountUsageWindow[];
  /**
   * The newest brokered sign-in the tail reported finished, correlated by `attemptId`.
   *
   * A report, never a verdict: the provider's flow ended, not necessarily authenticated. The
   * view that started an attempt needs it to release its single-flight claim, since a
   * refused cancellation establishes nothing.
   */
  readonly newestLoginCompletion: ProviderLoginCompletion | undefined;
}

/** What the tail contributes to a readout, beside the fold it has been applied to. */
export interface ProviderAccountDeliveryReading {
  /** What the tail could not read. */
  readonly unreadable: UnreadableDeliveryReading;
  /** The newest brokered sign-in the tail reported finished. */
  readonly newestLoginCompletion: ProviderLoginCompletion | undefined;
}

/** The things a readout is composed from, named so no caller passes a reading. */
export interface ProviderAccountReadoutParts {
  /** Which reading is current for each key, and every account the registry carries. */
  readonly fold: ProviderAccountFold;
  /**
   * What the deliveries carry that the fold does not hold.
   *
   * The whole delivery reading rather than one member of it, so a later tail member does
   * not widen the composer's signature.
   */
  readonly deliveries: ProviderAccountDeliveryReading;
  /** How the newest read went, from the reading's own lifecycle. */
  readonly readState: WireReadState;
  /** The projection the newest served read carried. Never folded from the tail. */
  readonly readiness: readonly ProviderReadiness[];
}

/**
 * Compose one readout.
 *
 * The two spreads go first so a member either carries cannot be overwritten by the folds
 * below; neither declares one.
 *
 * @consumedBy the Providers settings page's quota readout
 */
export function composeProviderAccountReadout(
  parts: ProviderAccountReadoutParts,
): ProviderAccountReadout {
  const { fold, deliveries, readState, readiness } = parts;
  return {
    ...deliveries.unreadable,
    ...readState,
    accountLabels: fold.accountLabels(),
    accounts: fold.accounts(),
    readiness,
    usageWindows: fold.usageWindows(),
    newestLoginCompletion: deliveries.newestLoginCompletion,
  };
}
