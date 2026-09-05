// One authored beat, composed into the wire envelope the daemon would have sent.
//
// A scenario is authored in `ConsoleSessionEvent`s, which is the console's own
// projection shape and the readable way to write a script. It is NOT what the wire
// carries: `session.subscribe` is registered as a long-lived consumer of the
// canonical `EventEnvelope` (`packages/contracts/src/event.ts#EventEnvelope`), whose
// event type is `type` and whose attribution is `actor`. This module is the one
// place the first becomes the second.
//
// WHY IT HAS TO EXIST AT ALL. Without it the fixture delivered the authoring record
// verbatim, so the console's decode boundary was reading fixture-local field names
// and every fixture run agreed with it — while the live bridge delivered `type` and
// `actor`, the boundary found neither, and every real session event was refused as
// unreadable with nothing anywhere reporting a shape mismatch. A fixture that
// delivers a different shape from the wire cannot fail the way the wire fails, which
// is the only failure worth rehearsing.
//
// COMPOSING IS NOT JUDGING. What comes back is a CANDIDATE: it carries what the beat
// states and nothing it does not, so a beat naming a kind the census does not
// register composes with no `category` — which is exactly the shape
// `EventEnvelopeSchema` refuses. Substituting a category here would let the fixture
// deliver a frame no daemon can send; refusing here would move the wire's judgement
// into the composer and give the fixture a second refusal vocabulary for a defect
// the registered schema already names. The judges are those schemas, and both of
// them run: `scenarios/wire-truth.ts` parses every beat of every scenario before it
// ships, and `bridge/session-event-payload.ts` parses every delivery at the boundary.

import {
  SESSION_EVENT_CATEGORY_BY_TYPE,
  type EventCategory,
  type SessionEventType,
} from "@ai-sidekicks/contracts";

import type { ConsoleSessionEvent } from "../store/index.js";

/**
 * The envelope version every composed beat carries.
 *
 * `"MAJOR.MINOR"` per ADR-018, producer-set and never rewritten on read. It is the
 * one canonical member no beat states and no console surface reads, so the composer
 * supplies it rather than the scenario — the same position it held when only the
 * wire-truth probe composed envelopes, moved here so the probe and the delivery
 * cannot supply two different versions of one beat.
 */
export const SCENARIO_ENVELOPE_VERSION: string = "1.0";

/**
 * Every canonical envelope member, at the type an authored beat can supply.
 *
 * Deliberately not `EventEnvelope`: that type's `sessionId` and `version` are
 * branded and its `category` is required, and claiming all three of a record built
 * out of scenario text would be asserting the very thing the schemas are run to
 * find out. `category` is optional here for exactly one reason — a kind outside the
 * census has none — and that absence is the composed record's honest report that no
 * daemon emits this beat.
 */
export interface ScenarioEventEnvelopeCandidate {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  /** Absent when the beat's kind is not a registered event type. */
  readonly category?: EventCategory;
  readonly type: string;
  /** Absent when the beat attributes itself to nobody — the system arm. */
  readonly actor?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly version: string;
}

/**
 * Compose the wire envelope one beat is delivered as.
 *
 * Total: every beat composes, including a malformed one, because the caller that
 * has to decide what a malformed beat means is the schema and not this function.
 *
 * `payload` is supplied as an empty record where the beat states none, since the
 * canonical envelope's payload is required and an absent one is a member the wire
 * never omits. `actor` is the opposite case and stays absent: present-null and
 * absent are wire-distinguishable, and a beat that names no actor is not the same
 * claim as one that names the system.
 */
export function composeScenarioEventEnvelope(
  event: ConsoleSessionEvent,
): ScenarioEventEnvelopeCandidate {
  const category = SESSION_EVENT_CATEGORY_BY_TYPE.get(event.kind as SessionEventType);
  return {
    id: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    ...(category === undefined ? {} : { category }),
    type: event.kind,
    ...(event.actorId === undefined ? {} : { actor: event.actorId }),
    payload: event.payload ?? {},
    version: SCENARIO_ENVELOPE_VERSION,
  };
}
