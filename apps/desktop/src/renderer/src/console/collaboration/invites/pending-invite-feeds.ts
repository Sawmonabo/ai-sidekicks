// The deep-link lifecycle's conversation with the growth port: two feeds, opened,
// drained, and re-openable.
//
// SPLIT FROM `pending-invite.ts`, on the split `bridge/queue/queue-subscription.ts`
// and `bridge/queue/queue-reading.ts` already make: this module never holds a queue, a
// latch, or a watcher, and that one never opens a stream or names an operation. What
// crosses between them is three callbacks and one refusal.
//
// RE-OPENABLE IS THE WHOLE REASON THIS IS NOT ONE `SUBSCRIBE` AND ONE `FOR AWAIT`. An
// open that failed on the transport, and a feed whose iteration ENDED, both leave the
// window holding no channel for an invitation that has not arrived yet — and nothing
// on screen can say so, because an invitation nobody sent and one nobody could deliver
// look identical from here. So each feed's field is cleared when its drain ends, and
// the reading above asks again on the triggers `store/read-triggers.ts` names.
//
// WHY THE OUTCOME FEED OPENS FIRST. The answer channel has to exist before the first
// invitation can be confirmed on screen; opening them the other way round leaves a
// window that can dispatch an act whose answer has nowhere to land.
//
// THE REFUSAL DESCRIBES THE CHANNEL'S STATE NOW AND NOT ITS HISTORY, so it is retired
// the moment both feeds are up — both, never the one that was repaired, because the
// field has no per-feed identity and clearing it on a sibling's success would report a
// channel up while half of it is still down; `#retireRefusalWhenBothFeedsAreUp` is the
// one place that happens. Nothing above this module can do it instead: `Spec-002
// §Required Behavior` makes declining IMPLICIT — the invitee simply never follows the
// link, and no `declined` state is required — so there is no decline verb for a surface
// to offer, and that section gives this delivery channel no durable receipt either: no
// event says the feed came back and no act answers it. A stale banner therefore has
// nothing on screen to correct it and no record to contradict it, and the adapter that
// recorded the outage is the only thing that can end it.

import {
  isUnbuiltWireRefusal,
  type ConsoleBridge,
  type GrowthInviteOutcome,
  type GrowthOutcome,
  type GrowthPendingInvite,
  type GrowthStream,
} from "../../bridge/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import type { ConsoleRefusal } from "../../core/index.js";

/** The refusal origin every failure of this lifecycle carries. */
export const PENDING_INVITE_ORIGIN = "pending-invite";

/** What the reading above this one wants told. */
export interface PendingInviteFeedSinks {
  /** One invitation arrived on the pending feed. */
  readonly onInvite: (invite: GrowthPendingInvite) => void;
  /** One attempt's answer arrived on the outcome feed. */
  readonly onOutcome: (outcome: GrowthInviteOutcome) => void;
  /** A feed's refusal changed. Nothing else about this module is watchable. */
  readonly onRefusalChanged: () => void;
}

/**
 * Both growth subscriptions the deep-link lifecycle reads, as one openable pair.
 *
 * A class with private fields because it owns two live streams and therefore a
 * teardown, and because whether it is open is a question the reading above asks on
 * every repair trigger.
 */
export class PendingInviteFeeds {
  readonly #bridge: ConsoleBridge;
  readonly #sinks: PendingInviteFeedSinks;
  #pendingFeed: GrowthStream<GrowthPendingInvite> | undefined;
  #outcomeFeed: GrowthStream<GrowthInviteOutcome> | undefined;
  #refusal: ConsoleRefusal | undefined;
  #isOpening = false;
  #isClosed = false;

  public constructor(bridge: ConsoleBridge, sinks: PendingInviteFeedSinks) {
    this.#bridge = bridge;
    this.#sinks = sinks;
  }

  /**
   * A feed that could not be opened, where opening FAILED.
   *
   * A build with no wire for the namespace is deliberately absent: that is the "not
   * checked" refusal every unbuilt growth row answers with, and a surface drawing it
   * would carry a permanent banner about a channel nobody opened.
   *
   * It describes the channel's state NOW and not its history, so it is retired the
   * moment both feeds are up again — see `#retireRefusalWhenBothFeedsAreUp`.
   */
  public get refusal(): ConsoleRefusal | undefined {
    return this.#refusal;
  }

  /**
   * Open whichever feed is not up. Idempotent, and does nothing once closed.
   *
   * The promise settles when the opening has finished rather than when it was asked
   * for, so the scheduler above can hold one attempt open and coalesce the triggers
   * that arrive under it instead of counting each as a read it already performed.
   */
  public async open(): Promise<void> {
    await this.#openClosedFeeds();
  }

  /** Close both feeds. Terminal: a closed pair opens nothing again. */
  public close(): void {
    this.#isClosed = true;
    this.#pendingFeed?.close();
    this.#outcomeFeed?.close();
    this.#pendingFeed = undefined;
    this.#outcomeFeed = undefined;
  }

  async #openClosedFeeds(): Promise<void> {
    if (this.#isOpening || this.#isClosed) {
      return;
    }
    this.#isOpening = true;
    try {
      if (this.#outcomeFeed === undefined) {
        await this.#openOutcomeFeed();
      }
      if (this.#pendingFeed === undefined) {
        await this.#openPendingFeed();
      }
      this.#retireRefusalWhenBothFeedsAreUp();
    } finally {
      this.#isOpening = false;
    }
  }

  /**
   * Forget a recorded failure once both feeds are up again.
   *
   * WITHOUT THIS THE BANNER IS PERMANENT. `#refusal` is written and never cleared, so
   * one throw on one feed leaves the reading above drawing "this channel is down" for
   * the life of the adapter — including after the repair triggers
   * `store/read-triggers.ts` names have re-opened the very feed that failed. The
   * refusal is a claim about a channel, and a channel that is back makes the claim
   * false; a surface that keeps it is telling a person about an outage that has ended.
   *
   * BOTH FEEDS, AND NOT THE ONE THAT WAS REPAIRED. The refusal has no per-feed
   * identity — one field, written by whichever open or drain failed — so clearing it
   * while the other feed is still down would report a channel up on the strength of
   * its sibling. Both open is the only state that makes the claim false, and a pass
   * that opened one and failed the other leaves the field exactly where it was,
   * because the failing half wrote it again on its way through.
   */
  #retireRefusalWhenBothFeedsAreUp(): void {
    if (this.#refusal === undefined || this.#isClosed) {
      return;
    }
    if (this.#outcomeFeed === undefined || this.#pendingFeed === undefined) {
      return;
    }
    this.#refusal = undefined;
    this.#sinks.onRefusalChanged();
  }

  async #openOutcomeFeed(): Promise<void> {
    const feed = await this.#openFeed(
      async () => await this.#bridge.growth.inviteOutcomeSubscribe({}),
    );
    if (feed === undefined) {
      return;
    }
    this.#outcomeFeed = feed;
    void this.#drain(feed, this.#sinks.onOutcome, () => {
      if (this.#outcomeFeed === feed) {
        this.#outcomeFeed = undefined;
      }
    });
  }

  async #openPendingFeed(): Promise<void> {
    const feed = await this.#openFeed(
      async () => await this.#bridge.growth.invitePendingSubscribe({}),
    );
    if (feed === undefined) {
      return;
    }
    this.#pendingFeed = feed;
    void this.#drain(feed, this.#sinks.onInvite, () => {
      if (this.#pendingFeed === feed) {
        this.#pendingFeed = undefined;
      }
    });
  }

  /**
   * Read one feed to its end, then release it so a later trigger can open a fresh one.
   *
   * A PRODUCER THAT THREW PART-WAY IS THE THIRD WAY A FEED ENDS, and the only one a
   * person is owed a sentence about. Without the `catch` the drain — invoked as a
   * floating `void` — settles as an unhandled rejection: {@link refusal} stays
   * undefined, the surface above keeps drawing a channel that is down, and the
   * handle is never closed, so the subscription and the producer behind it outlive
   * the window's reading of them. `browser/pane/navigation-state.ts` closes the same
   * failure the same way, and this follows it: the handle goes first and
   * unconditionally, then the refusal reaches the reading above through the one
   * grammar this module has, then `release()` clears the field so the next trigger
   * can open a fresh feed rather than finding this dead one still installed.
   */
  async #drain<TEvent>(
    feed: GrowthStream<TEvent>,
    apply: (event: TEvent) => void,
    release: () => void,
  ): Promise<void> {
    try {
      for await (const event of feed.events) {
        if (this.#isClosed) {
          return;
        }
        apply(event);
      }
    } catch (failure: unknown) {
      feed.close();
      this.#noteRefusal(consoleRefusalFrom(failure, PENDING_INVITE_ORIGIN));
    } finally {
      release();
    }
  }

  /**
   * Open one feed, or record why there is none.
   *
   * Both feeds share this because both fail the same three ways — refused, rejected,
   * or torn down under the open — and a second copy of that reading would be a second
   * vocabulary for one seam's failures.
   */
  async #openFeed<TEvent>(
    open: () => Promise<GrowthOutcome<GrowthStream<TEvent>>>,
  ): Promise<GrowthStream<TEvent> | undefined> {
    let outcome: GrowthOutcome<GrowthStream<TEvent>>;
    try {
      outcome = await open();
    } catch (rejection: unknown) {
      this.#noteRefusal(consoleRefusalFrom(rejection, PENDING_INVITE_ORIGIN));
      return undefined;
    }
    if (this.#isClosed) {
      if (outcome.status === "served") {
        outcome.value.close();
      }
      return undefined;
    }
    if (outcome.status !== "served") {
      this.#noteRefusal(outcome);
      return undefined;
    }
    return outcome.value;
  }

  /**
   * Record a feed failure, unless it is the console never having asked.
   *
   * `isUnbuiltWireRefusal` is the console's one reading of that difference, and it is
   * consulted rather than re-derived: a build with no wire for this namespace has not
   * failed at anything, and rendering it as a failure would tell a person a channel is
   * down that was never opened.
   */
  #noteRefusal(refusal: ConsoleRefusal): void {
    if (isUnbuiltWireRefusal(refusal)) {
      return;
    }
    this.#refusal = refusal;
    this.#sinks.onRefusalChanged();
  }
}
