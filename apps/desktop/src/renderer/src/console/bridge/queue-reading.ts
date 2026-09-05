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
//   • **Client memory is never the queue of record.** Cancel does not remove a row.
//     `run.queueCancel` answering confirms the request; the row changes state when
//     the daemon says it did, on the snapshot or on the tail.
//
// AN UNOPENABLE STREAM IS A REFUSAL AND NOT A CRASH. Opening the tail is the first
// thing this reading does, and on the shipped live bridge every daemon method throws
// — so the open is a call that fails synchronously in the ordinary case, not an
// exceptional one. It settles the reading `refused` with the thrown refusal's own
// code rather than unwinding out of whichever surface happened to mount first, which
// is the difference between a pane that renders a refusal and a window that renders
// nothing at all.
//
// WHAT THE WIRE DOES NOT CARRY. This console would say which run a row is bound to.
// The registered `QueueItemSummary` — `{ id, state, priority, channelId?,
// createdAt, updatedAt }`, parsed `.strict()` — has no run member, so there is
// nothing here to render it from and this module invents none.
//
// A DELIVERY THIS BUILD CANNOT READ IS A PARTIAL READ AND NOT A DROP. The tail's
// parse used to discard a payload that failed `QueueItemSummarySchema` and go on
// serving the list as current — so a protocol-version mismatch left a changed or
// newly queued row stale with nothing anywhere saying so, which reads exactly like
// a queue that has not moved. The reading now carries what the run-state feed
// already carried for its own stream: a count of the deliveries that parsed as no
// registered row and the newest one's own parse refusal, which every surface renders
// as a warning beside the rows rather than in place of them. The feed is live and
// behind at once, and both halves are said. There is no derived `isPartial` flag
// beside the count: a boolean whose whole body is `count > 0` is a second reading of
// one fact, and the surfaces compose the notice from the count and the refusal
// together through the partial-read primitive.
//
// AND A WELL-FORMED SNAPSHOT SUPERSEDES WHAT PRECEDED IT. `run.queueList` answers
// with the whole list at one moment, so a seat clears the count: every delivery
// counted before it described a row the snapshot has now restated. Deliveries after
// the seat count again, which keeps the flag exact rather than sticky — the tail
// opens BEFORE the snapshot lands, so the window this clears is a real one.

import {
  QueueItemIdSchema,
  QueueItemSummarySchema,
  RunQueueSubscribeRequestSchema,
  type QueueItemSummary,
} from "@ai-sidekicks/contracts";

import {
  normalizeWireRejection,
  refuse,
  refusedMemberPaths,
  type ConsoleRefusal,
} from "../core/index.js";
import { QUEUE_SUBSCRIBE_STREAM, subscribeDaemon } from "./daemon-streams.js";
import { callDaemon } from "./daemon-reply.js";
import { QueueOrder } from "./queue-order.js";
import type { ConsoleBridge } from "./console-bridge.js";

/** The subsystem name every refusal this module raises carries. */
export const QUEUE_REFUSAL_ORIGIN = "session-queue";

/** How the snapshot read has gone. Three answers, and none of them is an empty list. */
export type QueueReadPhase = "reading" | "read" | "refused";

/** What the pane reads off the queue. */
export interface QueueFeed {
  /** Canonical order: the snapshot's, with live-only rows appended in arrival order. */
  readonly items: readonly QueueItemSummary[];
  readonly phase: QueueReadPhase;
  /** Why the snapshot could not be read. Rendered rather than swallowed. */
  readonly readRefusal: ConsoleRefusal | undefined;
  /** Items whose cancel is in flight, so the control disables rather than re-fires. */
  readonly pendingCancelIds: ReadonlySet<string>;
  /** The refusal a cancel came back with, keyed by the item it was asked for. */
  readonly cancelRefusalByItemId: ReadonlyMap<string, ConsoleRefusal>;
  readonly cancelItem: (queueItemId: string) => void;
  /**
   * Deliveries that parsed as no registered queue row since the newest snapshot.
   *
   * Named as `run-state-feed.ts` names its own, deliberately: one stream vocabulary
   * for two streams, so a surface rendering both is not reading two words for one
   * fact.
   */
  readonly unreadableDeliveryCount: number;
  /**
   * The newest unreadable delivery's own parse refusal, naming the members that
   * failed. Bounded by keeping only the newest — the refusals do not accumulate —
   * and by naming member paths rather than carrying the payload that failed.
   */
  readonly unreadableRefusal: ConsoleRefusal | undefined;
}

/**
 * The refusal an unopenable stream settles as.
 *
 * The console's ONE reading of a rejected promise, consumed rather than re-derived.
 * `normalizeWireRejection` already unwraps a `ConsoleRefusalError`'s carried refusal
 * structurally — which is what keeps the subscription wrapper's own unscoped-open
 * code intact instead of replacing it with this module's origin and a stringified
 * message — and already takes a typed envelope's dotted code off `data.type`, where
 * a `{ code: string }` guard cannot see it. All this module supplies is the two
 * thing that is its own: the origin.
 *
 * NO FALLBACK PAIR, deliberately. The fallback exists for a seam that knows its
 * failure better than the thrown value does, and this one does not: a stream that
 * would not open failed for a transport reason the transport already states — "the
 * preload is a stub" is the sentence someone acts on, and a house sentence about a
 * live tail would displace it with a paraphrase that names nothing to fix.
 */
function streamRefusalFor(rejection: unknown): ConsoleRefusal {
  return normalizeWireRejection(QUEUE_REFUSAL_ORIGIN, rejection);
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
export class SessionQueueReading {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #order = new QueueOrder();
  readonly #listeners = new Set<() => void>();
  readonly #onIdle: () => void;
  #closeStream: (() => void) | undefined = undefined;
  #isOpen = false;
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
  #items: readonly QueueItemSummary[] = EMPTY_ITEMS;
  #phase: QueueReadPhase = "reading";
  #readRefusal: ConsoleRefusal | undefined = undefined;
  #pendingCancelIds: ReadonlySet<string> = EMPTY_IDS;
  #cancelRefusalByItemId: ReadonlyMap<string, ConsoleRefusal> = EMPTY_REFUSALS;
  #unreadableDeliveryCount = 0;
  #unreadableRefusal: ConsoleRefusal | undefined = undefined;
  #feed: QueueFeed;

  public constructor(bridge: ConsoleBridge, sessionId: string, onIdle: () => void) {
    this.#bridge = bridge;
    this.#sessionId = sessionId;
    this.#onIdle = onIdle;
    this.#feed = this.#composeFeed();
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
    if (this.#isOpen) {
      return;
    }
    this.#isOpen = true;

    // The stream's own registered request, parsed here rather than assembled at
    // the wrapper: an id the wire's `SessionId` brand refuses is a refusal this
    // surface renders, not an unscoped subscription it opens anyway.
    const subscribeRequest = RunQueueSubscribeRequestSchema.safeParse({
      sessionId: this.#sessionId,
    });
    if (!subscribeRequest.success) {
      this.#settleRefused(
        refuse(
          QUEUE_REFUSAL_ORIGIN,
          "session-unreadable",
          "The queue stream is session-scoped and this pane's session did not match the registered request shape, so the console did not open it.",
        ),
      );
      return;
    }

    try {
      this.#closeStream = subscribeDaemon(
        this.#bridge,
        { method: QUEUE_SUBSCRIBE_STREAM, request: subscribeRequest.data },
        (payload) => {
          if (!this.#isOpen) {
            return;
          }
          const parsed = QueueItemSummarySchema.safeParse(payload);
          if (!parsed.success) {
            // EVERY delivery publishes, readable or not. A delivery this build
            // cannot read changes no row — the fold never saw it — but it does
            // change what the rows MEAN, and a count that never reached a render
            // could not say so.
            this.#unreadableDeliveryCount += 1;
            this.#unreadableRefusal = unreadableDeliveryRefusal(parsed.error.issues);
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
      this.#settleRefused(streamRefusalFor(streamRejection));
      return;
    }

    // The already-parsed id, taken off the stream's own request rather than parsed a
    // second time: one reading of this pane's session, and the guard above is where
    // an unreadable one refuses.
    const { sessionId } = subscribeRequest.data;
    void callDaemon(this.#bridge, "run.queueList", { sessionId }).then((reply) => {
      if (!this.#isOpen) {
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
      this.#phase = "read";
      // The snapshot restates the whole list at one moment, so whatever the tail
      // delivered unreadably before it is superseded rather than still missing.
      this.#unreadableDeliveryCount = 0;
      this.#unreadableRefusal = undefined;
      this.#publish();
    });
  }

  #close(): void {
    this.#isOpen = false;
    this.#closeStream?.();
    this.#closeStream = undefined;
  }

  #cancelItem = (rawQueueItemId: string): void => {
    const queueItemId = QueueItemIdSchema.safeParse(rawQueueItemId);
    if (!queueItemId.success) {
      const next = new Map(this.#cancelRefusalByItemId);
      next.set(
        rawQueueItemId,
        refuse(
          QUEUE_REFUSAL_ORIGIN,
          "queue-item-unreadable",
          "The console is holding an identifier for this queued message that the daemon would not accept, so it asked for no cancel.",
        ),
      );
      this.#cancelRefusalByItemId = next;
      this.#publish();
      return;
    }
    if (this.#pendingCancelIds.has(rawQueueItemId)) {
      // Silent rather than refused: the person pressed Cancel for the cancel that is
      // already going, and a refusal card would report a failure where the only
      // thing that happened is that they were early. This is the chokepoint and not
      // the button, because the set the button disables from is published one render
      // behind — two presses inside one frame both read a control that was live.
      return;
    }
    this.#pendingCancelIds = withId(this.#pendingCancelIds, rawQueueItemId);
    this.#publish();
    void callDaemon(this.#bridge, "run.queueCancel", { queueItemId: queueItemId.data }).then(
      (reply) => {
        this.#pendingCancelIds = withoutId(this.#pendingCancelIds, rawQueueItemId);
        if (reply.status === "refused") {
          const next = new Map(this.#cancelRefusalByItemId);
          next.set(rawQueueItemId, reply.refusal);
          this.#cancelRefusalByItemId = next;
        }
        // A served reply changes nothing about the list. It confirms the REQUEST; the
        // row's state changes when the tail says the daemon changed it.
        this.#publish();
      },
    );
  };

  #settleRefused(refusal: ConsoleRefusal): void {
    this.#phase = "refused";
    this.#readRefusal = refusal;
    this.#publish();
  }

  #composeFeed(): QueueFeed {
    return {
      items: this.#items,
      phase: this.#phase,
      readRefusal: this.#readRefusal,
      pendingCancelIds: this.#pendingCancelIds,
      cancelRefusalByItemId: this.#cancelRefusalByItemId,
      cancelItem: this.#cancelItem,
      unreadableDeliveryCount: this.#unreadableDeliveryCount,
      unreadableRefusal: this.#unreadableRefusal,
    };
  }

  #publish(): void {
    this.#feed = this.#composeFeed();
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/**
 * One unreadable delivery as the refusal a surface renders.
 *
 * Names the failing MEMBER PATHS and never the payload: the payload is a frame
 * this build could not read, so quoting it would put an unbounded and unvalidated
 * value on screen to explain why an unvalidated value was refused. The path set is
 * fixed by the registered schema, which is what makes the sentence bounded without
 * a cap to spend.
 */
function unreadableDeliveryRefusal(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): ConsoleRefusal {
  const members = refusedMemberPaths(issues);
  return refuse(
    QUEUE_REFUSAL_ORIGIN,
    "delivery-unreadable",
    `A queue delivery did not match the registered row shape, so it changed no row here: ${members.join(", ")}.`,
  );
}

const EMPTY_ITEMS: readonly QueueItemSummary[] = Object.freeze([]);
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_REFUSALS: ReadonlyMap<string, ConsoleRefusal> = new Map<string, ConsoleRefusal>();

function withId(held: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(held);
  next.add(id);
  return next;
}

function withoutId(held: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(held);
  next.delete(id);
  return next;
}
