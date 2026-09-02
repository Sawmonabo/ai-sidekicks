// The queue shelf's feed: the one subscription the composer opens, and the cancel
// that never removes a row ahead of the daemon.
//
// WHY THIS SUBSCRIPTION DOES NOT GO THROUGH THE APPLY CHOKEPOINT. The console's
// rule is that components subscribe to a STORE and exactly one thing subscribes to
// the session event stream — the chokepoint in front of `SessionStore.applyBatch`.
// That rule is about SESSION EVENTS, and it holds because every session event
// projects into an entity partition. `run.subscribeQueue` streams `QueueItemSummary`
// projections, and `CONSOLE_ENTITY_KINDS` declares no queue-item kind: routing this
// through the chokepoint would mean inventing an entity kind the substrate does not
// have and a projector for a stream that carries no event. So the feed owns its own
// subscription, opens exactly one, and closes it on unmount.
//
// WHY CANCEL IS OPTIMISTIC ABOUT NOTHING. `run.queueCancel` answering does not
// remove a row. The row leaves when a later emission carries a state that is no
// longer `queued`, which is the daemon saying so. A shelf that removed on the reply
// would show an empty shelf for an item the daemon then re-emitted as still queued,
// and the person would have watched their own message vanish and come back.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  QueueItemSummarySchema,
  RunQueueSubscribeRequestSchema,
  type QueueItemSummary,
} from "@ai-sidekicks/contracts";
import { normalizeWireRejection } from "../../../../../shared/wire-errors.js";
import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";
import {
  QUEUE_CANCEL_METHOD,
  QUEUE_SUBSCRIBE_STREAM,
  callDaemon,
  subscribeDaemon,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";

/** The subsystem name every refusal this module raises carries. */
export const QUEUE_REFUSAL_ORIGIN = "composer-queue";

/**
 * The one queue state the shelf renders.
 *
 * `admitted`, `superseded`, `canceled`, and `expired` are all the daemon saying the
 * item is no longer waiting, so all four take it off the shelf by the same rule
 * rather than by four special cases.
 */
const SHELF_STATE = "queued";

/** What the shelf holds. */
export interface QueueFeed {
  /** Items still queued, oldest first — the order they will be delivered in. */
  readonly items: readonly QueueItemSummary[];
  /** Whether the subscription has delivered anything yet. */
  readonly hasRead: boolean;
  /** The refusal a cancel came back with, keyed by the item it was asked for. */
  readonly cancelRefusalByItemId: ReadonlyMap<string, ConsoleRefusal>;
  readonly cancelItem: (queueItemId: string) => void;
}

/**
 * Open the queue subscription for one session.
 *
 * The delivered payload is parsed through the registered `QueueItemSummarySchema`
 * before it reaches the shelf: the stream's payload type is `unknown` on this
 * bridge, and a shelf that rendered whatever arrived would render a row for a
 * malformed emission as confidently as for a real one.
 */
export function useQueueFeed(bridge: ConsoleBridge, sessionId: string): QueueFeed {
  const [itemsById, setItemsById] = useState<ReadonlyMap<string, QueueItemSummary>>(
    () => new Map(),
  );
  const [hasRead, setHasRead] = useState(false);
  const [cancelRefusalByItemId, setCancelRefusalByItemId] = useState<
    ReadonlyMap<string, ConsoleRefusal>
  >(() => new Map());
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    // `run.subscribeQueue` is session-scoped by its registered request shape, so the
    // shelf parses that shape before opening. A session the wire's own brand refuses
    // leaves the shelf unopened rather than tailing an unscoped stream.
    const subscribeRequest = RunQueueSubscribeRequestSchema.safeParse({ sessionId });
    if (!subscribeRequest.success) {
      return () => {
        isMounted.current = false;
      };
    }
    const unsubscribe = subscribeDaemon(
      bridge,
      { method: QUEUE_SUBSCRIBE_STREAM, request: subscribeRequest.data },
      (payload) => {
        const parsed = QueueItemSummarySchema.safeParse(payload);
        if (!parsed.success) {
          return;
        }
        const item = parsed.data;
        setHasRead(true);
        setItemsById((held) => nextItems(held, item));
      },
    );
    return () => {
      isMounted.current = false;
      unsubscribe();
    };
  }, [bridge, sessionId]);

  const cancelItem = useCallback(
    (queueItemId: string) => {
      void callDaemon(bridge, QUEUE_CANCEL_METHOD, { queueItemId })
        .then(() => {
          // Deliberately nothing. The reply confirms the request, and the row
          // leaves on the emission that reports the new state.
        })
        .catch((rejection: unknown) => {
          if (!isMounted.current) {
            return;
          }
          const wireError = normalizeWireRejection(rejection, { total: true });
          setCancelRefusalByItemId((held) => {
            const next = new Map(held);
            next.set(queueItemId, refuse(QUEUE_REFUSAL_ORIGIN, wireError.name, wireError.message));
            return next;
          });
        });
    },
    [bridge],
  );

  const items = useMemo(() => [...itemsById.values()].sort(byCreationThenId), [itemsById]);

  return { items, hasRead, cancelRefusalByItemId, cancelItem };
}

/**
 * Fold one emission into the held map.
 *
 * A state that is not `queued` DELETES rather than updates: the shelf's whole
 * contract is "what this participant has waiting", and a delivered item that stayed
 * as a greyed row would make the shelf a history nobody asked it to keep.
 */
function nextItems(
  held: ReadonlyMap<string, QueueItemSummary>,
  item: QueueItemSummary,
): ReadonlyMap<string, QueueItemSummary> {
  const next = new Map(held);
  if (item.state === SHELF_STATE) {
    next.set(item.id, item);
  } else {
    next.delete(item.id);
  }
  return next;
}

/**
 * Oldest first, with the id breaking an exact tie.
 *
 * There is no reorder control anywhere in this surface, so the order shown is the
 * daemon's own and a tie has to resolve the same way on every render — otherwise
 * two rows created in one millisecond would swap places on an unrelated update.
 */
function byCreationThenId(left: QueueItemSummary, right: QueueItemSummary): number {
  if (left.createdAt === right.createdAt) {
    return left.id.localeCompare(right.id);
  }
  return left.createdAt < right.createdAt ? -1 : 1;
}
