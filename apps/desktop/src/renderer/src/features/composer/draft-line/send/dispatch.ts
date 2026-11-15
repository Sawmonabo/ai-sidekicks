// The one wire call a resolved send makes, and how its reply settles. The call is supplied by
// the caller, so this module reaches no bridge and a rejected call propagates.

import type {
  AgentQueueItemCreateRequest,
  AgentQueueItemCreateResponse,
} from "@ai-sidekicks/contracts/run/queue";

import type { ComposerMessageOutcome } from "./resolutions.js";

/** The daemon call a send makes, supplied by whoever holds the wire. */
export interface ComposerSendCalls {
  queueCreate(request: AgentQueueItemCreateRequest): Promise<AgentQueueItemCreateResponse>;
}

/**
 * Dispatch one message, answering the queue item the service made of it, which the message's
 * row in the transcript settles under.
 */
export async function dispatchQueuedMessage(
  calls: ComposerSendCalls,
  request: AgentQueueItemCreateRequest,
): Promise<ComposerMessageOutcome> {
  const created = await calls.queueCreate(request);
  return { status: "sent", queueItemId: created.queueItemId };
}
