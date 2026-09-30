// What the destination says per standing cause.

import { describe, expect, it } from "vitest";

import { sessionListDegradation } from "./session-list-degradation.js";
import type { SessionDegradedCause } from "@renderer/store/session-degradation.js";

/** Every cause the store can stand in, transcribed so a new one fails a case here. */
const EVERY_CAUSE: readonly SessionDegradedCause[] = [
  "stream-diverged",
  "sequence-gap",
  "projection-failed",
  "subscription-closed",
  "read-failed",
];

describe("the degraded list's sentence", () => {
  it("says nothing while nothing is standing", () => {
    expect(sessionListDegradation(undefined)).toStrictEqual({ lastReadSentence: undefined });
  });

  it("says this is the last read, which is the claim the line exists to make", () => {
    expect(sessionListDegradation("subscription-closed").lastReadSentence).toContain(
      "This is the last read",
    );
  });

  it("names a different cause per cause rather than one sentence for all five", () => {
    // One constant would satisfy the case above while telling the person nothing about which
    // cause stands.
    const sentences = EVERY_CAUSE.map((cause) => sessionListDegradation(cause).lastReadSentence);

    expect(new Set(sentences).size).toBe(EVERY_CAUSE.length);
  });
});
