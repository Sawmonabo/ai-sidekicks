// The rule set the tier claims to run, held to what axe actually selects. The cases assert on
// violations, so a tag set that selects too little would leave every view clean; the set is
// checked here rather than trusted.

import { describe, expect, it } from "vitest";
import axe from "axe-core";

import { AXE_TAGS } from "./axe-run.js";

/** The versions the tier conforms to, and the two levels each one is claimed at. */
const CLAIMED_WCAG_VERSIONS: readonly string[] = ["2", "21", "22"];

describe("the tier's axe tag set", () => {
  it("names both levels of every WCAG version it claims", () => {
    // Derived rather than retyped: a hand-written copy of the set would go green on exactly
    // the omission this case guards.
    expect([...AXE_TAGS].sort()).toStrictEqual(
      CLAIMED_WCAG_VERSIONS.flatMap((version) => [`wcag${version}a`, `wcag${version}aa`]).sort(),
    );
  });

  it("records what the 2.2 tags select at this axe pin", () => {
    // Checks the measurement the tag set's docstring rests on: `wcag22a` selects nothing today
    // because axe automates neither of 2.2's Level A additions, and the day it ships one this
    // case goes red and the docstring is re-read.
    expect(axe.getRules(["wcag22a"])).toStrictEqual([]);
    expect(axe.getRules(["wcag22aa"]).map((rule) => rule.ruleId)).toStrictEqual(["target-size"]);
  });

  it("negative control: the set is what selects the rules, not a default", () => {
    // Without this the two cases above would pass over a tier whose tags reached axe nowhere.
    expect(axe.getRules([...AXE_TAGS]).length).toBeGreaterThan(
      axe.getRules(AXE_TAGS.filter((tag) => tag !== "wcag22aa")).length,
    );
  });
});
