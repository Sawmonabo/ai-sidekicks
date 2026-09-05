// What the shelf's question is, asked of the session's one queue reading.
//
// The shelf answers "what have I got waiting"; the runs pane answers "what is in the
// queue, including what has left it". Those were two folds down two subscriptions,
// and the difference between them is one predicate: a row the daemon has stopped
// calling `queued` is exactly the row the shelf drops. So the read is shared and the
// question stays the shelf's own.
//
// `admitted`, `superseded`, `canceled`, and `expired` are all the daemon saying the
// item is no longer waiting, so all four leave the shelf by this one rule rather than
// by four special cases — and none of them is deleted from the reading, which the
// pane beside the composer is still rendering.

import type { QueueItemSummary } from "@ai-sidekicks/contracts";

/** The one queue state the shelf renders. */
const WAITING_STATE = "queued";

/** The rows still waiting, in the reading's own canonical order. */
export function waitingQueueRows(items: readonly QueueItemSummary[]): readonly QueueItemSummary[] {
  return items.filter((item) => item.state === WAITING_STATE);
}
