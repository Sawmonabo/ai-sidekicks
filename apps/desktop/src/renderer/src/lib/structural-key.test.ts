// Two different tuples never share a key. Each case is a pair a joined key collapses (delimiter
// moved, delimiter inside a segment, empty segment, different arity); the last case is the
// negative control that a random key would fail.

import { describe, expect, it } from "vitest";

import { structuralKey } from "./structural-key.js";

describe("structuralKey", () => {
  it("keys one tuple the same way twice", () => {
    expect(structuralKey(["/work/atlas", "filesystem"])).toBe(
      structuralKey(["/work/atlas", "filesystem"]),
    );
  });

  it("keys two tuples apart when a space moves across the boundary between them", () => {
    // Under a space join both tuples read `/repo one server`, so one binding's outcome would land
    // on the other's control.
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

  // Negative control: an encoder answering a fresh string per call would satisfy every inequality
  // above. Asserted over a `Map`, which is what callers build.
  it("puts one tuple in one map entry however many times it is encoded", () => {
    const keyedAttempts = new Map<string, number>();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      keyedAttempts.set(structuralKey(["acct-claude-team", "weekly_all"]), attempt);
    }
    expect(keyedAttempts.size).toBe(1);
  });
});
