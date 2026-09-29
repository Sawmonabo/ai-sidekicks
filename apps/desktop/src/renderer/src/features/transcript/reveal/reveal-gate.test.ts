// The literal-safety predicate: the class, the predecessor rule, and the two
// carve-outs.
//
// Every case names the sentence the gate is protecting, because the predicate is
// only meaningful against what a parser would have done with the tail it withheld.

import { describe, expect, it } from "vitest";

import { REVEAL_COMMIT_MODES, isLiteralSafeAt, safeRevealCeiling } from "./reveal-gate.js";

describe("the reveal gate — commit modes", () => {
  it("declares them closed, at two", () => {
    expect([...REVEAL_COMMIT_MODES]).toStrictEqual(["direct", "authoritative"]);
  });
});

describe("the reveal gate — the literal-safety predicate", () => {
  it("holds a volatile character that could open a construct", () => {
    // `**bol` is not bold yet; publishing the asterisks means either a half-open
    // construct or markers that vanish a frame later.
    expect(isLiteralSafeAt("a **", 2)).toBe(false);
    expect(isLiteralSafeAt("see [", 4)).toBe(false);
    expect(isLiteralSafeAt("run `", 4)).toBe(false);
  });

  it("passes a volatile character whose predecessor is a word character", () => {
    // `2*3` cannot open emphasis, so withholding it would stall the lane on prose.
    expect(isLiteralSafeAt("2*", 1)).toBe(true);
    expect(isLiteralSafeAt("file_", 4)).toBe(true);
  });

  it("passes ordinary characters unconditionally", () => {
    expect(isLiteralSafeAt("hello", 4)).toBe(true);
    expect(isLiteralSafeAt("hello", 99)).toBe(true);
  });

  it("carves out the in-word apostrophe and holds the other one", () => {
    expect(isLiteralSafeAt("don't", 3)).toBe(true);
    // A trailing apostrophe has nothing after it yet, so what it is is undecided.
    expect(isLiteralSafeAt("don'", 3)).toBe(false);
  });

  it("carves out the digit-period, and holds the one that opens a list", () => {
    expect(isLiteralSafeAt("costs 1.", 7)).toBe(true);
    expect(isLiteralSafeAt("1.", 1)).toBe(false);
    expect(isLiteralSafeAt("text\n  2.", 8)).toBe(false);
  });
});

describe("the reveal gate — the ceiling", () => {
  it("walks back to the last safe position", () => {
    // The window carries lookahead past the ceiling, which is what makes the tail
    // withholdable at all: `the plan **` is an emphasis run that has not opened yet.
    expect(safeRevealCeiling("the plan **more", 11)).toBe(9);
  });

  it("publishes a settled block whole, markers and all", () => {
    // At the end of the source there is nothing left to withhold: the parser sees
    // the whole construct, closed or not.
    expect(safeRevealCeiling("the plan **", 11)).toBe(11);
  });

  it("negative control: a ceiling that needs no walk is returned untouched", () => {
    expect(safeRevealCeiling("the plan is ready", 8)).toBe(8);
  });

  it("gives up rather than becoming a scan", () => {
    // A rule of asterisks would otherwise make the walk proportional to the block.
    const rule = `text ${"*".repeat(40)} more`;
    expect(safeRevealCeiling(rule, 40)).toBe(40);
  });

  it("clamps a ceiling outside the text", () => {
    expect(safeRevealCeiling("abc", -4)).toBe(0);
    expect(safeRevealCeiling("abc", 40)).toBe(3);
  });
});
