// What the destination says, and stops offering, per standing cause.
//
// The rule has one property that a type cannot state and that a surface silently
// violates: the two sentences have to agree. A control disabled with no cause reads
// as broken, and a cause printed beside a control that still works reads as noise. So
// both are produced by one call and every case below reads them together.

import { describe, expect, it } from "vitest";

import { sessionListDegradation } from "./session-list-degradation.js";
import type { SessionDegradedCause } from "../store/index.js";

/** Every cause the store can stand in. Transcribed, so a sixth fails a case here. */
const EVERY_CAUSE: readonly SessionDegradedCause[] = [
  "stream-diverged",
  "sequence-gap",
  "projection-failed",
  "subscription-closed",
  "read-failed",
];

describe("the degraded list's two sentences", () => {
  it("says nothing and blocks nothing while nothing is standing", () => {
    expect(sessionListDegradation(undefined)).toStrictEqual({
      lastReadSentence: undefined,
      blockedActSentence: undefined,
    });
  });

  it("produces both sentences for every cause, and neither is empty", () => {
    for (const cause of EVERY_CAUSE) {
      const degradation = sessionListDegradation(cause);

      expect(degradation.lastReadSentence, cause).toBeTypeOf("string");
      expect(degradation.blockedActSentence, cause).toBeTypeOf("string");
      expect((degradation.lastReadSentence ?? "").length, cause).toBeGreaterThan(0);
      expect((degradation.blockedActSentence ?? "").length, cause).toBeGreaterThan(0);
    }
  });

  it("says this is the last read, which is the claim the line exists to make", () => {
    expect(sessionListDegradation("subscription-closed").lastReadSentence).toContain(
      "This is the last read",
    );
  });

  it("names a different cause per cause rather than one sentence for all five", () => {
    // Without this the module could satisfy every case above with one constant, and
    // a person reading "something went wrong" would learn nothing about which thing.
    const sentences = EVERY_CAUSE.map((cause) => sessionListDegradation(cause).lastReadSentence);

    expect(new Set(sentences).size).toBe(EVERY_CAUSE.length);
  });

  it("would notice a blocked sentence that did not name its cause", () => {
    // The negative control on the second half: the acts' sentence has to carry the
    // reason too, because it is what a disabled control shows and a bare "not right
    // now" is the shape the design forbids.
    const blocked = EVERY_CAUSE.map((cause) => sessionListDegradation(cause).blockedActSentence);

    expect(new Set(blocked).size).toBe(EVERY_CAUSE.length);
  });
});
