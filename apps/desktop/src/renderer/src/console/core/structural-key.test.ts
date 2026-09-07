// The one property this encoder owes: two different tuples never share a key.
//
// Every case below is a pair that a JOINED key collapses, which is what makes them
// cases rather than restatements of "different inputs, different outputs": the
// delimiter moved between segments, the delimiter is inside a segment, a segment is
// empty, or the tuples are the same segments at different arity. The last case in the
// suite is the negative control — the encoder still answers ONE key for one tuple, so
// a key that were merely random would fail here rather than pass everything above.

import { describe, expect, it } from "vitest";

import { structuralKey } from "./structural-key.js";

describe("structuralKey", () => {
  it("keys one tuple the same way twice", () => {
    expect(structuralKey(["/work/atlas", "filesystem"])).toBe(
      structuralKey(["/work/atlas", "filesystem"]),
    );
  });

  it("keys two tuples apart when a space moves across the boundary between them", () => {
    // The reported collision, spelled exactly: under a space join both tuples read
    // `/repo one server`, so one binding's outcome lands on the other's control.
    expect(structuralKey(["/repo one", "server"])).not.toBe(structuralKey(["/repo", "one server"]));
  });

  it("keys two tuples apart when a segment contains the encoding's own delimiters", () => {
    expect(structuralKey(['a"b', "c"])).not.toBe(structuralKey(["a", 'b"c']));
    expect(structuralKey(["a\\", "b"])).not.toBe(structuralKey(["a", "\\b"]));
  });

  it("keys an empty segment apart from an absent one", () => {
    expect(structuralKey(["claude", "user", "", "filesystem"])).not.toBe(
      structuralKey(["claude", "user", "filesystem"]),
    );
  });

  it("keys the same segments in a different order apart", () => {
    expect(structuralKey(["left", "right"])).not.toBe(structuralKey(["right", "left"]));
  });

  // The negative control for the five above: an encoder that answered a fresh string
  // per call would satisfy every inequality here and be useless as a key. Asserted
  // over a `Map`, which is what the callers actually build.
  it("puts one tuple in one map slot however many times it is encoded", () => {
    const slots = new Map<string, number>();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      slots.set(structuralKey(["acct-claude-team", "weekly_all"]), attempt);
    }
    expect(slots.size).toBe(1);
  });
});
