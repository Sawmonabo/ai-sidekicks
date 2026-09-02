// The session stream's decoder: one delivered wire envelope in, one console event
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
//
// WHAT ARRIVES HERE. `session.subscribe` is registered as a long-lived consumer of
// the canonical `EventEnvelope`, so the delivery is that envelope and this module
// parses it with the registered schema rather than with a hand-written reader. The
// two mappings below are the whole of the translation, and both were the defect
// that made this module worth rewriting: the wire's event type is `type` and this
// projection calls it `kind`, and the wire's attribution is `actor` where this
// projection calls it `actorParticipantId`. A reader that looked for the console's
// own names found neither, refused every live delivery as unreadable, and agreed
// perfectly with a fixture that was handing it the console's shape to begin with.
// `bridge/scenario-envelope.ts` closes the second half of that: the fixture now
// composes the same registered envelope, so this parse is the one door both bridges
// deliver through.

import { EventEnvelopeSchema } from "@ai-sidekicks/contracts";

import type { ConsoleSessionEvent } from "../store/index.js";

/**
 * Narrow a delivered wire envelope into the console's own event shape, or refuse it.
 *
 * The parse is the registered `EventEnvelopeSchema` — the version-TOLERANT carrier
 * layer, deliberately, because a session log carries event types whose payload
 * variants this console does not know and the strict layer would refuse every one
 * of them. The carrier still fixes the canonical membership and validates every
 * member the console goes on to hold: `id` non-empty (it is the handle every later
 * read of this event's body is keyed by, and an empty one resolves to nothing),
 * `sessionId` a branded session identifier, `sequence` a non-negative integer (the
 * store's dedupe set, cursor, and gap detection all key on it, and a fractional one
 * would make `cursor + 1` name a position no event can occupy), `occurredAt` an ISO
 * instant, and `payload` a keyed record rather than an array.
 *
 * The two renames are the only translation, and each is a rename rather than a
 * reading: `type` is carried to `kind` verbatim, and `actor` to
 * `actorParticipantId` verbatim. The wire supplies no discriminator on `actor` —
 * the contract registers it as a participant id, an agent id, or `null` for a
 * system-emitted event — so this boundary carries whichever id the daemon named and
 * turns both no-value states, present-`null` and absent, into `undefined`. Guessing
 * which of the two id kinds is in hand would be inventing an arm the wire does not
 * send; dropping the member instead would leave every event in the store
 * unattributed.
 */
export function readConsoleSessionEvent(
  deliveredEnvelope: unknown,
): ConsoleSessionEvent | undefined {
  const parsed = EventEnvelopeSchema.safeParse(deliveredEnvelope);
  if (!parsed.success) {
    return undefined;
  }
  const envelope = parsed.data;
  return {
    id: envelope.id,
    sessionId: envelope.sessionId,
    sequence: envelope.sequence,
    kind: envelope.type,
    occurredAt: envelope.occurredAt,
    ...(envelope.actor === undefined || envelope.actor === null
      ? {}
      : { actorParticipantId: envelope.actor }),
    payload: envelope.payload,
  };
}
