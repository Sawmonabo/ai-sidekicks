// The pane's queue read: the canonical snapshot, the tail that keeps it current,
// and cancel-before-admission.
//
// `Spec-023 §Console Design (Meridian)` §7.4 asks for "what is waiting, what it is
// bound to, and let a participant take an item back before it is admitted", in all
// five states of the closed `QueueItemState`. That is a different read from the
// composer's queue shelf, which tails `queued` alone and drops a row the moment the
// daemon says it is no longer waiting — the shelf answers "what have I got
// waiting", and this answers "what is in the queue, including what already left
// it". Two questions, two folds; a shared fold would have to be parameterised by
// which states it keeps, and every caller would then have to know both answers.
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
//     row rather than removing it. That is the opposite of the shelf's rule, and it
//     is why the two folds are separate.
//   • **Client memory is never the queue of record.** Cancel does not remove a row.
//     `run.queueCancel` answering confirms the request; the row changes state when
//     the daemon says it did, on the snapshot or on the tail.
//
// WHAT THE WIRE DOES NOT CARRY. §7.4 asks the row to say which run it is bound to.
// The registered `QueueItemSummary` — `{ id, state, priority, channelId?,
// createdAt, updatedAt }`, parsed `.strict()` — has no run member, so there is
// nothing here to render it from and this module invents none.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  QueueItemListResponseSchema,
  QueueItemSummarySchema,
  RunQueueSubscribeRequestSchema,
  type QueueItemSummary,
} from "@ai-sidekicks/contracts";

import { normalizeWireRejection } from "../../../../../shared/wire-errors.js";
import { refuse, type ConsoleRefusal } from "../../core/index.js";
import {
  QUEUE_CANCEL_METHOD,
  QUEUE_LIST_METHOD,
  QUEUE_SUBSCRIBE_STREAM,
  callDaemon,
  subscribeDaemon,
  type ConsoleBridge,
} from "../../bridge/index.js";

/** The subsystem name every refusal this module raises carries. */
export const QUEUE_REFUSAL_ORIGIN = "runs-queue";

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
 * Open the queue read for one session.
 *
 * The snapshot is taken first and the tail is opened alongside it; an emission that
 * arrives before the snapshot lands is merged into the same fold, so the ordering
 * rule holds whichever wins the race. The read is a one-shot on mount rather than
 * anything scheduled: `Spec-023` puts every refresh through
 * `console/store/scheduling.ts` and there is no refresh here to schedule — the tail
 * is what keeps the list current.
 */
export function useQueueFeed(bridge: ConsoleBridge, sessionId: string): QueueFeed {
  const [items, setItems] = useState<readonly QueueItemSummary[]>(EMPTY_ITEMS);
  const [phase, setPhase] = useState<QueueReadPhase>("reading");
  const [readRefusal, setReadRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  const [pendingCancelIds, setPendingCancelIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [cancelRefusalByItemId, setCancelRefusalByItemId] =
    useState<ReadonlyMap<string, ConsoleRefusal>>(EMPTY_REFUSALS);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    const order = new QueueOrder();
    setItems(EMPTY_ITEMS);
    setPhase("reading");
    setReadRefusal(undefined);

    // The stream's own registered request, parsed here rather than assembled at
    // the wrapper: an id the wire's `SessionId` brand refuses is a refusal this
    // surface renders, not an unscoped subscription it opens anyway.
    const subscribeRequest = RunQueueSubscribeRequestSchema.safeParse({ sessionId });
    if (!subscribeRequest.success) {
      setPhase("refused");
      setReadRefusal(
        refuse(
          QUEUE_REFUSAL_ORIGIN,
          "session-unreadable",
          "The queue stream is session-scoped and this pane's session did not match the registered request shape, so the console did not open it.",
        ),
      );
      return () => {
        isMounted.current = false;
      };
    }

    const unsubscribe = subscribeDaemon(
      bridge,
      { method: QUEUE_SUBSCRIBE_STREAM, request: subscribeRequest.data },
      (payload) => {
        const parsed = QueueItemSummarySchema.safeParse(payload);
        if (!parsed.success || !isMounted.current) {
          return;
        }
        order.merge(parsed.data);
        setItems(order.items());
      },
    );

    void callDaemon(bridge, QUEUE_LIST_METHOD, { sessionId })
      .then((reply) => {
        if (!isMounted.current) {
          return;
        }
        const parsed = QueueItemListResponseSchema.safeParse(reply);
        if (!parsed.success) {
          setPhase("refused");
          setReadRefusal(
            refuse(
              QUEUE_REFUSAL_ORIGIN,
              "reply-unreadable",
              "The queue reply did not match the registered list shape, so the console did not read rows from it.",
            ),
          );
          return;
        }
        order.seat(parsed.data.items);
        setItems(order.items());
        setPhase("read");
      })
      .catch((rejection: unknown) => {
        if (!isMounted.current) {
          return;
        }
        const wireError = normalizeWireRejection(rejection, { total: true });
        setPhase("refused");
        setReadRefusal(refuse(QUEUE_REFUSAL_ORIGIN, wireError.name, wireError.message));
      });

    return () => {
      isMounted.current = false;
      unsubscribe();
    };
  }, [bridge, sessionId]);

  const cancelItem = useCallback(
    (queueItemId: string) => {
      setPendingCancelIds((held) => withId(held, queueItemId));
      void callDaemon(bridge, QUEUE_CANCEL_METHOD, { queueItemId })
        .then(() => {
          // Deliberately nothing to the list. The reply confirms the request; the
          // row's state changes when the tail says the daemon changed it.
          if (isMounted.current) {
            setPendingCancelIds((held) => withoutId(held, queueItemId));
          }
        })
        .catch((rejection: unknown) => {
          if (!isMounted.current) {
            return;
          }
          const wireError = normalizeWireRejection(rejection, { total: true });
          setPendingCancelIds((held) => withoutId(held, queueItemId));
          setCancelRefusalByItemId((held) => {
            const next = new Map(held);
            next.set(queueItemId, refuse(QUEUE_REFUSAL_ORIGIN, wireError.name, wireError.message));
            return next;
          });
        });
    },
    [bridge],
  );

  return useMemo(
    () => ({
      items,
      phase,
      readRefusal,
      pendingCancelIds,
      cancelRefusalByItemId,
      cancelItem,
    }),
    [items, phase, readRefusal, pendingCancelIds, cancelRefusalByItemId, cancelItem],
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
