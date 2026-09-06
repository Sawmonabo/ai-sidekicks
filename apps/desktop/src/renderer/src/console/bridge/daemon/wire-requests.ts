// The console's readings of the three composed requests a surface builds by hand.
//
// MOST REQUESTS NEED NOTHING HERE. `callDaemon` parses every request against the
// registry before it sends one, so a surface that assembles a typed literal is
// already checked twice — once by the compiler and once at the door — and needs no
// reader of its own.
//
// THESE THREE ARE THE EXCEPTION, AND THE REASON IS THE SENTENCE. Each is a
// discriminated arm whose required members depend on which control was pressed, and
// the surface that knows which control was pressed is the only one that can say so:
// "the console could not build a request for THIS control" is actionable where the
// door's "could not build a `run.intervene` request" is not. So the surface reads the
// composed value first, refuses in its own words, and the door parses it again on the
// way out — which costs nothing and is what keeps the parse unskippable.
//
// WHY THEY LIVE HERE. A `*Schema` binding from the contracts package is importable in
// `console/bridge/**` and nowhere else, so a family above consumes a typed reader and
// never a validator. That is the same rule the identifier readers next door follow,
// for the same reason: the wire's shapes are read at the wire's edge, once.
//
// EACH ANSWERS THE VALUE OR `undefined`. No refusal is minted and no sentence is
// composed — the caller owns both, because the caller is what knows the control, the
// surface and the person's next move.

import {
  InterruptRunParamsSchema,
  InterventionRequestPayloadSchema,
  QueueItemCreateRequestSchema,
  type InterruptRunParams,
  type InterventionRequestPayload,
  type QueueItemCreateRequest,
} from "@ai-sidekicks/contracts";

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

/** The interrupt the wire admits, or `undefined` where the request did not compose. */
export function readInterruptRunParams(candidate: unknown): InterruptRunParams | undefined {
  const parsed = InterruptRunParamsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
