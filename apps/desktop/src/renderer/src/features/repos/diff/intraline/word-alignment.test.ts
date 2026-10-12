// One replaced pair's word comparison: both sides read off one alignment, whitespace kept.

import { describe, expect, it } from "vitest";

import { intralineSegments } from "./word-alignment.js";

describe("intralineSegments", () => {
  it("reads both sides off one alignment, so the two highlights agree", () => {
    const pair = intralineSegments("keep alpha keep", "keep beta keep");
    expect(pair.deleted).toStrictEqual([
      { text: "keep ", changed: false },
      { text: "alpha", changed: true },
      { text: " keep", changed: false },
    ]);
    expect(pair.inserted).toStrictEqual([
      { text: "keep ", changed: false },
      { text: "beta", changed: true },
      { text: " keep", changed: false },
    ]);
  });

  it("keeps a whitespace-only change visible", () => {
    // An indentation change is a real change; a tokenizer that discarded whitespace would
    // report the two lines as identical.
    const pair = intralineSegments("  value", "    value");
    expect(pair.deleted.some((segment) => segment.changed)).toBe(true);
    expect(pair.inserted.some((segment) => segment.changed)).toBe(true);
  });

  it("marks a long stretch changed whole once its edits pass the bound, rather than aligning it", () => {
    // Two words, each repeated two thousand times, share no word, so no unique word splits the
    // stretch and an exact alignment would walk millions of steps to keep only the spaces.
    const previousText = Array.from({ length: 2000 }, () => "alpha").join(" ");
    const nextText = Array.from({ length: 2000 }, () => "beta").join(" ");
    const pair = intralineSegments(previousText, nextText);
    expect(pair.deleted).toStrictEqual([{ text: previousText, changed: true }]);
    expect(pair.inserted).toStrictEqual([{ text: nextText, changed: true }]);
  });
});
