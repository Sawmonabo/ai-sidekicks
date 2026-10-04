// Which attention items are news, and what has been announced already. The operating-system
// banner is raised by the main process while the app is not in front, so nothing here checks
// window focus or screen.
//
// An item is new when it is live (the summary already drops resolved items) and its canonical
// event is new to this window. Memory is keyed on the event, not the item id: a projection
// carries a run-scoped item and its session aggregate over the same `sourceEventId`, and an
// id-keyed memory would raise two banners for one thing that happened. Dropping the aggregate
// instead would silence session-scoped items that belong to no run.
//
// The first settled read of a session raises nothing for it: opening a window is not an event,
// and announcing the standing projection would fire a banner per outstanding approval. This is
// per session, not per window, because a window opened on one session reads that session
// before the service's directory adds the others, and one window-wide baseline would treat every
// later session as already baselined. A session's items may announce only from the read after
// the one that first covered it, and the set is re-derived on every settled read so a session
// that leaves the address set forgets its baseline.
//
// Switches and quiet hours are not applied here: the daemon decides whether a moment may raise
// a banner when it writes the entry, and the main process honors the OS do-not-disturb setting.

import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import { type AnsweredAttentionReading } from "./attention-summary.js";

/**
 * Attention events the notifier remembers having announced.
 *
 * The projection is re-read for the life of a window, so the memory is bounded. Two hundred is
 * roughly two orders of magnitude above what a person has open at once, so an evicted id is
 * one whose item cleared long ago; the cap may err toward a duplicate banner, never a lost one.
 */
export const ATTENTION_NOTIFIED_ITEM_CAP = 200;

/**
 * Which items are news to a window, and what it has announced already.
 *
 * A `Set` iterates in insertion order, so walking it is walking the remembered ids oldest
 * first. Two memories, bounded differently: announced events (capped over the cleared ones)
 * and baselined sessions (never larger than the address set, since each read drops the ids it
 * did not ask about).
 */
export class AttentionNotifier {
  readonly #announcedSourceEventIds = new Set<string>();
  readonly #baselinedSessionIds = new Set<string>();

  /**
   * Folds one settled projection into the items this window should announce.
   *
   * Takes the whole settled read so the items, the address set and the refusals come off one
   * fan-out. At most one arrival per canonical event: items sharing a `sourceEventId` (a run
   * item and its session aggregate) are one thing that happened, so the first stands for
   * both. Only sessions the window already covered announce; the baseline is read before this
   * read re-derives it, so a newly addressed session's standing projection is remembered but
   * not announced. Every live event is remembered whether or not it was announced, and the
   * cap never forgets an event this read returned.
   */
  public arrivalsToAnnounce(reading: AnsweredAttentionReading): readonly AttentionItem[] {
    const liveSourceEventIds = new Set<string>();
    const arrivals: AttentionItem[] = [];
    for (const item of reading.summary.liveItems) {
      liveSourceEventIds.add(item.sourceEventId);
      if (this.#announcedSourceEventIds.has(item.sourceEventId)) {
        continue;
      }
      this.#announcedSourceEventIds.add(item.sourceEventId);
      if (this.#baselinedSessionIds.has(item.sessionId)) {
        arrivals.push(item);
      }
    }
    this.#rebaselineAgainstTheAddressSet(reading);
    this.#forgetClearedSourceEventIdsOverTheCap(liveSourceEventIds);
    return arrivals;
  }

  /**
   * Brings the baselined sessions into line with the read that just settled.
   *
   * A session this read did not ask about is dropped, so a session that leaves and rejoins
   * does not meet its standing items as arrivals after the cap forgot them. A session it
   * asked about and got an answer for is added. A refused session is neither: it keeps any
   * baseline it had, and a session whose first read refused is not baselined by the refusal.
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
   * Brings the remembered events back under the cap by forgetting cleared ones, oldest first.
   *
   * An event in the current projection is never forgotten: evicting live entries made a
   * projection larger than the cap re-announce itself on every refresh. Where the live set
   * alone exceeds the cap the memory stays above it, which is cheaper than a banner for
   * something still showing. Cleared events are kept while there is room, because a fan-out
   * that refused one session answers without its items and would re-announce them on recovery.
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
