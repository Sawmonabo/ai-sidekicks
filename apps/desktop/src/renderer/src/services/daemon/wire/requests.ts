// Readers for the composed requests a caller builds by hand. `callDaemon` checks every request
// before sending it, so most callers need no reader. These are requests whose members come from
// the view, and only the view can say "the app could not build a request for this control", so
// it reads the composed value first and `callDaemon` checks it again on the way out. A generated
// contracts check is importable only in `services/`, so features consume a typed reader. Each
// returns the value or `undefined`; the caller composes any refusal.

import {
  validateAgentQueueItemCreateRequest,
  type AgentQueueItemCreateRequest,
} from "@ai-sidekicks/contracts/run/queue";
import {
  validateAgentRunInterveneRequest,
  type AgentRunInterveneRequest,
} from "@ai-sidekicks/contracts/run/intervention";

/** The queue-create the wire admits, or `undefined` where the request did not compose. */
export function readQueueItemCreateRequest(
  candidate: unknown,
): AgentQueueItemCreateRequest | undefined {
  return validateAgentQueueItemCreateRequest(candidate) ? candidate : undefined;
}

/**
 * The intervention on a live run the wire admits, or `undefined` where the request did not
 * compose.
 *
 * @consumedBy the client-facing driver interrupt
 */
export function readAgentRunInterveneRequest(
  candidate: unknown,
): AgentRunInterveneRequest | undefined {
  return validateAgentRunInterveneRequest(candidate) ? candidate : undefined;
}
