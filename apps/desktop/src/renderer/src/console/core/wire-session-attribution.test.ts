// The two arms of one rule: whether a payload's own session may speak for the
// envelope that delivered it.
//
// The cases worth having are the ones where the two arms ANSWER DIFFERENTLY, because
// that difference is the whole reason there are two — a fold whose contract requires
// the member and a fold whose contract forbids it cannot share one predicate, and a
// caller that picked the wrong arm either refuses every real frame or admits a foreign
// one. The rest is the reading of a raw member: absence, a wrong type, and a value
// that merely looks equal.

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
    expect(payloadNamesSession({ participantId: "participant-priya" }, SESSION_ID)).toBe(false);
    expect(payloadNamesSession(undefined, SESSION_ID)).toBe(false);
  });

  it("refuses a non-string session rather than reading it as absence", () => {
    // The comparison is against the RAW member. Read through a string predicate first,
    // each of these would arrive as `undefined` — and a rule whose absence arm is
    // "refuse" would still refuse them, which is why the reading only shows up on the
    // contradiction arm below, where absence is admitted.
    expect(payloadNamesSession({ sessionId: 42 }, SESSION_ID)).toBe(false);
    expect(payloadNamesSession({ sessionId: null }, SESSION_ID)).toBe(false);
    expect(payloadNamesSession({ sessionId: [SESSION_ID] }, SESSION_ID)).toBe(false);
  });
});

describe("the contradiction arm — a payload whose contract carries none", () => {
  it("admits a payload naming no session at all", () => {
    // The arm's whole point, and the case that separates it from the other one:
    // `membership.created` registers a strict payload with no `sessionId` in it, so a
    // fold on the required arm would refuse every admission a daemon sends.
    expect(payloadContradictsSession({ participantId: "participant-priya" }, SESSION_ID)).toBe(
      false,
    );
    expect(payloadContradictsSession(undefined, SESSION_ID)).toBe(false);
  });

  it("admits a payload that names the envelope's own session anyway", () => {
    expect(payloadContradictsSession({ sessionId: SESSION_ID }, SESSION_ID)).toBe(false);
  });

  it("refuses a present member naming another session", () => {
    expect(payloadContradictsSession({ sessionId: FOREIGN_SESSION_ID }, SESSION_ID)).toBe(true);
  });

  it("refuses a present member of the wrong type", () => {
    // Where the raw comparison earns its keep. Read through a string predicate, a
    // numeric `sessionId` would be absence — and absence is ADMITTED on this arm, so a
    // frame carrying one would be waved through into a partition it may not name.
    expect(payloadContradictsSession({ sessionId: 42 }, SESSION_ID)).toBe(true);
    expect(payloadContradictsSession({ sessionId: null }, SESSION_ID)).toBe(true);
  });

  it("negative control: the two arms disagree exactly on the absent member", () => {
    // Without this the pair could both be the required rule under two names, and every
    // case above would still pass — the admission fold would then refuse every real
    // frame and the roster would be empty in a console that is working.
    const withoutSession = { participantId: "participant-priya" };
    expect(payloadNamesSession(withoutSession, SESSION_ID)).toBe(false);
    expect(payloadContradictsSession(withoutSession, SESSION_ID)).toBe(false);
  });
});
