// One session's queue reading: the feed every surface on it reads, the watchers it
// publishes to, and the scheduler that decides when to ask the daemon again.
//
// Split from `queue-feed.ts`, which is the window's REGISTRY of these readings and
// the React door onto one — a second job, and the one that decides how long a reading
// lives rather than what it says. The conversation with the daemon is
// `queue-subscription.ts` next door: this module never opens a stream or names a
// method, and that one never holds a listener.
//
// `Spec-023 §Signature Feature Composition Sketches`' Runs View renders "queue
// contents" and offers "cancel-before-admission (`run.queueCancel`) on the queue",
// which this read serves in all five states of the closed `QueueItemState`. The
// composer's queue shelf asks a narrower question of the same rows — "what have I got
// waiting" — and it used to ask it down a second module with the same file name, the
// same exported symbols and its own subscription, so a session view holding the runs
// pane beside the composer tailed `run.subscribeQueue` twice and read `run.queueList`
// twice for one answer.
//
// The difference between the two questions is a FILTER over one list and never a
// second fold: a row the daemon has stopped calling `queued` is exactly the row the
// shelf drops, and the shelf reads that off the canonical rows rather than off a
// private map that deleted them. So one reading serves both, and each surface keeps
// its own question.
//
// CLIENT MEMORY IS NEVER THE QUEUE OF RECORD. Cancel is a MUTATION rather than a
// fold, and `queue-cancellation.ts` owns it and states the rule. It holds no rows at
// all, so a reader looking for what the queue contains looks at the subscription and
// only there; this module composes the cancel state onto the feed and publishes when
// either half moves. The two rules about the rows themselves — that their order is
// rendered and never reordered, and that a canceled row stays visible — are the
// subscription's, stated in its header beside the fold that keeps them.
//
// ONE PUBLICATION PATH, which is why both collaborators are handed the same callback.
// A cancel's settlement and a delivery both end at `#publish`, so a watcher is never
// woken for one half of a frame the other half has not reached.

import {
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../../store/index.js";
import { QueueCancellations, type QueueCancellationState } from "./queue-cancellation.js";
import { SessionQueueSubscription, type QueueSubscriptionReading } from "./queue-subscription.js";
import { consoleClockFor, type ConsoleBridge } from "../console-bridge.js";

/**
 * What the pane reads off the queue: what the daemon said, and what this client asked.
 *
 * An intersection of the two modules that own the halves rather than a shape restated
 * here — the rows, the phase and the unreadable-delivery count are the subscription's,
 * and the three cancel members are `queue-cancellation.ts`'s. A second declaration
 * would be two places to keep in step with the surfaces that render it.
 */
export type QueueFeed = QueueCancellationState & QueueSubscriptionReading;

/**
 * One session's live queue reading, and everyone watching it.
 *
 * A class with private fields rather than a hook's state, because every surface in
 * the window asks the same question of the same session: the entry opens the tail
 * and takes the snapshot once, and the second surface to arrive is handed the
 * reading already in hand. The refusals, the fold, and the cancel path are exactly
 * the ones each surface used to own — only where they live has moved.
 */
export class SessionQueueReading implements ReadTriggerTarget {
  /**
   * Nothing in the timeline says this list changed that its own tail did not.
   *
   * `run.subscribeQueue` carries every row change, so the empty set is a claim:
   * this reading goes stale when the window has been away or the connection was
   * repaired — not because a session event that describes a RUN was appended.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #refresh: RefreshScheduler;
  readonly #subscription: SessionQueueSubscription;
  readonly #cancellations: QueueCancellations;
  readonly #listeners = new Set<() => void>();
  readonly #onIdle: () => void;
  /**
   * Whether this reading has been forgotten by the registry that held it.
   *
   * TERMINAL, and that is the whole point. `watch` used to re-open a reading the
   * registry had already dropped, so a surface that captured it during a render and
   * subscribed after the last watcher left revived it OUTSIDE the map — live, with a
   * tail of its own, and invisible to the next surface, which minted a second reading
   * for the same session. Two snapshot reads and two tails for one question is exactly
   * what this module exists to prevent, so the second life is refused rather than
   * granted and the registry hands out a fresh reading instead.
   */
  #isRetired = false;
  #feed: QueueFeed;

  public constructor(bridge: ConsoleBridge, sessionId: string, onIdle: () => void) {
    this.#onIdle = onIdle;
    // Both collaborators publish through this reading's own `#publish` rather than
    // through listeners of their own: one surface, one publication path, so a cancel's
    // settlement never renders a frame the rows have not reached.
    this.#cancellations = new QueueCancellations(bridge, () => {
      this.#publish();
    });
    this.#subscription = new SessionQueueSubscription(bridge, sessionId, () => {
      this.#publish();
    });
    this.#refresh = new RefreshScheduler({
      // The fixture's frozen clock wherever a scenario is playing and the real one
      // otherwise, resolved once per reading — the fixture bridge makes the frozen
      // clock the only clock the renderer reads in fixture mode.
      clock: consoleClockFor(bridge),
      perform: async () => {
        if (!this.#subscription.isOpen) {
          // THE REPAIR IS THE OPEN, not a read behind a tail that is not there. An
          // open that failed on the transport leaves this reading closed and
          // openable, and the snapshot it would take without a tail stops being true
          // the moment it lands — so the trigger that asked re-opens, and the open
          // takes its own read. A reading whose stream can never open answers
          // `isOpenable` false and this does nothing.
          this.#subscription.open();
          return;
        }
        await this.#subscription.readSnapshot();
      },
      // A read that fails is already recorded as this feed's own `readRefusal`, so
      // re-throwing would surface the same fact again as an unhandled rejection.
      onError: () => undefined,
    });
    this.#feed = this.#composeFeed();
  }

  /**
   * Ask for a fresh snapshot.
   *
   * The tail keeps rows current while it is up; this is what answers for the time
   * it was not. Coalesced by the scheduler, so the surfaces that mount together on
   * one session still cost one call.
   */
  public requestRead(reason: RefreshReason): void {
    if (reason === "subscribe" && this.#subscription.isOpen && this.#feed.phase !== "refused") {
      // THE OPEN IS THIS READING'S `subscribe` READ, so a surface arriving to an
      // already-open reading asks for nothing. Two reasons, and both matter: a joiner
      // needs no read because the tail has been keeping the reading current since the
      // first one landed, and the first read must not wait on a clock — the fixture's
      // is frozen and only a scenario beat moves it, so a first read behind the
      // scheduler's window would never happen at all in fixture mode. A reading
      // settled as REFUSED falls through: the joiner's arrival is exactly the reason
      // to try the failed read — or the failed OPEN — again.
      return;
    }
    this.#refresh.request(reason);
  }

  /** The reading as it stands. One object for every watcher, stable between changes. */
  public snapshot = (): QueueFeed => this.#feed;

  /** Whether this reading has been retired. A retired one serves nobody again. */
  public get isRetired(): boolean {
    return this.#isRetired;
  }

  /** Watch the reading. The first watcher opens it; the last to leave closes it. */
  public watch(listener: () => void): () => void {
    if (this.#isRetired) {
      throw new Error("A retired queue reading was watched; ask the registry for a live one");
    }
    this.#listeners.add(listener);
    this.#subscription.open();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        // The last surface left. The stream closes and the reading is forgotten, so
        // a surface that mounts later reads afresh rather than being handed a list
        // that stopped being updated when nobody was watching it.
        this.#isRetired = true;
        this.#refresh.dispose();
        this.#subscription.close();
        this.#onIdle();
      }
    };
  }

  #composeFeed(): QueueFeed {
    return { ...this.#cancellations.state, ...this.#subscription.reading };
  }

  #publish(): void {
    this.#feed = this.#composeFeed();
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
