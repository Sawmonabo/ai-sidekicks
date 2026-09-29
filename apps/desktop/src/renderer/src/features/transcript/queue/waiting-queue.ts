// What the shelf's question is, asked of the session's one queue reading.
//
// The shelf answers "what have I got waiting"; the transcript's pending rows answer
// "what is in the queue, including what has left it". The difference is one
// predicate: a row the daemon has stopped calling `queued` is exactly the row the shelf
// drops. So the read is shared and the question stays the shelf's own.
//
// `admitted`, `superseded`, `canceled`, and `not_delivered` are all the daemon saying the
// item is not waiting, so all four leave the shelf by this one rule rather than by
// four special cases, and none of them is deleted from the reading, which the transcript's
// pending rows still render.

import type { QueueItemSummary } from "@ai-sidekicks/contracts";

/** The one queue state the shelf renders. */
const WAITING_STATE = "queued";

/** The rows still waiting, in the reading's own canonical order. */
export function waitingQueueRows(items: readonly QueueItemSummary[]): readonly QueueItemSummary[] {
  return items.filter((item) => item.state === WAITING_STATE);
}
