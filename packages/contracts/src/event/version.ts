// The leaf of the session-event contracts: the envelope-version brand and the shared per-field
// length cap. `event/envelope.ts` re-exports all of it.
//
// This module must never import an `event/*.js` module, directly or through what it imports:
// every schema here is an eager module-scope initializer, and a cycle among those throws at import.
import { z } from "zod";

/**
 * The `"MAJOR.MINOR"` shape of an {@link EventEnvelopeVersion}. It rejects leading zeros
 * ("01.0", "1.01") and single-segment or three-segment forms ("1", "1.0.0").
 */
export const EVENT_ENVELOPE_VERSION_PATTERN: RegExp = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The longest {@link EventEnvelopeVersion}, checked before the pattern. It bounds parse cost:
 * `compareEventEnvelopeVersion` parses segments with `BigInt`, which is super-linear in digit
 * count, so a regex-valid segment of unbounded digits would drive unbounded work.
 */
export const EVENT_ENVELOPE_VERSION_MAX_LEN = 64;

/** A producer-set `"MAJOR.MINOR"` protocol version; see {@link EventEnvelopeVersionSchema}. */
export type EventEnvelopeVersion = string & {
  readonly __brand: "EventEnvelopeVersion";
};
/**
 * Parses an {@link EventEnvelopeVersion}, checking length and format only; an out-of-range version
 * is refused at the protocol handshake, never here.
 */
export const EventEnvelopeVersionSchema: z.ZodType<EventEnvelopeVersion> = z
  .string()
  .max(EVENT_ENVELOPE_VERSION_MAX_LEN, {
    message: `EventEnvelopeVersion must be at most ${EVENT_ENVELOPE_VERSION_MAX_LEN} characters.`,
  })
  .regex(EVENT_ENVELOPE_VERSION_PATTERN, {
    message: 'EventEnvelopeVersion must be a "MAJOR.MINOR" semver string.',
  })
  .brand<"EventEnvelopeVersion">() as unknown as z.ZodType<EventEnvelopeVersion>;

/**
 * The cap on the envelope's free-form strings (id, actor, correlation and causation ids), with
 * room for composite ids beyond a 36-character UUID.
 */
export const EVENT_FIELD_MAX_LEN = 256;
