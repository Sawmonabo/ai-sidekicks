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
// projection calls it `actorId`. A reader that looked for the console's
// own names found neither, refused every live delivery as unreadable, and agreed
// perfectly with a fixture that was handing it the console's shape to begin with.
// `bridge/scenario-envelope.ts` closes the second half of that: the fixture now
// composes the same registered envelope, so this parse is the one door both bridges
// deliver through.
//
// WHAT THE TOLERANT CARRIER DOES NOT CHECK, AND WHY THIS MODULE HAS TO. The
// contracts package splits the two layers on purpose: the ENVELOPE layer is the
// version-tolerant carrier, and the STRICT layer is "the interpretation surface,
// where unknown types and category/type mismatches fail loud at parse time". Only
// the first of those runs here. So an envelope pairing `run.running` with
// `membership_change` parses — both members are individually registered — and this
// boundary used to drop `category` on the floor, after which every projector routes
// on `kind` alone and mutates the run partition off a pair the strict layer rejects.
// The census is exported for exactly this: `SESSION_EVENT_CATEGORY_BY_TYPE` is
// published so "consumers (projectors, replay machinery, integrity verifiers in
// Plan-006) can assert category/type consistency without re-parsing the schema", and
// that is the check below.

import {
  EventEnvelopeSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  type SessionEventType,
} from "@ai-sidekicks/contracts";

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
 * `actorId` verbatim. The wire supplies no discriminator on `actor` —
 * the contract registers it as a participant id, an agent id, or `null` for a
 * system-emitted event — so this boundary carries whichever id the daemon named and
 * turns both no-value states, present-`null` and absent, into `undefined`. Guessing
 * which of the two id kinds is in hand would be inventing an arm the wire does not
 * send; dropping the member instead would leave every event in the store
 * unattributed.
 *
 * `category` is then checked and NOT carried. Checked, because for a type the
 * census knows there is exactly one registered category and a delivery naming any
 * other is one the strict layer refuses — so this boundary refuses it too, with the
 * one refusal shape it has. Not carried, because no reader of `ConsoleSessionEvent`
 * reads a category: every projector above routes on `kind`, and a member minted
 * ahead of its reader is what this package's structure rules forbid. For a type the
 * census does NOT know the check does not apply and tolerance stands unchanged —
 * forward compatibility is the whole reason the tolerant carrier was chosen here,
 * and refusing an unregistered pairing would refuse exactly the higher-MINOR
 * deliveries the tolerant layer exists to let through.
 */
export function readConsoleSessionEvent(
  deliveredEnvelope: unknown,
): ConsoleSessionEvent | undefined {
  const parsed = EventEnvelopeSchema.safeParse(deliveredEnvelope);
  if (!parsed.success) {
    return undefined;
  }
  const envelope = parsed.data;
  // The census is keyed to the `SessionEventType` union and the envelope's `type` is
  // a bounded free-form string, so the lookup is cast at the call: a `ReadonlyMap`
  // resolves an unregistered key — prototype-chain names included — to `undefined`,
  // which is the "census does not know this type" arm and never a truthy answer.
  const registeredCategory = SESSION_EVENT_CATEGORY_BY_TYPE.get(envelope.type as SessionEventType);
  if (registeredCategory !== undefined && envelope.category !== registeredCategory) {
    return undefined;
  }
  return {
    id: envelope.id,
    sessionId: envelope.sessionId,
    sequence: envelope.sequence,
    kind: envelope.type,
    occurredAt: envelope.occurredAt,
    ...(envelope.actor === undefined || envelope.actor === null ? {} : { actorId: envelope.actor }),
    payload: envelope.payload,
  };
}
