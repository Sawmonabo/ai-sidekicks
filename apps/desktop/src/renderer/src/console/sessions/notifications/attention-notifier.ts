// The one caller of `native.showNotification`.
//
// OS emission belongs to the notification center, and until now the console had none:
// the centre rendered the projection and nothing ever left the window. A person with
// the console behind another application learned that a run had failed by coming back
// and looking.
//
// WHEN ONE IS RAISED, and the whole of it:
//
//   • The item is LIVE. A resolved item is already dropped by the plane, so nothing
//     here re-checks `resolvedAt`; what reaches this class is what needs a person.
//   • The EVENT is NEW TO THIS WINDOW. What is remembered is the canonical event an
//     item was raised by, not the item's own id, so a re-read that returns the same
//     projection raises nothing and a reconnect catch-up burst raises each of its
//     events once. `ATTENTION_NOTIFIED_ITEM_CAP` bounds that memory over the events
//     that have CLEARED and never over the ones a read still returns — a cap that
//     could drop a live one would make every refresh re-announce the projection.
//
//     KEYED ON THE EVENT BECAUSE ONE EVENT IS ONE THING THAT HAPPENED. A projection
//     carries a run-scoped item AND its session aggregate over the same
//     `sourceEventId`, because the aggregate is derived from its contributors and
//     takes the representative's event — so one run beginning to wait produced
//     two distinct item ids, both new, and this class raised two banners for it. An
//     id-keyed memory cannot see that they are the same news; the event they name
//     is exactly what says so. Excluding the aggregate instead would have been the
//     narrower fix and the wrong one: a session-scoped item is not always an
//     aggregate over runs, and a rule that dropped every item without a `runId`
//     would silence the ones that are nobody's run.
//   • The item is NOT already on screen. Interrupting someone about the thing in
//     front of them is the one case where the banner is strictly worse than silence,
//     and a focused window is on screen in two different ways: it may be parked on
//     the item's own session, and it may be on the destination that renders EVERY
//     session's attention. An unfocused window announces everything, including the
//     session it is parked on, because nobody is reading it.
//
// AND THE FIRST SETTLED READ OF A SESSION RAISES NOTHING FOR IT. Opening a window is
// not an event: the projection's first answer about a session is the state of the
// world as this window found it, and announcing it would fire a banner per
// outstanding approval every time somebody opened the console.
//
// PER SESSION, AND NOT ONCE FOR THE WINDOW, because the two halves of the address set
// do not settle together. A window opened directly on one session reads that session's
// attention immediately, while the node's directory — which is where every OTHER
// session this window can name comes from — answers later. One flag for the whole
// window took the first of those as the baseline for all of them, so every session the
// directory added afterwards arrived already baselined: its standing approvals, its
// waiting input requests, and its failed runs were measured against a read that had
// never covered it, and a person who opened a window got an OS banner for each of them
// seconds after the console appeared.
//
// So what is remembered is a SET of session ids, and a session's items may announce
// only from the read AFTER the one that first covered it. The set is re-derived
// against every settled read, which is what makes a session leaving the address set
// forget its baseline: the events it was known by are evictable the moment they stop
// being live, so a session that comes back after its events have been forgotten would
// otherwise have its whole standing projection announced as arrivals.
//
// WHAT THIS CLASS DELIBERATELY DOES NOT DO. It applies no preference filter and no
// quiet-hours rule. Non-matching events are dropped at the control plane before they
// are ever emitted, and the shell honours the OS do-not-disturb setting, so either one
// re-implemented here would be a second authority over a decision already made — and
// a second authority that cannot see the inputs the first one had.

import { useEffect, useState } from "react";

import { ATTENTION_NOTIFIED_ITEM_CAP } from "../../core/index.js";
import type { AttentionItem, ConsoleBridge } from "../../bridge/index.js";
import { routeSessionId } from "../../routing/index.js";
import type { FrameStore } from "../../store/index.js";
import { type AnsweredAttentionReading, type AttentionReading } from "./attention-plane.js";
import { type OsNotificationDelivery } from "./os-notification-delivery.js";

/** What the window looks like at the moment a projection settles. */
export interface AttentionNotifierAudience {
  /** The session the route names, or `undefined` where it names none. */
  readonly activeSessionId: string | undefined;
  /**
   * Whether the route names the destination that renders the notification centre.
   *
   * A SECOND MEMBER RATHER THAN A SECOND READING OF THE FIRST, because there is no
   * session id that describes this window. The sessions destination names no session,
   * so {@link activeSessionId} is `undefined` there — and an audience rule that
   * inferred visibility from a session id alone answered "nothing is on screen" for
   * the one screen showing every session's attention at once, and raised a banner
   * about each item the person was already looking at.
   */
  readonly isAttentionSurfaceRouted: boolean;
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
 *
 * TWO MEMORIES AND NOT ONE, because they answer different questions and are bounded
 * by different things. The events are what this window has already told somebody
 * about, bounded by a cap over the ones that have cleared. The baselined sessions are
 * which sessions it has watched long enough to call an item news, bounded by the
 * address set itself — every read drops the ids that read did not ask about, so this
 * set is never larger than the sessions the window can name.
 */
export class AttentionNotifier {
  readonly #announcedSourceEventIds = new Set<string>();
  readonly #baselinedSessionIds = new Set<string>();

  /**
   * Fold one settled projection into the items this window should announce.
   *
   * TAKES THE WHOLE SETTLED READ rather than its items, so its three answers come off
   * ONE fan-out. What the read contained, which sessions it asked about, and which of
   * those refused are three facts about one settlement, and a caller composing them
   * from separate holdings could pair this read's items with the address set of the
   * next one — which is the shape the audience rule beside this already avoids by
   * taking a single snapshot of the window.
   *
   * AT MOST ONE ARRIVAL PER CANONICAL EVENT. Two items over one `sourceEventId` are
   * two views of one thing that happened — the run-scoped item and the session
   * aggregate that represents it are exactly that pair — so the first of them stands
   * for both and the rest are folded into it silently. Which one comes first is the
   * projection's order and it changes nothing a person sees: items sharing an event
   * share its session too, so the audience rule below answers the same either way.
   *
   * AND ONLY FROM A SESSION THIS WINDOW HAS ALREADY COVERED. The baseline is read
   * BEFORE this read re-derives it, so a session appearing in the address set for the
   * first time has its whole standing projection remembered and announced for none of
   * it, and the next read is the first one whose arrivals for that session are news.
   * An item naming a session outside the covered set is held back the same way and for
   * the same reason: a read that did not cover a session cannot say whether its items
   * just happened.
   *
   * Every live event is remembered whether or not it is announced — an item the
   * audience rule held back is still news this window has seen, and announcing it
   * later because the person happened to navigate elsewhere would be a banner about
   * something that did not just happen.
   *
   * The projection's own events are collected as the fold runs, because what the cap
   * may forget afterwards is decided against THIS read and never against the
   * remembered set alone — the rule the eviction below states.
   */
  public arrivalsToAnnounce(
    reading: AnsweredAttentionReading,
    audience: AttentionNotifierAudience,
  ): readonly AttentionItem[] {
    const liveSourceEventIds = new Set<string>();
    const arrivals: AttentionItem[] = [];
    for (const item of reading.plane.liveItems) {
      liveSourceEventIds.add(item.sourceEventId);
      if (this.#announcedSourceEventIds.has(item.sourceEventId)) {
        continue;
      }
      this.#announcedSourceEventIds.add(item.sourceEventId);
      if (this.#baselinedSessionIds.has(item.sessionId) && this.#reachesAPerson(item, audience)) {
        arrivals.push(item);
      }
    }
    this.#rebaselineAgainstTheAddressSet(reading);
    this.#forgetClearedSourceEventIdsOverTheCap(liveSourceEventIds);
    return arrivals;
  }

  /**
   * Bring the baselined sessions into line with the read that just settled.
   *
   * TWO MOVES, AND THE ORDER BETWEEN THEM DOES NOT MATTER because they act on
   * disjoint ids. A session this read did not ASK about is dropped, and a session it
   * asked about and got an answer for is added.
   *
   * A REFUSED SESSION IS NEITHER, and that is the whole reason the refusals are read
   * here. It was asked, so it has not left the address set and keeps whatever
   * baseline it had — forgetting it would re-announce its standing projection the
   * moment the read recovered, which is the same mistake the eviction below refuses
   * to make with its cleared events. And it was not answered, so a session whose
   * FIRST read refused is not baselined by that refusal: this window still has not
   * been told what it holds.
   *
   * The drop is what makes a session leaving and rejoining the address set safe. Its
   * remembered events are cleared from the moment it goes, so the cap may forget them
   * while it is away — and a window that kept the baseline would then meet the same
   * standing items as arrivals and announce every one of them.
   */
  #rebaselineAgainstTheAddressSet(reading: AnsweredAttentionReading): void {
    const addressedSessionIds = new Set(reading.addressedSessionIds);
    for (const baselinedSessionId of this.#baselinedSessionIds) {
      if (!addressedSessionIds.has(baselinedSessionId)) {
        this.#baselinedSessionIds.delete(baselinedSessionId);
      }
    }
    const refusedSessionIds = new Set(
      reading.refusedSessions.map((refusedSession) => refusedSession.sessionId),
    );
    for (const addressedSessionId of addressedSessionIds) {
      if (!refusedSessionIds.has(addressedSessionId)) {
        this.#baselinedSessionIds.add(addressedSessionId);
      }
    }
  }

  /**
   * Whether a banner about this item tells its reader something the screen does not.
   *
   * Three answers over two facts, in the order they stop being questions. Nobody is
   * reading an unfocused window, so it announces everything. A focused window sitting
   * on the notification centre is already showing every session's attention, so it
   * announces nothing — the case that has no session id to compare against, and the
   * one this rule used to get exactly backwards. Anywhere else, the route names at
   * most one session and only that session's items are already in front of a person.
   */
  #reachesAPerson(item: AttentionItem, audience: AttentionNotifierAudience): boolean {
    if (!audience.isWindowFocused) {
      return true;
    }
    if (audience.isAttentionSurfaceRouted) {
      return false;
    }
    return item.sessionId !== audience.activeSessionId;
  }

  /**
   * Bring the remembered events back under the cap by forgetting CLEARED ones, oldest
   * first.
   *
   * AN EVENT IN THE CURRENT PROJECTION IS NEVER FORGOTTEN, and that is the whole rule.
   * The eviction used to run over the remembered set alone, so a projection larger
   * than the cap evicted the very entries it was in the middle of remembering: adding
   * one dropped the next live one, the following read found that one missing and
   * raised a banner for it, and the drop walked on. A window holding 201 unresolved
   * items re-announced its entire projection on every refresh, for as long as the
   * items stayed unresolved — which is precisely as long as they matter.
   *
   * So the cap bounds what this window remembers about news that has CLEARED, not
   * what it remembers about news still standing. Where the live set alone exceeds the
   * cap the remembered set stays above it, deliberately: the alternative is a banner
   * about something the projection is still showing, and a memory proportional to a
   * projection the daemon itself bounds is the cheaper of the two costs.
   *
   * Cleared events are kept while there is room under the cap rather than dropped on
   * sight, because a fan-out read that refused for one session answers without that
   * session's items — and forgetting them would re-announce every one of them the
   * moment the read recovered.
   */
  #forgetClearedSourceEventIdsOverTheCap(liveSourceEventIds: ReadonlySet<string>): void {
    for (const rememberedSourceEventId of this.#announcedSourceEventIds) {
      if (this.#announcedSourceEventIds.size <= ATTENTION_NOTIFIED_ITEM_CAP) {
        return;
      }
      if (!liveSourceEventIds.has(rememberedSourceEventId)) {
        this.#announcedSourceEventIds.delete(rememberedSourceEventId);
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
  // React may discard, and a discarded notifier forgets every event it has announced
  // and re-raises the whole projection on the next settlement.
  const [notifier] = useState(() => new AttentionNotifier());
  const isWithheld = delivery.status === "withheld";
  useEffect(() => {
    if (reading.phase !== "read") {
      return;
    }
    const arrivals = notifier.arrivalsToAnnounce(reading, audienceFor(frameStore));
    if (isWithheld) {
      // Remembered and not raised. The read says this machine will show nothing, so
      // the call is spent for no one — and the events are still taken, because a
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

/**
 * What this window is putting in front of a person, at the moment a read settles.
 *
 * ONE SNAPSHOT AND TWO ANSWERS OFF IT, rather than two reads of the store. Both
 * route-derived members come from the same `route`, so a navigation landing between
 * two reads cannot compose an audience describing a window that never existed — the
 * shape this replaced took the session id through one getter and the focus flag
 * through a second `getState()`.
 *
 * The destination is read as the route's own kind rather than through
 * `railDestinationFor`, which folds a workspace route onto the sessions rail too: a
 * person in a workspace is looking at one session's timeline, not at the centre that
 * lists every session's attention, and suppressing their banners would be the
 * over-broad half of the same mistake this rule exists to correct.
 */
function audienceFor(frameStore: FrameStore): AttentionNotifierAudience {
  const { isWindowFocused, route } = frameStore.getState();
  return {
    activeSessionId: routeSessionId(route),
    isAttentionSurfaceRouted: route.kind === "sessions",
    isWindowFocused,
  };
}
