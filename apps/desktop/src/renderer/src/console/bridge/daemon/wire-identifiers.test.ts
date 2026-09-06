// Every reader answers on a registered value and refuses on one the wire would not
// take — and the refusing half is the whole point, because the defect these replaced
// was a cast, which has no refusing half at all.

import { describe, expect, it } from "vitest";

import {
  readChannelId,
  readRunId,
  readRunState,
  readSessionId,
  readWorkspaceId,
} from "./wire-identifiers.js";

/** A registered identifier, in the shape all four brands are declared over. */
const REGISTERED_UUID = "019b7a11-1100-75e5-8510-ada11a5a33a5";

/** A label, which is what a store holds before anything has parsed it. */
const NOT_AN_IDENTIFIER = "session-composer";

describe("the identifier readers answer the wire's own value", () => {
  it("returns the identifier a registered shape admits", () => {
    expect(readSessionId(REGISTERED_UUID)).toBe(REGISTERED_UUID);
    expect(readRunId(REGISTERED_UUID)).toBe(REGISTERED_UUID);
    expect(readChannelId(REGISTERED_UUID)).toBe(REGISTERED_UUID);
    expect(readWorkspaceId(REGISTERED_UUID)).toBe(REGISTERED_UUID);
  });

  it("refuses a value the registered shape does not admit", () => {
    // The negative control the cast never had: a friendly label reaches the daemon
    // as a rejected round trip, and the reader is what turns it into a decision the
    // surface can render instead.
    expect(readSessionId(NOT_AN_IDENTIFIER)).toBeUndefined();
    expect(readRunId(NOT_AN_IDENTIFIER)).toBeUndefined();
    expect(readChannelId(NOT_AN_IDENTIFIER)).toBeUndefined();
    expect(readWorkspaceId(NOT_AN_IDENTIFIER)).toBeUndefined();
  });
});

describe("the run-state reader answers the closed union", () => {
  it("returns a state the vocabulary carries", () => {
    expect(readRunState("running")).toBe("running");
  });

  it("refuses a word this build has never heard", () => {
    // A newer daemon against an older console is the real case, and answering
    // `undefined` is what lets a surface say so rather than falling into whichever
    // arm its own branch happened to end on.
    expect(readRunState("hibernating")).toBeUndefined();
  });
});
