// The two arms of one rule: whether a payload's own session may speak for its envelope. The cases
// that matter are where the arms answer differently, since a caller picking the wrong arm either
// refuses every real frame or admits a foreign one; the rest is the raw member: absent, wrongly
// typed, or merely looking equal.

import { describe, expect, it } from "vitest";

import { payloadContradictsSession, payloadNamesSession } from "./wire-session-attribution.js";

const SESSION_ID = "session-under-test";
const FOREIGN_SESSION_ID = "session-somebody-else";

describe("the required arm — a payload whose contract carries a session", () => {
  it("admits a payload naming the envelope's own session", () => {
    expect(payloadNamesSession({ sessionId: SESSION_ID }, SESSION_ID)).toBe(true);
  });

  it("refuses a payload naming another session", () => {
    expect(payloadNamesSession({ sessionId: FOREIGN_SESSION_ID }, SESSION_ID)).toBe(false);
  });

  it("refuses a payload naming no session, because the member is required", () => {
    expect(payloadNamesSession({ userId: "user-priya" }, SESSION_ID)).toBe(false);
    expect(payloadNamesSession(undefined, SESSION_ID)).toBe(false);
  });

  it("refuses a non-string session rather than reading it as absence", () => {
    // The comparison is against the raw member. Through a string predicate each of these would be
    // `undefined`; this arm refuses absence anyway, so the difference shows on the contradiction
    // arm below, where absence is admitted.
    expect(payloadNamesSession({ sessionId: 42 }, SESSION_ID)).toBe(false);
    expect(payloadNamesSession({ sessionId: null }, SESSION_ID)).toBe(false);
    expect(payloadNamesSession({ sessionId: [SESSION_ID] }, SESSION_ID)).toBe(false);
  });
});

describe("the contradiction arm — a payload whose contract carries none", () => {
  it("admits a payload naming no session at all", () => {
    // What separates this arm from the other: a strict payload with no `sessionId` would be refused
    // on every real frame by the required arm.
    expect(payloadContradictsSession({ userId: "user-priya" }, SESSION_ID)).toBe(false);
    expect(payloadContradictsSession(undefined, SESSION_ID)).toBe(false);
  });

  it("admits a payload that names the envelope's own session anyway", () => {
    expect(payloadContradictsSession({ sessionId: SESSION_ID }, SESSION_ID)).toBe(false);
  });

  it("refuses a present member naming another session", () => {
    expect(payloadContradictsSession({ sessionId: FOREIGN_SESSION_ID }, SESSION_ID)).toBe(true);
  });

  it("refuses a present member of the wrong type", () => {
    // Through a string predicate a numeric `sessionId` would be absence, which this arm admits, so
    // the frame would land in a partition it may not name.
    expect(payloadContradictsSession({ sessionId: 42 }, SESSION_ID)).toBe(true);
    expect(payloadContradictsSession({ sessionId: null }, SESSION_ID)).toBe(true);
  });

  it("negative control: the two arms disagree exactly on the absent member", () => {
    // Without this the two arms could be the same rule under two names and every case above
    // would still pass.
    const withoutSession = { userId: "user-priya" };
    expect(payloadNamesSession(withoutSession, SESSION_ID)).toBe(false);
    expect(payloadContradictsSession(withoutSession, SESSION_ID)).toBe(false);
  });
});
