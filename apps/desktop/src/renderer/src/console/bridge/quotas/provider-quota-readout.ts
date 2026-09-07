// What a watcher of the account-plane reading sees, and the parts it is made of.
//
// SPLIT OFF THE WIRE, which is the same cut this family already makes twice.
// `provider-account-quota.ts` owns opening the tail, taking the read, and deciding
// which reply may seat anything; this module owns the SHAPE that leaves it. The two
// were one file until the readout grew the registry's whole account list and its
// readiness projection beside the quota readings — three folds of one reply — and a
// module that both drives a wire and declares what every surface in the window renders
// is doing two jobs.
//
// PURE, AND THAT IS THE POINT. Composition takes the fold, the delivery arm, the read
// state and the readiness projection and returns one object; it reads no field of the
// reading and calls nothing back, so what a watcher sees is decided in one place a
// test can drive with no bridge.

import type {
  ProviderAccount,
  ProviderAccountUsageWindow,
  ProviderReadiness,
} from "@ai-sidekicks/contracts";

import type { UnreadableDeliveryReading, WireReadState } from "../readings/index.js";
import type { ProviderQuotaFold, ProviderQuotaReading } from "./provider-quota-fold.js";

/** The empty projection, named once so an unread registry shares one frozen array. */
export const NO_READINESS: readonly ProviderReadiness[] = Object.freeze([]);

/** What the account plane answered, and why it did not where it did not. */
export interface ProviderQuotaReadout extends UnreadableDeliveryReading, WireReadState {
  /** One reading per `(accountId, limitId)`, ordered by account then limit label. */
  readonly readings: readonly ProviderQuotaReading[];
  /**
   * Every account the registry carries, `accountId` to `displayLabel`.
   *
   * The same read and the same tail that feed the readings, folded a second way
   * rather than fetched a second time: any surface that names a paying account holds
   * the daemon-minted handle and needs the operator's word for it, and this window
   * has exactly one reader of the account plane. Empty until the read has served,
   * which is what makes a missing entry mean "not read" rather than "no such
   * account" — a consumer renders nothing for one rather than falling back to the
   * handle.
   */
  readonly accountLabels: ReadonlyMap<string, string>;
  /**
   * Every account the registry carries, whole, in the order the daemon sent them.
   *
   * THE REGISTRY HAS ONE READER IN THIS WINDOW AND THIS IS IT. A settings surface
   * listing the accounts asks the same question of the same wire as the chips do —
   * `providerAccount.list` answers with the accounts, the readiness projection, and
   * the durable quota rows in one snapshot — so a page that took its own read would be
   * a second reading of one registry: two arrival orders, and no way to say which was
   * right when a removal or a token registration reached one of them first. Empty
   * until the read has served, which is what makes an absent row mean "not read"
   * rather than "no such account".
   */
  readonly accounts: readonly ProviderAccount[];
  /**
   * What run admission would answer for each provider, as the last READ computed it.
   *
   * READ-TIME AND DELIBERATELY NOT FOLDED FROM THE TAIL. The projection is the
   * daemon's, derived by the same resolution the spawn path performs, and the
   * subscription carries no readiness frame at all — so this is what the newest served
   * read said and never a value this console re-derived from an account row it saw
   * change. What keeps it current is a re-read, which is why a settled sign-in asks
   * for one.
   */
  readonly readiness: readonly ProviderReadiness[];
  /**
   * The quota rows the fold currently holds, one per `(accountId, limitId)`.
   *
   * The wire rows rather than {@link readings}, for the surface that renders a
   * window's own members — its source, its reset horizon, the generation it was
   * observed under. Superseded already, so a consumer folding them again by limit
   * reaches the same answer this fold did.
   */
  readonly usageWindows: readonly ProviderAccountUsageWindow[];
}

/** The four things a readout is composed from, named so no caller passes a reading. */
export interface ProviderQuotaReadoutParts {
  /** Which reading is current for each key, and every account the registry carries. */
  readonly fold: ProviderQuotaFold;
  /** What the tail could not read, from the deliveries that took the frames. */
  readonly unreadable: UnreadableDeliveryReading;
  /** How the newest read went, from the reading's own lifecycle. */
  readonly readState: WireReadState;
  /** The projection the newest SERVED read carried. Never folded from the tail. */
  readonly readiness: readonly ProviderReadiness[];
}

/**
 * Compose one readout.
 *
 * The two spreads go FIRST so a member either of them carries cannot be silently
 * overwritten by one of the folds below — and neither declares one, which is what
 * keeps that ordering a statement rather than a coincidence.
 */
export function composeProviderQuotaReadout(
  parts: ProviderQuotaReadoutParts,
): ProviderQuotaReadout {
  const { fold, unreadable, readState, readiness } = parts;
  return {
    ...unreadable,
    ...readState,
    readings: fold.readings(),
    accountLabels: fold.accountLabels(),
    accounts: fold.accounts(),
    readiness,
    usageWindows: fold.usageWindows(),
  };
}
