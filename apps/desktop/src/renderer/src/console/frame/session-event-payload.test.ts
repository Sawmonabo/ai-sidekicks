// The decode boundary reads the wire's envelope, and refuses the console's own shape.
//
// Both halves matter, and only together. The defect this file was written for was
// invisible from either side alone: the boundary read `kind` and `actorId`
// — the console's projection names — so it refused every canonical `EventEnvelope`
// the daemon sends, while the fixture handed it the console's shape and every
// fixture assertion agreed. So the positive case here parses a REGISTERED envelope,
// which the old reader could not admit, and the negative control refuses the
// authoring record, which the old reader admitted happily. Either one alone passes
// against a boundary that reads the wrong wire.
//
// The envelopes below are written out member by member rather than composed by
// `bridge/scenario-envelope.ts`: the composer is what the fixture uses, and a test
// that fed this boundary the composer's output would prove the two agree with each
// other and nothing about whether either agrees with the contract.

import { describe, expect, it } from "vitest";

import { readConsoleSessionEvent } from "./session-event-payload.js";

/** A session id the branded schema accepts. */
const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a99a9";

/** The daemon's opaque row id for the event under test. */
const EVENT_ID = "019b79ee-0280-7ea1-8110-e5e0d1159901";

/** The participant a participant-attributed envelope names. */
const PARTICIPANT_ID = "019b79ee-0280-79a4-8110-cca0117a0110";

const OCCURRED_AT = "2026-01-01T14:20:00.500Z";

/**
 * One canonical envelope, spelled as `packages/contracts` declares it.
 *
 * `overrides` is `Record<string, unknown>` rather than a partial envelope on
 * purpose: several cases below vary a member to a value the contract forbids, and a
 * typed partial would refuse to express exactly the deliveries this boundary exists
 * to reject.
 */
function registeredEnvelope(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: EVENT_ID,
    sessionId: SESSION_ID,
    sequence: 7,
    occurredAt: OCCURRED_AT,
    category: "run_lifecycle",
    type: "run.running",
    payload: { runId: SESSION_ID, newState: "running" },
    version: "1.0",
    ...overrides,
  };
}

describe("readConsoleSessionEvent — the registered envelope", () => {
  it("decodes a wire envelope into the console's event, carrying its type as the kind", () => {
    const decoded = readConsoleSessionEvent(registeredEnvelope({ actor: PARTICIPANT_ID }));

    expect(decoded).toStrictEqual({
      id: EVENT_ID,
      sessionId: SESSION_ID,
      sequence: 7,
      kind: "run.running",
      occurredAt: OCCURRED_AT,
      actorId: PARTICIPANT_ID,
      payload: { runId: SESSION_ID, newState: "running" },
    });
  });

  it("decodes a system-emitted envelope with no actor at all", () => {
    // `actor: null` is the wire's system arm — the canonical set's only nullable
    // member. It has to reach the console as an ABSENCE and not as the string
    // "null" or an empty id, because the store admits every actor it is handed to
    // the participant hue allocator.
    const decoded = readConsoleSessionEvent(registeredEnvelope({ actor: null }));

    expect(decoded?.actorId).toBeUndefined();
    expect(decoded?.kind).toBe("run.running");
  });

  it("decodes an envelope that omits the actor key entirely", () => {
    // The other no-value state. Absent and present-null are wire-distinguishable
    // and both mean nobody is named, so both settle the same way here.
    const decoded = readConsoleSessionEvent(registeredEnvelope());

    expect(decoded?.actorId).toBeUndefined();
  });
});

describe("readConsoleSessionEvent — what it refuses", () => {
  it("negative control: refuses the console's own projection shape", () => {
    // THE control for this file. This is exactly what the fixture used to deliver
    // and what the old boundary admitted: the console's field names, no `category`
    // and no `version`. A boundary that still reads the projection passes every
    // other case here and fails this one.
    const decoded = readConsoleSessionEvent({
      id: EVENT_ID,
      sessionId: SESSION_ID,
      sequence: 7,
      kind: "run.running",
      occurredAt: OCCURRED_AT,
      actorId: PARTICIPANT_ID,
      payload: {},
    });

    expect(decoded).toBeUndefined();
  });

  it("refuses an envelope carrying no event id", () => {
    // The id is the handle every later read of this event's body is keyed by, so a
    // delivery without one would put a row in the store no surface could open —
    // and composing one out of the members that ARE present would look identical
    // from every other assertion in this file.
    expect(readConsoleSessionEvent(registeredEnvelope({ id: "" }))).toBeUndefined();
  });

  it("refuses an envelope whose sequence is not a whole position", () => {
    // The store's dedupe set, cursor, and gap detection all key on `sequence`. A
    // fractional one makes `cursor + 1` name a position no event can occupy, so the
    // session is permanently degraded by a gap that never closes.
    expect(readConsoleSessionEvent(registeredEnvelope({ sequence: 1.5 }))).toBeUndefined();
  });

  it("refuses an envelope whose session id is not the identifier the contract declares", () => {
    expect(
      readConsoleSessionEvent(registeredEnvelope({ sessionId: "session-flagship" })),
    ).toBeUndefined();
  });

  it("refuses an envelope whose payload is an array rather than a keyed record", () => {
    // An array is `typeof "object"`. Admitting one hands every projector a value
    // whose named members are all `undefined` at a type that says they are readable.
    expect(readConsoleSessionEvent(registeredEnvelope({ payload: [] }))).toBeUndefined();
  });

  it("refuses a delivery that is not an object at all", () => {
    expect(readConsoleSessionEvent(undefined)).toBeUndefined();
    expect(readConsoleSessionEvent(null)).toBeUndefined();
    expect(readConsoleSessionEvent("run.running")).toBeUndefined();
  });
});
