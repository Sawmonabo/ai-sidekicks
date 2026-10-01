// The disposition is a pure function of two recorded lengths, so both arms run without
// rendering.

import { describe, expect, it } from "vitest";

import { truncatedRemainderDisposition } from "./TruncationNotice.js";

describe("whether a truncated body's remainder can be named", () => {
  it("names the remainder when a longer length was recorded", () => {
    expect(truncatedRemainderDisposition(1024, 4096)).toStrictEqual({
      kind: "claimable",
      remainderByteCount: 3072,
    });
  });

  it("has no remainder when no pre-truncation length was recorded", () => {
    expect(truncatedRemainderDisposition(1024, undefined)).toStrictEqual({
      kind: "none-recorded",
    });
  });

  it("has no remainder when the recorded length does not exceed the prefix", () => {
    // Naming zero further bytes would report content that does not exist.
    expect(truncatedRemainderDisposition(1024, 1024)).toStrictEqual({ kind: "none-recorded" });
    expect(truncatedRemainderDisposition(1024, 512)).toStrictEqual({ kind: "none-recorded" });
  });
});
