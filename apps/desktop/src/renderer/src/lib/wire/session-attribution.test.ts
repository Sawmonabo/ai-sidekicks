// Whether a payload's own session may speak for its envelope. A payload whose contract carries a
// session is admitted only when that session is the envelope's own, or a foreign frame lands in
// this session's partition.

import { describe, expect, it } from "vitest";

import { payloadNamesSession } from "./session-attribution.js";

const SESSION_ID = "session-under-test";
const FOREIGN_SESSION_ID = "session-somebody-else";

describe("the required arm — a payload whose contract carries a session", () => {
  it("admits a payload naming the envelope's own session", () => {
    expect(payloadNamesSession({ sessionId: SESSION_ID }, SESSION_ID)).toBe(true);
  });

  it("refuses a payload naming another session", () => {
    expect(payloadNamesSession({ sessionId: FOREIGN_SESSION_ID }, SESSION_ID)).toBe(false);
  });
});
