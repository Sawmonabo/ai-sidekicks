// The one caller of `native.showNotification`.
//
// `Spec-023 §Console Design (Meridian)` §Notification center names OS emission as
// this surface's, and until now the console had none: the centre rendered the
// projection and nothing ever left the window. A person with the console behind
// another application learned that a run had failed by coming back and looking.
//
// WHEN ONE IS RAISED, and the whole of it:
//
//   • The item is LIVE. A resolved item is already dropped by the plane, so nothing
//     here re-checks `resolvedAt`; what reaches this class is what needs a person.
//   • The item is NEW TO THIS WINDOW. Announced ids are remembered, so a re-read that
//     returns the same projection raises nothing and a reconnect catch-up burst raises
//     each of its items once. `ATTENTION_NOTIFIED_ITEM_CAP` bounds that memory over
//     the ids that have CLEARED and never over the ones a read still returns — a cap
//     that could drop a live id would make every refresh re-announce the projection.
//   • The item is NOT the session a focused window is looking at. Interrupting
//     someone about the thing on their screen is the one case where the banner is
//     strictly worse than silence. An unfocused window announces every session,
//     including the one it is parked on, because nobody is reading it.
//
// AND THE FIRST SETTLED READ RAISES NOTHING. Mounting the sessions destination is not
// an event: the projection's first answer is the state of the world as the surface
// found it, and announcing it would fire a banner per outstanding approval every time
// a person navigated to this screen. The baseline is taken from that first read and
// every later arrival is measured against it.
//
// WHAT THIS CLASS DELIBERATELY DOES NOT DO. It applies no preference filter and no
// quiet-hours rule. Non-matching events are dropped at the control plane before they
// are ever emitted (`Spec-019 §Desktop-to-Desktop Delivery`) and the shell honours the
// OS do-not-disturb setting (`Spec-023 §Main Process Responsibilities`), so either one
// re-implemented here would be a second authority over a decision already made — and
// a second authority that cannot see the inputs the first one had.

import { useEffect, useState } from "react";

import { ATTENTION_NOTIFIED_ITEM_CAP } from "../../core/index.js";
import type { AttentionItem, ConsoleBridge } from "../../bridge/index.js";
import type { FrameStore } from "../../store/index.js";
import { type AttentionReading } from "./attention-plane.js";
import { type OsNotificationDelivery } from "./os-notification-delivery.js";

/** What the window looks like at the moment a projection settles. */
export interface AttentionNotifierAudience {
  /** The session the route names, or `undefined` where it names none. */
  readonly activeSessionId: string | undefined;
  readonly isWindowFocused: boolean;
}

/**
 * Which items a window should announce, and what it has announced already.
 *
 * An encapsulated class rather than a ref beside an effect, because "already
 * announced" is state with an eviction rule and a baseline, and a hook body that grew
 * all three would be the third place in this subtree where a read's history was
 * re-derived on every render.
 *
 * Insertion order carries the eviction: a `Set` iterates in insertion order, so
 * walking it is walking the remembered ids oldest first and no second structure is
 * needed to know which to drop.
 */
export class AttentionNotifier {
  readonly #announcedItemIds = new Set<string>();
  #hasBaseline = false;

  /**
   * Fold one settled projection into the items this window should announce.
   *
   * Every live id is remembered whether or not it is announced — an item the audience
   * rule held back is still an item this window has seen, and announcing it later
   * because the person happened to focus a different session would be a banner about
   * something that did not just happen.
   *
   * The projection's own ids are collected as the fold runs, because what the cap may
   * forget afterwards is decided against THIS read and never against the remembered
   * set alone — the rule the eviction below states.
   */
  public arrivalsToAnnounce(
    liveItems: readonly AttentionItem[],
    audience: AttentionNotifierAudience,
  ): readonly AttentionItem[] {
    const announceable = this.#hasBaseline;
    this.#hasBaseline = true;
    const liveItemIds = new Set<string>();
    const arrivals: AttentionItem[] = [];
    for (const item of liveItems) {
      liveItemIds.add(item.id);
      if (this.#announcedItemIds.has(item.id)) {
        continue;
      }
      this.#announcedItemIds.add(item.id);
      if (announceable && this.#reachesAPerson(item, audience)) {
        arrivals.push(item);
      }
    }
    this.#forgetClearedItemIdsOverTheCap(liveItemIds);
    return arrivals;
  }

  /** Whether a banner about this item tells its reader something the screen does not. */
  #reachesAPerson(item: AttentionItem, audience: AttentionNotifierAudience): boolean {
    if (!audience.isWindowFocused) {
      return true;
    }
    return item.sessionId !== audience.activeSessionId;
  }

  /**
   * Bring the remembered ids back under the cap by forgetting CLEARED ones, oldest
   * first.
   *
   * AN ID IN THE CURRENT PROJECTION IS NEVER FORGOTTEN, and that is the whole rule.
   * The eviction used to run over the remembered set alone, so a projection larger
   * than the cap evicted the very ids it was in the middle of remembering: adding one
   * id dropped the next live one, the following read found that one missing and raised
   * a banner for it, and the drop walked on. A window holding 201 unresolved items
   * re-announced its entire projection on every refresh, for as long as the items
   * stayed unresolved — which is precisely as long as they matter.
   *
   * So the cap bounds what this window remembers about items that have CLEARED, not
   * what it remembers about items still standing. Where the live set alone exceeds the
   * cap the remembered set stays above it, deliberately: the alternative is a banner
   * about something the projection is still showing, and a memory proportional to a
   * projection the daemon itself bounds is the cheaper of the two costs.
   *
   * Cleared ids are kept while there is room under the cap rather than dropped on
   * sight, because a fan-out read that refused for one session answers without that
   * session's items — and forgetting them would re-announce every one of them the
   * moment the read recovered.
   */
  #forgetClearedItemIdsOverTheCap(liveItemIds: ReadonlySet<string>): void {
    for (const rememberedItemId of this.#announcedItemIds) {
      if (this.#announcedItemIds.size <= ATTENTION_NOTIFIED_ITEM_CAP) {
        return;
      }
      if (!liveItemIds.has(rememberedItemId)) {
        this.#announcedItemIds.delete(rememberedItemId);
      }
    }
  }
}

/**
 * Mount the emitter for as long as a destination holds the projection read.
 *
 * The audience is read IMPERATIVELY off the frame store rather than subscribed to,
 * and that is the difference between a rule and a re-render: what decides a banner is
 * where the window was when the item ARRIVED, so focus moving afterwards must change
 * nothing, and a subscription would both re-run this effect on every focus change and
 * make the answer depend on the last one instead of the right one.
 *
 * `NotificationOptions` CARRIES NO MEMBER YET, and that is a decision already made
 * elsewhere rather than a gap this surface may close: it is `packages/contracts`'
 * Tier-1 stub for Electron's own `NotificationConstructorOptions`, and its comment
 * schedules the real shape for the tier that gives that package an `electron` devDep.
 * So the call supplies the only value the contract admits. What a person reads on the
 * banner is the shell's to compose until then; the item's own words are on the centre
 * either way, and writing a title here would neither compile nor be this console's to
 * write.
 */
export function useAttentionNotifications(options: {
  readonly reading: AttentionReading;
  readonly delivery: OsNotificationDelivery;
  readonly frameStore: FrameStore;
  readonly bridge: ConsoleBridge;
}): void {
  const { bridge, delivery, frameStore, reading } = options;
  // Minted once per mount and held in state rather than in a memo: a memo is a hint
  // React may discard, and a discarded notifier forgets every id it has announced and
  // re-raises the whole projection on the next settlement.
  const [notifier] = useState(() => new AttentionNotifier());
  const isWithheld = delivery.status === "withheld";
  useEffect(() => {
    if (reading.phase !== "read") {
      return;
    }
    const arrivals = notifier.arrivalsToAnnounce(reading.plane.liveItems, {
      activeSessionId: frameStore.activeSessionId,
      isWindowFocused: frameStore.getState().isWindowFocused,
    });
    if (isWithheld) {
      // Remembered and not raised. The read says this machine will show nothing, so
      // the call is spent for no one — and the ids are still taken, because a
      // permission that is granted later must not replay a backlog as though every
      // one of those items had just arrived.
      return;
    }
    // One call per arrival rather than one per settlement, because the emission is
    // per item on the wire the blueprint names — so the day the options shape lands,
    // each of these calls is already the one that carries its own item's words.
    arrivals.forEach(() => {
      bridge.sidekicks.native.showNotification({});
    });
  }, [bridge, frameStore, isWithheld, notifier, reading]);
}
