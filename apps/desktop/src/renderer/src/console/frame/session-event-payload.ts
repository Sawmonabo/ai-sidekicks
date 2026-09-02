// The session stream's decoder: one delivered wire payload in, one console event
// out, or a refusal.
//
// `store/entities.ts` says where this belongs: `ConsoleSessionEvent` is a
// renderer-local projection contract rather than a wire type, and "the bridge
// adapter narrows a payload into this shape at the boundary, so exactly one module
// knows the wire and everything above it reads this". This module is that boundary
// for the session stream — the only place in the console that reads fields off an
// `unknown` the bridge handed over.
//
// It lives beside `session-event-binder.ts` rather than inside it because they are
// two jobs with two failure modes. The binder owns a LIFECYCLE — which sessions
// hold a wire subscription, when one opens, when one is released — and is wrong
// when a subscription outlives its store or a session is bound twice. This module
// owns a GRAMMAR, and is wrong when a payload the console could have projected is
// refused, or when one it could not is admitted. Nothing here holds state, and
// nothing here can reach the registry or the bridge.

import type { ConsoleSessionEvent } from "../store/index.js";

/** The members read off a delivered payload, before anything is known about them. */
interface DeliveredPayloadShape {
  readonly id?: unknown;
  readonly sessionId?: unknown;
  readonly sequence?: unknown;
  readonly kind?: unknown;
  readonly occurredAt?: unknown;
  readonly actorParticipantId?: unknown;
  readonly payload?: unknown;
}

/**
 * Narrow a wire payload into the console's own event shape, or refuse it.
 *
 * It narrows and it does not TRANSLATE. Where a delivered payload names its fields
 * differently the answer is a refusal, not a guess: a mapping invented here would
 * put wire member names in a module that has no contract to check them against,
 * and a mis-mapped field renders as confidently as a correct one.
 *
 * `sequence` must be an integer because the store's dedupe set, cursor, and gap
 * detection all key on it — a fractional sequence would make `cursor + 1` name a
 * position no event can ever occupy, and the session would be permanently
 * degraded by a gap that never closes.
 *
 * `id` must be a non-empty string for a different reason: it is `EventEnvelope`'s
 * own opaque identifier, the handle every later read of this event's body is keyed
 * by, and an empty one resolves to nothing. A payload without it is not an event
 * envelope, so admitting it would put a row in the store that no surface could ever
 * open — and refusing here is what keeps the alternative (composing an id out of
 * the members that are present) from being reachable at all.
 */
export function readConsoleSessionEvent(
  deliveredPayload: unknown,
): ConsoleSessionEvent | undefined {
  if (typeof deliveredPayload !== "object" || deliveredPayload === null) {
    return undefined;
  }
  const { id, sessionId, sequence, kind, occurredAt, actorParticipantId, payload } =
    deliveredPayload as DeliveredPayloadShape;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof sessionId !== "string" ||
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    typeof kind !== "string" ||
    typeof occurredAt !== "string"
  ) {
    return undefined;
  }
  if (actorParticipantId !== undefined && typeof actorParticipantId !== "string") {
    return undefined;
  }
  if (
    payload !== undefined &&
    (typeof payload !== "object" || payload === null || Array.isArray(payload))
  ) {
    // An array is `typeof "object"` and is not a keyed payload. Admitting one
    // would hand every projector a value whose named members are all `undefined`
    // at a type that says they are readable.
    return undefined;
  }
  return {
    id,
    sessionId,
    sequence,
    kind,
    occurredAt,
    ...(actorParticipantId === undefined ? {} : { actorParticipantId }),
    // The one cast: the checks above establish a non-null object, which is all a
    // projector may assume about a payload it has not claimed a kind for.
    ...(payload === undefined ? {} : { payload: payload as Readonly<Record<string, unknown>> }),
  };
}
