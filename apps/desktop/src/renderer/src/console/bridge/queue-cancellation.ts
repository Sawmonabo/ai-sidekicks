// Cancel-before-admission: the queue's one V1 removal path, and what a surface reads
// while it is in flight.
//
// Split from `queue-reading.ts`, whose first sentence already named this as the third
// of the three things it held. That module owns the canonical snapshot and the tail
// that keeps it current — a fold over rows the daemon sends — and this one owns a
// MUTATION and the two pieces of client memory a mutation needs: which items have a
// cancel in flight, so a control disables rather than re-fires, and what a cancel
// came back refused with, keyed by the item it was asked for. The two are separable
// exactly because neither reads the other's state: nothing here touches the order or
// the rows, and the fold next door never consults a pending set.
//
// CLIENT MEMORY IS NEVER THE QUEUE OF RECORD, which is the rule that keeps the split
// honest. Cancel does not remove a row and does not change one. `run.queueCancel`
// answering confirms the REQUEST; the row changes state when the daemon says it did,
// on the snapshot or on the tail. So this module holds no rows at all, and a reader
// looking for what the queue contains looks in exactly one place.
//
// `Spec-023 §Signature Feature Composition Sketches`' Runs View offers
// "cancel-before-admission (`run.queueCancel`) on the queue" and strikes queue reorder
// in terms — "`Spec-004 §Resolved Questions and V1 Scope Decisions` defers queue
// priority overrides for V1 … the queue's only V1 removal path is `run.queueCancel`".
// There is no reorder control and no priority control in this file either.

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { QUEUE_REFUSAL_ORIGIN } from "./queue-refusals.js";
import { callDaemon } from "./daemon/daemon-reply.js";
import { readQueueItemId } from "./wire-identifiers.js";
import type { ConsoleBridge } from "./console-bridge.js";

/** What a surface reads about cancels, and the control it asks one through. */
export interface QueueCancellationState {
  /** Items whose cancel is in flight, so the control disables rather than re-fires. */
  readonly pendingCancelIds: ReadonlySet<string>;
  /** The refusal a cancel came back with, keyed by the item it was asked for. */
  readonly cancelRefusalByItemId: ReadonlyMap<string, ConsoleRefusal>;
  readonly cancelItem: (queueItemId: string) => void;
}

/**
 * One reading's cancels: what is in flight, what refused, and how one is asked for.
 *
 * A class with private fields rather than two maps the reading passes around, because
 * the pending set and the refusal map move together on every arm — a request adds to
 * one, and its reply removes from that one and may write the other — and a caller
 * that could move one without the other is how a control comes to stay disabled after
 * the cancel it was waiting on has already refused.
 *
 * It publishes through a callback rather than holding listeners of its own. The
 * watchers belong to the reading this is part of: two publication paths for one
 * surface would let a cancel's settlement render a frame the rows had not reached.
 */
export class QueueCancellations {
  readonly #bridge: ConsoleBridge;
  readonly #onChanged: () => void;
  #pendingCancelIds: ReadonlySet<string> = EMPTY_IDS;
  #cancelRefusalByItemId: ReadonlyMap<string, ConsoleRefusal> = EMPTY_REFUSALS;

  public constructor(bridge: ConsoleBridge, onChanged: () => void) {
    this.#bridge = bridge;
    this.#onChanged = onChanged;
  }

  /** The three members a feed carries, as they stand. */
  public get state(): QueueCancellationState {
    return {
      pendingCancelIds: this.#pendingCancelIds,
      cancelRefusalByItemId: this.#cancelRefusalByItemId,
      cancelItem: this.#cancelItem,
    };
  }

  #cancelItem = (rawQueueItemId: string): void => {
    // Through the family's own reader rather than a schema parsed here: one reading
    // of what the wire admits as a queue-item identifier, in the module that owns it.
    const queueItemId = readQueueItemId(rawQueueItemId);
    if (queueItemId === undefined) {
      this.#recordRefusal(
        rawQueueItemId,
        refuse(
          QUEUE_REFUSAL_ORIGIN,
          "queue-item-unreadable",
          "The console is holding an identifier for this queued message that the daemon would not accept, so it asked for no cancel.",
        ),
      );
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
    this.#onChanged();
    void callDaemon(this.#bridge, "run.queueCancel", { queueItemId }).then((reply) => {
      this.#pendingCancelIds = withoutId(this.#pendingCancelIds, rawQueueItemId);
      if (reply.status === "refused") {
        this.#recordRefusal(rawQueueItemId, reply.refusal);
        return;
      }
      // A served reply changes nothing about the list. It confirms the REQUEST; the
      // row's state changes when the tail says the daemon changed it.
      this.#onChanged();
    });
  };

  /** File one refusal under the item it was asked for, and say so. */
  #recordRefusal(rawQueueItemId: string, refusal: ConsoleRefusal): void {
    const next = new Map(this.#cancelRefusalByItemId);
    next.set(rawQueueItemId, refusal);
    this.#cancelRefusalByItemId = next;
    this.#onChanged();
  }
}

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
