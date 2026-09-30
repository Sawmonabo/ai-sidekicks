// The literal-safety predicate and the walk back to a safe ceiling, each against what a parser
// would have done with the withheld tail.

import { describe, expect, it } from "vitest";

import { isLiteralSafeAt, safeRevealCeiling } from "./reveal-gate.js";

describe("the reveal gate — the literal-safety predicate", () => {
  it("holds a volatile character that could open a construct", () => {
    // `**bol` is not bold yet; publishing the asterisks means either a half-open
    // construct or markers that vanish a frame later.
    expect(isLiteralSafeAt("a **", 2)).toBe(false);
    expect(isLiteralSafeAt("see [", 4)).toBe(false);
    expect(isLiteralSafeAt("run `", 4)).toBe(false);
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
