// The one wire call a resolved send makes, and how its reply settles. The call is supplied by
// the caller, so this module reaches no bridge and a rejected call propagates.

import type {
  QueueItemCreateRequest,
  QueueItemCreateResponse,
} from "@ai-sidekicks/contracts/run/queue";

import type { ComposerMessageOutcome } from "./resolutions.js";

/** The daemon call a send makes, supplied by whoever holds the wire. */
export interface ComposerSendCalls {
  queueCreate(request: QueueItemCreateRequest): Promise<QueueItemCreateResponse>;
}

/**
 * Dispatch one message. The queued item is not kept: the transcript's pending rows read the
 * queue from their own subscription, so the answer is only the confirmation.
 */
export async function dispatchQueuedMessage(
  calls: ComposerSendCalls,
  request: QueueItemCreateRequest,
): Promise<ComposerMessageOutcome> {
  await calls.queueCreate(request);
  return { status: "sent" };
}
