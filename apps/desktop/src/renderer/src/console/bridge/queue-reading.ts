// One session's queue reading: the canonical snapshot, the tail that keeps it
// current, and cancel-before-admission.
//
// Split from `queue-feed.ts`, which is now the window's REGISTRY of these readings
// and the React door onto one — a second job, and the one that decides how long a
// reading lives rather than what it says.
//
// `Spec-023 §Signature Feature Composition Sketches`' Runs View renders "queue
// contents" and offers "cancel-before-admission (`run.queueCancel`) on the queue",
// which this read serves in all five states of the closed `QueueItemState`. The
// composer's queue shelf asks a
// narrower question of the same rows — "what have I got waiting" — and it used to
// ask it down a second module with the same file name, the same exported symbols and
// its own subscription, so a session view holding the runs pane beside the composer
// tailed `run.subscribeQueue` twice and read `run.queueList` twice for one answer.
//
// The difference between the two questions is a FILTER over one list and never a
// second fold: a row the daemon has stopped calling `queued` is exactly the row the
// shelf drops, and the shelf reads that off the canonical rows rather than off a
// private map that deleted them. So one reading serves both, and each surface keeps
// its own question.
//
// THREE RULES THIS MODULE ENCODES. The first is the corpus's — that same Runs View
// strikes queue reorder in terms, "`Spec-004 §Resolved Questions and V1 Scope
// Decisions` defers queue priority overrides for V1 … the queue's only V1 removal
// path is `run.queueCancel`" — and the other two are this module's own, because no
// committed document states them.
//
//   • **The order is rendered, never reordered.** `run.queueList` answers in
//     canonical FIFO order within the target scheduling scope, and the snapshot's
//     order is kept exactly. The tail merges by id INTO that order and appends only
//     ids the snapshot did not carry, so a live update never resequences the list.
//     The snapshot and the tail race, so seating REBUILDS the order and each id
//     keeps the newer of the two readings by the row's own `updatedAt` — see
//     `QueueOrder.seat` for why writing the snapshot over the tail regresses both
//     the row's state and its position.
//     There is no reorder control and no priority control anywhere in this file.
//   • **A canceled row stays visible.** A queue row is durable and never-evented —
//     drained but never deleted — so a state that is no longer `queued` updates the
//     row rather than removing it. A surface that shows only the waiting rows
//     filters them out at the point it renders; nothing here forgets a row.
//   • **Client memory is never the queue of record.** Cancel is a MUTATION rather
//     than a fold, and `queue-cancellation.ts` owns it and states the rule. It holds
//     no rows at all, so a reader looking for what the queue contains looks here and
//     only here; this module composes its state onto the feed and publishes when it
//     moves.
//
// AN UNOPENABLE STREAM IS A REFUSAL AND NOT A CRASH, AND A REFUSED OPEN IS NOT A
// DEAD READING. Opening the tail is the first thing this reading does, and on the
// shipped live bridge every daemon method throws — so the open is a call that fails
// synchronously in the ordinary case, not an exceptional one. It settles the reading
// `refused` with the thrown refusal's own code rather than unwinding out of whichever
// surface happened to mount first, which is the difference between a pane that renders
// a refusal and a window that renders nothing at all. It then leaves the reading
// OPENABLE, so the next focus, repair, or mount re-opens rather than reading behind a
// tail that is not there — `reading-lifecycle.ts` owns that state and says why the
// unparseable-scope arm is the one failure that does not re-try.
//
// WHAT THE WIRE DOES NOT CARRY. This console would say which run a row is bound to.
// The registered `QueueItemSummary` — `{ id, state, priority, channelId?,
// createdAt, updatedAt }`, parsed `.strict()` — has no run member, so there is
// nothing here to render it from and this module invents none.
//
// A WELL-FORMED SNAPSHOT SUPERSEDES WHAT PRECEDED IT, which is this stream's half of
// a rule `unreadable-deliveries.ts` states the rest of. A delivery this build cannot
// read is counted rather than dropped, and `run.queueList` answers with the whole
// list at one moment — so a seat CLEARS that count: every delivery counted before it
// described a row the snapshot has now restated. Deliveries after the seat count
// again, which keeps the reading exact rather than sticky. The tail opens BEFORE the
// snapshot lands, so the window this clears is a real one, and the account plane's
// reading — whose read cannot make the same claim — deliberately never clears its own.

import {
  QueueItemSummarySchema,
  RunQueueSubscribeRequestSchema,
  type QueueItemSummary,
} from "@ai-sidekicks/contracts";

import { refuse, type ConsoleRefusal } from "../core/index.js";
import {
  QUEUE_REFUSAL_ORIGIN,
  streamRefusalFor,
  unreadableDeliveryRefusal,
} from "./queue-refusals.js";
import { QueueCancellations, type QueueCancellationState } from "./queue-cancellation.js";
import {
  UnreadableDeliveryLedger,
  type UnreadableDeliveryReading,
} from "./unreadable-deliveries.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../store/index.js";
import { QUEUE_SUBSCRIBE_STREAM, subscribeDaemon } from "./daemon-streams.js";
import { WireReadLifecycle, type WireReadState } from "./reading-lifecycle.js";
import { callDaemon } from "./daemon-reply.js";
import { QueueOrder } from "./queue-order.js";
import { consoleClockFor, type ConsoleBridge } from "./console-bridge.js";

/**
 * The session id as the stream's own registered request carries it.
 *
 * Taken off the schema rather than re-declared, so the brand this module holds is
 * the brand the wire admitted and never a `string` that resembles one.
 */
type ScopedSessionId = ReturnType<typeof RunQueueSubscribeRequestSchema.parse>["sessionId"];

/**
 * What the pane reads off the queue.
 *
 * The three cancel members and the two unreadable-delivery members are the modules'
 * that own them rather than restated here: each pair is one module's whole surface,
 * and a second declaration would be two places to keep a shape in step with the
 * surfaces that render it.
 */
export interface QueueFeed
  extends QueueCancellationState, UnreadableDeliveryReading, WireReadState {
  /** Canonical order: the snapshot's, with live-only rows appended in arrival order. */
  readonly items: readonly QueueItemSummary[];
}

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
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #refresh: RefreshScheduler;
  readonly #order = new QueueOrder();
  readonly #unreadable = new UnreadableDeliveryLedger(unreadableDeliveryRefusal);
  readonly #cancellations: QueueCancellations;
  readonly #listeners = new Set<() => void>();
  readonly #onIdle: () => void;
  /**
   * The phase, the newest read's refusal, and whether the tail is up.
   *
   * `reading-lifecycle.ts`'s and not three fields here, because the account plane's
   * reading holds the same three and the two had drifted into two answers for one
   * rule — see that module's header for which two.
   */
  readonly #lifecycle = new WireReadLifecycle();
  #closeStream: (() => void) | undefined = undefined;
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
  /**
   * The scope every snapshot read is addressed at, parsed once when the stream
   * opened. Absent until then, which is what makes a read requested before the open
   * a no-op rather than an unscoped call.
   */
  #scopedSessionId: ScopedSessionId | undefined = undefined;
  // Identifies the read attempt a reply belongs to. A reply whose ordinal has moved
  // on was abandoned by a newer read and seats nothing — without it the abandoned
  // snapshot could land after the fresh one and undo it.
  #readOrdinal = 0;
  #items: readonly QueueItemSummary[] = EMPTY_ITEMS;
  #feed: QueueFeed;

  public constructor(bridge: ConsoleBridge, sessionId: string, onIdle: () => void) {
    this.#bridge = bridge;
    this.#sessionId = sessionId;
    this.#onIdle = onIdle;
    // Publishing through this reading's own `#publish` rather than through listeners
    // of its own: one surface, one publication path, so a cancel's settlement never
    // renders a frame the rows have not reached.
    this.#cancellations = new QueueCancellations(bridge, () => {
      this.#publish();
    });
    this.#refresh = new RefreshScheduler({
      // The fixture's frozen clock wherever a scenario is playing and the real one
      // otherwise, resolved once per reading — the fixture bridge makes the frozen
      // clock the only clock the renderer reads in fixture mode.
      clock: consoleClockFor(bridge),
      perform: async () => {
        if (!this.#lifecycle.isOpen) {
          // THE REPAIR IS THE OPEN, not a read behind a tail that is not there. An
          // open that failed on the transport leaves this reading closed and
          // openable, and the snapshot it would take without a tail stops being true
          // the moment it lands — so the trigger that asked re-opens, and the open
          // takes its own read. A reading whose stream can never open answers
          // `isOpenable` false and this does nothing.
          this.#open();
          return;
        }
        await this.#readSnapshot();
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
    if (reason === "subscribe" && this.#lifecycle.isOpen && this.#feed.phase !== "refused") {
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
    this.#open();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        // The last surface left. The stream closes and the reading is forgotten, so
        // a surface that mounts later reads afresh rather than being handed a list
        // that stopped being updated when nobody was watching it.
        this.#isRetired = true;
        this.#close();
        this.#onIdle();
      }
    };
  }

  #open(): void {
    if (!this.#lifecycle.isOpenable) {
      return;
    }

    // The stream's own registered request, parsed here rather than assembled at
    // the wrapper: an id the wire's `SessionId` brand refuses is a refusal this
    // surface renders, not an unscoped subscription it opens anyway.
    const subscribeRequest = RunQueueSubscribeRequestSchema.safeParse({
      sessionId: this.#sessionId,
    });
    if (!subscribeRequest.success) {
      // TERMINAL, and that is the difference from the transport arm below. This
      // request is composed from this reading's own session id every time, so a
      // scope the registered shape refused once it refuses on every later trigger —
      // and re-minting the same refusal on every window focus would re-render every
      // watcher for a fact that has not moved.
      this.#settleRefusedOpen(
        refuse(
          QUEUE_REFUSAL_ORIGIN,
          "session-unreadable",
          "The queue stream is session-scoped and this pane's session did not match the registered request shape, so the console did not open it.",
        ),
        "terminal",
      );
      return;
    }

    try {
      this.#closeStream = subscribeDaemon(
        this.#bridge,
        { method: QUEUE_SUBSCRIBE_STREAM, request: subscribeRequest.data },
        (payload) => {
          if (!this.#lifecycle.isOpen) {
            return;
          }
          const parsed = QueueItemSummarySchema.safeParse(payload);
          if (!parsed.success) {
            // EVERY delivery publishes, readable or not. One this build cannot
            // read changes no row — the fold never saw it — but it does change what
            // the rows MEAN, and a count that never reached a render could not say so.
            this.#unreadable.record(parsed.error.issues);
            this.#publish();
            return;
          }
          this.#order.merge(parsed.data);
          this.#items = this.#order.items();
          this.#publish();
        },
      );
    } catch (streamRejection: unknown) {
      // The snapshot is deliberately NOT attempted after this. The tail is what
      // keeps the list current, and a list read once off a bridge that could not
      // open a stream is a reading that stops being true the moment it lands — the
      // same reason the unscoped-open arm above returns rather than reading on.
      //
      // RE-OPENABLE, unlike that arm: the bridge that threw is the same bridge a
      // repair, a focus, or a fresh mount asks again, so the scheduler's `perform`
      // re-opens. Leaving the reading marked open was what made every one of those
      // triggers a guaranteed no-op for the life of the window.
      this.#settleRefusedOpen(streamRefusalFor(streamRejection), "retryable");
      return;
    }
    this.#lifecycle.markOpen();

    // The already-parsed id, taken off the stream's own request rather than parsed a
    // second time: one reading of this pane's session, and the guard above is where
    // an unreadable one refuses.
    this.#scopedSessionId = subscribeRequest.data.sessionId;
    // The open's own read, taken now rather than behind the scheduler's window: the
    // tail is already up, and the whole point of opening it first is that the window
    // between the tail and the snapshot is a real one this fold accounts for. Every
    // LATER read goes through the scheduler, which is what coalesces the reasons the
    // world outside supplies.
    void this.#readSnapshot();
  }

  /**
   * Take the snapshot that says what the whole list is at this moment.
   *
   * Requested at the open and again whenever the window or the connection says the
   * tail may have missed something. A read that arrives before the stream opened, or
   * after it closed, seats nothing: the list it would describe is not this reading's
   * any more.
   */
  async #readSnapshot(): Promise<void> {
    const sessionId = this.#scopedSessionId;
    if (!this.#lifecycle.isOpen || sessionId === undefined) {
      return;
    }
    this.#readOrdinal += 1;
    const readOrdinal = this.#readOrdinal;
    await callDaemon(this.#bridge, "run.queueList", { sessionId }).then((reply) => {
      if (!this.#lifecycle.isOpen || this.#readOrdinal !== readOrdinal) {
        return;
      }
      // One branch: the door has already collapsed an unsendable request, a
      // rejection carrying the daemon's own code, and a reply the registered list
      // shape does not admit into one refusal that keeps its own code.
      if (reply.status === "refused") {
        this.#settleRefused(reply.refusal);
        return;
      }
      this.#order.seat(reply.value.items);
      this.#items = this.#order.items();
      // Served, so the phase moves AND the previous read's refusal is cleared — one
      // act, because `readRefusal` means "the newest read failed".
      this.#lifecycle.settleRead();
      // The snapshot restates the whole list at one moment, so whatever the tail
      // delivered unreadably before it is superseded rather than still missing.
      this.#unreadable.clear();
      this.#publish();
    });
  }

  #close(): void {
    this.#lifecycle.markClosed();
    this.#refresh.dispose();
    this.#closeStream?.();
    this.#closeStream = undefined;
  }

  /** A snapshot read refused. The tail is untouched; only this read failed. */
  #settleRefused(refusal: ConsoleRefusal): void {
    this.#lifecycle.refuseRead(refusal);
    this.#publish();
  }

  /**
   * The tail would not open, on one of the two arms the open distinguishes.
   *
   * Named rather than passed a boolean because the two are different facts about the
   * same failure: `retryable` leaves the reading openable so a trigger re-opens it,
   * and `terminal` closes that door for the life of the reading.
   */
  #settleRefusedOpen(refusal: ConsoleRefusal, disposition: "retryable" | "terminal"): void {
    if (disposition === "terminal") {
      this.#lifecycle.refuseOpenTerminally(refusal);
    } else {
      this.#lifecycle.refuseOpen(refusal);
    }
    this.#publish();
  }

  #composeFeed(): QueueFeed {
    return {
      ...this.#cancellations.state,
      ...this.#unreadable.reading,
      ...this.#lifecycle.state,
      items: this.#items,
    };
  }

  #publish(): void {
    this.#feed = this.#composeFeed();
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

const EMPTY_ITEMS: readonly QueueItemSummary[] = Object.freeze([]);
