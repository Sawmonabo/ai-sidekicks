// Every reader answers on a registered value and refuses on one the wire would not
// take — and the refusing half is the whole point, because the defect these replaced
// was a cast, which has no refusing half at all.

import { describe, expect, it } from "vitest";
import type { RunState } from "@ai-sidekicks/contracts";

import {
  isLiveRunState,
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

describe("the liveness predicate answers over the same closed union", () => {
  it("treats every non-terminal state as live and every terminal as not", () => {
    for (const state of ["queued", "starting", "running", "paused"] as const) {
      expect(isLiveRunState(state)).toBe(true);
    }
    for (const state of ["completed", "interrupted", "failed"] as const) {
      expect(isLiveRunState(state)).toBe(false);
    }
  });

  it("counts the two waiting states as live", () => {
    // A blocked run is still the daemon's to move, so an act addressed to it is
    // still meaningful — a waiting run has a turn a restart would interrupt.
    expect(isLiveRunState("waiting_for_approval")).toBe(true);
    expect(isLiveRunState("waiting_for_input")).toBe(true);
  });

  it("negative control: a state this build has never heard is not called live", () => {
    // The reason the set is written positively rather than as a negation of the
    // three terminals. A tenth state lands outside it and is not asserted finished
    // — and is not asserted live either, which is the honest answer for a word the
    // console cannot read.
    expect(isLiveRunState("hibernating" as RunState)).toBe(false);
  });
});
