// The shelf's view of the session's queue reading: only rows the daemon still calls `queued`.
// `admitted`, `superseded`, `canceled` and `not_delivered` all mean not waiting and leave the
// shelf by this one rule; the reading keeps them for the transcript's pending rows.

import type { QueueItemSummary } from "@ai-sidekicks/contracts";

/** The one queue state the shelf renders. */
const WAITING_STATE = "queued";

/** The rows still waiting, in the reading's own canonical order. */
export function waitingQueueRows(items: readonly QueueItemSummary[]): readonly QueueItemSummary[] {
  return items.filter((item) => item.state === WAITING_STATE);
}
