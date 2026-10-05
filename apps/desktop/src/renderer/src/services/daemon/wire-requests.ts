// Readers for the three composed requests a caller builds by hand. `callDaemon` parses every
// request before sending it, so most callers need no reader. These three are discriminated arms
// whose required members depend on which control was pressed, and only the view can say "the
// app could not build a request for this control", so it reads the composed value first and
// `callDaemon` parses it again on the way out. A contracts `*Schema` is importable only in
// `services/`, so features consume a typed reader. Each returns the value or `undefined`; the
// caller composes any refusal.

import { InterruptRunParamsSchema } from "@ai-sidekicks/contracts/provider/driver/wire";
import {
  InterventionRequestPayloadSchema,
  type InterventionRequestPayload,
} from "@ai-sidekicks/contracts/run/control";
import {
  QueueItemCreateRequestSchema,
  type QueueItemCreateRequest,
} from "@ai-sidekicks/contracts/run/queue";
import type { InterruptRunParams } from "@ai-sidekicks/contracts/provider/driver/driver";

/** The intervention the wire admits, or `undefined` where the arm did not compose. */
export function readInterventionRequest(
  candidate: unknown,
): InterventionRequestPayload | undefined {
  const parsed = InterventionRequestPayloadSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** The queue-create the wire admits, or `undefined` where the request did not compose. */
export function readQueueItemCreateRequest(candidate: unknown): QueueItemCreateRequest | undefined {
  const parsed = QueueItemCreateRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The interrupt the wire admits, or `undefined` where the request did not compose.
 *
 * @consumedBy the client-facing driver interrupt
 */
export function readInterruptRunParams(candidate: unknown): InterruptRunParams | undefined {
  const parsed = InterruptRunParamsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
