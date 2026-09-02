// The session's queue read: the canonical snapshot, the tail that keeps it current,
// and cancel-before-admission — read ONCE for every surface that wants it.
//
// `Spec-023 §Console Design (Meridian)` §7.4 asks for "what is waiting, what it is
// bound to, and let a participant take an item back before it is admitted", in all
// five states of the closed `QueueItemState`. The composer's queue shelf asks a
// narrower question of the same rows — "what have I got waiting" — and it used to
// ask it down a second module with the same file name, the same exported symbols and
// its own subscription, so a session view holding the runs pane beside the composer
// tailed `run.subscribeQueue` twice and read `run.queueList` twice for one answer.
//
// The difference between the two questions is a FILTER over one list and never a
// second fold: a row the daemon has stopped calling `queued` is exactly the row the
// shelf drops, and the shelf reads that off the canonical rows rather than off a
// private map that deleted them. So this module holds the read, keyed by bridge and
// session, and each surface keeps its own question.
//
// THREE RULES §7.4 STATES AND THIS MODULE ENCODES.
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
// WHAT THE WIRE DOES NOT CARRY. §7.4 asks the row to say which run it is bound to.
// The registered `QueueItemSummary` — `{ id, state, priority, channelId?,
// createdAt, updatedAt }`, parsed `.strict()` — has no run member, so there is
// nothing here to render it from and this module invents none.

import { useCallback, useSyncExternalStore } from "react";
import {
  QueueItemListResponseSchema,
  QueueItemSummarySchema,
  RunQueueSubscribeRequestSchema,
  type QueueItemSummary,
} from "@ai-sidekicks/contracts";

import { normalizeWireRejection } from "../../../../shared/wire-errors.js";
import { isConsoleRefusal, refuse, type ConsoleRefusal } from "../core/index.js";
import {
  QUEUE_CANCEL_METHOD,
  QUEUE_LIST_METHOD,
  QUEUE_SUBSCRIBE_STREAM,
  callDaemon,
  subscribeDaemon,
} from "./daemon-calls.js";
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
}

/**
 * The ordered fold, as a class so the order rule is one place rather than a
 * convention spread across three `setState` callbacks.
 */
export class QueueOrder {
  #itemsById = new Map<string, QueueItemSummary>();

  /**
   * Seat the snapshot. Its order becomes the list's order — and no row it carries
   * displaces a NEWER reading of that row.
   *
   * The two halves are one rule, and both are needed because the tail is opened
   * alongside the snapshot rather than after it. `run.queueList` answers a moment;
   * a tail emission that arrived while that answer was in flight describes a LATER
   * moment of the same row. Seating the snapshot by writing every row would then do
   * two wrong things at once: it would regress an `admitted` row back to the
   * `queued` the snapshot was taken at — permanently, since the daemon has no
   * reason to say it again — and it would leave the row at the position the tail
   * gave it rather than the canonical FIFO position the snapshot names, so a queue
   * of two would render reversed.
   *
   * So the order is REBUILT from the snapshot and each id takes the newer of the
   * two readings, compared on the registered `QueueItemSummary.updatedAt` — the
   * row's own monotonic member, wire-supplied, never arrival order, which says only
   * which message this process happened to receive first. A tie keeps the held row:
   * two readings of one instant are the same reading, and the held one is the later
   * observation. Ids the snapshot did not carry are appended after it, in the order
   * the tail delivered them.
   */
  public seat(items: readonly QueueItemSummary[]): void {
    const rebuilt = new Map<string, QueueItemSummary>();
    for (const snapshotRow of items) {
      const held = this.#itemsById.get(snapshotRow.id);
      rebuilt.set(
        snapshotRow.id,
        held !== undefined && !isStrictlyNewer(snapshotRow, held) ? held : snapshotRow,
      );
    }
    for (const [itemId, heldRow] of this.#itemsById) {
      if (!rebuilt.has(itemId)) {
        rebuilt.set(itemId, heldRow);
      }
    }
    this.#itemsById = rebuilt;
  }

  /**
   * Merge one live emission.
   *
   * An id already in the list keeps its POSITION and takes the new state; an id the
   * snapshot did not carry is appended. `Map.set` on an existing key preserves
   * insertion order, which is what makes the first half true without a second index.
   *
   * Last-writer-wins here and comparison only at `seat`, deliberately: the stream
   * is one ordered sequence of the daemon's own updates, so its newest delivery is
   * its newest reading. The snapshot is what arrives out of order, and it is the
   * only reading this fold has to rank.
   */
  public merge(item: QueueItemSummary): void {
    this.#itemsById.set(item.id, item);
  }

  public items(): readonly QueueItemSummary[] {
    return [...this.#itemsById.values()];
  }
}

/**
 * Whether one reading of a row is strictly newer than another.
 *
 * `updatedAt` is `z.iso.datetime({ offset: true })` on both sides, so both parse;
 * an unparseable value answers `false`, which keeps the held row — the fail-closed
 * direction, since the alternative is letting an unreadable stamp overwrite a
 * reading the console knows is real.
 */
function isStrictlyNewer(candidate: QueueItemSummary, held: QueueItemSummary): boolean {
  const candidateInstant = Date.parse(candidate.updatedAt);
  const heldInstant = Date.parse(held.updatedAt);
  if (Number.isNaN(candidateInstant) || Number.isNaN(heldInstant)) {
    return false;
  }
  return candidateInstant > heldInstant;
}

/**
 * The refusal an unopenable stream settles as.
 *
 * A `ConsoleRefusalError` raised by the subscription wrapper's own unscoped-open
 * guard already carries a refusal naming its origin and its code; re-wrapping it
 * would replace both with this module's origin and a stringified message, and the
 * code is what a person pastes into a search. Anything else is a wire rejection and
 * goes through the one normalizer this file already uses on the snapshot's path —
 * there is no second normalization here.
 */
function streamRefusalFor(rejection: unknown): ConsoleRefusal {
  if (typeof rejection === "object" && rejection !== null) {
    const carried = (rejection as { readonly refusal?: unknown }).refusal;
    if (isConsoleRefusal(carried)) {
      return carried;
    }
  }
  const wireError = normalizeWireRejection(rejection, { total: true });
  return refuse(QUEUE_REFUSAL_ORIGIN, wireError.name, wireError.message);
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
class SessionQueueReading {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #order = new QueueOrder();
  readonly #listeners = new Set<() => void>();
  readonly #onIdle: () => void;
  #closeStream: (() => void) | undefined = undefined;
  #isOpen = false;
  #items: readonly QueueItemSummary[] = EMPTY_ITEMS;
  #phase: QueueReadPhase = "reading";
  #readRefusal: ConsoleRefusal | undefined = undefined;
  #pendingCancelIds: ReadonlySet<string> = EMPTY_IDS;
  #cancelRefusalByItemId: ReadonlyMap<string, ConsoleRefusal> = EMPTY_REFUSALS;
  #feed: QueueFeed;

  public constructor(bridge: ConsoleBridge, sessionId: string, onIdle: () => void) {
    this.#bridge = bridge;
    this.#sessionId = sessionId;
    this.#onIdle = onIdle;
    this.#feed = this.#composeFeed();
  }

  /** The reading as it stands. One object for every watcher, stable between changes. */
  public snapshot = (): QueueFeed => this.#feed;

  /** Watch the reading. The first watcher opens it; the last to leave closes it. */
  public watch(listener: () => void): () => void {
    this.#listeners.add(listener);
    this.#open();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        // The last surface left. The stream closes and the reading is forgotten, so
        // a surface that mounts later reads afresh rather than being handed a list
        // that stopped being updated when nobody was watching it.
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
          const parsed = QueueItemSummarySchema.safeParse(payload);
          if (!parsed.success || !this.#isOpen) {
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

    void callDaemon(this.#bridge, QUEUE_LIST_METHOD, { sessionId: this.#sessionId })
      .then((reply) => {
        if (!this.#isOpen) {
          return;
        }
        const parsed = QueueItemListResponseSchema.safeParse(reply);
        if (!parsed.success) {
          this.#settleRefused(
            refuse(
              QUEUE_REFUSAL_ORIGIN,
              "reply-unreadable",
              "The queue reply did not match the registered list shape, so the console did not read rows from it.",
            ),
          );
          return;
        }
        this.#order.seat(parsed.data.items);
        this.#items = this.#order.items();
        this.#phase = "read";
        this.#publish();
      })
      .catch((rejection: unknown) => {
        if (!this.#isOpen) {
          return;
        }
        const wireError = normalizeWireRejection(rejection, { total: true });
        this.#settleRefused(refuse(QUEUE_REFUSAL_ORIGIN, wireError.name, wireError.message));
      });
  }

  #close(): void {
    this.#isOpen = false;
    this.#closeStream?.();
    this.#closeStream = undefined;
  }

  #cancelItem = (queueItemId: string): void => {
    if (this.#pendingCancelIds.has(queueItemId)) {
      // Silent rather than refused: the person pressed Cancel for the cancel that is
      // already going, and a refusal card would report a failure where the only
      // thing that happened is that they were early. This is the chokepoint and not
      // the button, because the set the button disables from is published one render
      // behind — two presses inside one frame both read a control that was live.
      return;
    }
    this.#pendingCancelIds = withId(this.#pendingCancelIds, queueItemId);
    this.#publish();
    void callDaemon(this.#bridge, QUEUE_CANCEL_METHOD, { queueItemId })
      .then(() => {
        // Deliberately nothing to the list. The reply confirms the request; the
        // row's state changes when the tail says the daemon changed it.
        this.#pendingCancelIds = withoutId(this.#pendingCancelIds, queueItemId);
        this.#publish();
      })
      .catch((rejection: unknown) => {
        const wireError = normalizeWireRejection(rejection, { total: true });
        this.#pendingCancelIds = withoutId(this.#pendingCancelIds, queueItemId);
        const next = new Map(this.#cancelRefusalByItemId);
        next.set(queueItemId, refuse(QUEUE_REFUSAL_ORIGIN, wireError.name, wireError.message));
        this.#cancelRefusalByItemId = next;
        this.#publish();
      });
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
 * Every live reading in this window, keyed by the bridge and the session.
 *
 * A `WeakMap` on the bridge so a closed window takes its readings with it, and the
 * entry itself is dropped once nobody is watching — a surface that mounts later
 * reads afresh rather than being handed a list that stopped being updated when the
 * last watcher left.
 */
class SessionQueueReadings {
  readonly #bySession = new WeakMap<ConsoleBridge, Map<string, SessionQueueReading>>();

  public reading(bridge: ConsoleBridge, sessionId: string): SessionQueueReading {
    let forBridge = this.#bySession.get(bridge);
    if (forBridge === undefined) {
      forBridge = new Map<string, SessionQueueReading>();
      this.#bySession.set(bridge, forBridge);
    }
    const held = forBridge.get(sessionId);
    if (held !== undefined) {
      return held;
    }
    const forThisBridge = forBridge;
    const created = new SessionQueueReading(bridge, sessionId, () => {
      forThisBridge.delete(sessionId);
    });
    forBridge.set(sessionId, created);
    return created;
  }
}

const sessionQueueReadings = new SessionQueueReadings();

/**
 * Read one session's queue.
 *
 * Every surface on one bridge and session is served by one snapshot read and one
 * tail. The watcher count is what opens and closes them, so a window with no queue
 * surface mounted holds no subscription.
 */
export function useQueueFeed(bridge: ConsoleBridge, sessionId: string): QueueFeed {
  const reading = sessionQueueReadings.reading(bridge, sessionId);
  const subscribe = useCallback(
    (onFeedChanged: () => void) => reading.watch(onFeedChanged),
    [reading],
  );
  return useSyncExternalStore(subscribe, reading.snapshot, reading.snapshot);
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
