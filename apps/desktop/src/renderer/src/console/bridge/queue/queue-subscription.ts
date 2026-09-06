// The wire half of one session's queue reading: the tail, the snapshot taken behind
// it, and the rows those two produce between them.
//
// Split from `queue-reading.ts`, which is now the reading a surface holds — the
// composed feed, the watchers, and the scheduler that decides WHEN to ask. Talking to
// the daemon and publishing to a window are two jobs, and the file that held both had
// one class spanning them: a delivery arm and a listener arm are edited by different
// people for different reasons, and neither reader needs the other's half in view.
// The pair `queue-refusals.ts` and `queue-cancellation.ts` were taken off the same
// file for the same reason and state it in their own headers.
//
// THE SNAPSHOT IS TAKEN BEHIND THE TAIL AND ONLY BEHIND IT, which is why one module
// owns both and why it is named for the subscription. A list read off a bridge with no
// stream up stops being true the moment it lands, so every arm here that fails to open
// returns rather than reading on, and every read guards on the tail still being up.
//
// TWO RULES THIS MODULE ENCODES. `Spec-023 §Signature Feature Composition Sketches`'
// Runs View strikes queue reorder in terms — "`Spec-004 §Resolved Questions and V1
// Scope Decisions` defers queue priority overrides for V1 … the queue's only V1
// removal path is `run.queueCancel`" — and these two are this module's own, because no
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
//
// AN UNOPENABLE STREAM IS A REFUSAL AND NOT A CRASH, AND A REFUSED OPEN IS NOT A
// DEAD READING. Opening the tail is the first thing this does, and on the shipped live
// bridge every daemon method throws — so the open is a call that fails synchronously
// in the ordinary case, not an exceptional one. It settles the reading `refused` with
// the thrown refusal's own code rather than unwinding out of whichever surface
// happened to mount first, which is the difference between a pane that renders a
// refusal and a window that renders nothing at all. It then leaves the reading
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

import { normalizeWireRejection, refuse, type ConsoleRefusal } from "../../core/index.js";
import { callDaemon } from "../daemon/daemon-reply.js";
import { QUEUE_SUBSCRIBE_STREAM, subscribeDaemon } from "../daemon/daemon-streams.js";
import {
  UnreadableDeliveryLedger,
  WireReadLifecycle,
  type UnreadableDeliveryReading,
  type WireReadState,
} from "../readings/index.js";
import { QUEUE_REFUSAL_ORIGIN, unreadableDeliveryRefusal } from "./queue-refusals.js";
import { QueueOrder } from "./queue-order.js";
import type { ConsoleBridge } from "../console-bridge.js";

/**
 * The session id as the stream's own registered request carries it.
 *
 * Taken off the schema rather than re-declared, so the brand this module holds is
 * the brand the wire admitted and never a `string` that resembles one.
 */
type ScopedSessionId = ReturnType<typeof RunQueueSubscribeRequestSchema.parse>["sessionId"];

/**
 * Everything the wire has said about one session's queue.
 *
 * The rows, the phase the newest read left, and what arrived unreadable on the way —
 * the three that move together whenever the daemon answers. `queue-reading.ts` spreads
 * this beside the cancel state a surface asked for, which is the whole of `QueueFeed`:
 * one half is what the daemon said and the other is what this client did.
 */
export interface QueueSubscriptionReading extends UnreadableDeliveryReading, WireReadState {
  /** Canonical order: the snapshot's, with live-only rows appended in arrival order. */
  readonly items: readonly QueueItemSummary[];
}

/**
 * One session's tail and the snapshots taken behind it.
 *
 * A class with private fields rather than a closure per reading, because the tail, the
 * phase, and the rows move together and every transition is one that has to leave the
 * three consistent. It wakes nobody by itself: the owner supplies one callback and
 * this calls it after each outcome, so a watcher is never woken into a half-written
 * state — the shape `QueueCancellations` already takes beside it.
 */
export class SessionQueueSubscription {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #onChanged: () => void;
  readonly #order = new QueueOrder();
  readonly #unreadable = new UnreadableDeliveryLedger(unreadableDeliveryRefusal);
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

  public constructor(bridge: ConsoleBridge, sessionId: string, onChanged: () => void) {
    this.#bridge = bridge;
    this.#sessionId = sessionId;
    this.#onChanged = onChanged;
  }

  /**
   * Whether the tail is up.
   *
   * What the owner's scheduler branches on: a trigger that arrives with no tail behind
   * it re-opens rather than reading, because a snapshot taken without one stops being
   * true the moment it lands.
   */
  public get isOpen(): boolean {
    return this.#lifecycle.isOpen;
  }

  /** What the wire has said, as one object. Composed per read, never held here. */
  public get reading(): QueueSubscriptionReading {
    return { ...this.#unreadable.reading, ...this.#lifecycle.state, items: this.#items };
  }

  /**
   * Open the tail and take the read that goes behind it.
   *
   * Idempotent against an open reading and against one whose open can never succeed:
   * `reading-lifecycle.ts` answers `isOpenable` for both, so a repeated trigger costs
   * nothing and republishes nothing.
   */
  public open(): void {
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
            this.#onChanged();
            return;
          }
          this.#order.merge(parsed.data);
          this.#items = this.#order.items();
          this.#onChanged();
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
      // NO FALLBACK PAIR, deliberately. The fallback exists for a seam that knows its
      // failure better than the thrown value does, and a stream open does not: it
      // failed for a transport reason the transport already states — "the preload is a
      // stub" is the sentence someone acts on, and a house sentence about a live tail
      // would displace it with a paraphrase that names nothing to fix.
      this.#settleRefusedOpen(
        normalizeWireRejection(QUEUE_REFUSAL_ORIGIN, streamRejection),
        "retryable",
      );
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
    void this.readSnapshot();
  }

  /**
   * Take the snapshot that says what the whole list is at this moment.
   *
   * Requested at the open and again whenever the window or the connection says the
   * tail may have missed something. A read that arrives before the stream opened, or
   * after it closed, seats nothing: the list it would describe is not this reading's
   * any more.
   */
  public async readSnapshot(): Promise<void> {
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
      this.#onChanged();
    });
  }

  /**
   * Drop the tail.
   *
   * The scheduler is the owner's and is disposed there: this ends the conversation
   * with the daemon and says nothing about when anyone would have asked again.
   */
  public close(): void {
    this.#lifecycle.markClosed();
    this.#closeStream?.();
    this.#closeStream = undefined;
  }

  /** A snapshot read refused. The tail is untouched; only this read failed. */
  #settleRefused(refusal: ConsoleRefusal): void {
    this.#lifecycle.refuseRead(refusal);
    this.#onChanged();
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
    this.#onChanged();
  }
}

const EMPTY_ITEMS: readonly QueueItemSummary[] = Object.freeze([]);
