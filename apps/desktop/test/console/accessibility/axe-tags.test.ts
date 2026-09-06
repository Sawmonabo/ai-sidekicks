// The rule set the tier claims to run, held to what axe actually selects.
//
// The tier's surfaces assert on VIOLATIONS, so a tag set that selects too little is
// invisible there: every surface reports clean and the tier stays green over exactly
// the criteria it was narrowed away from. What the set names is therefore its own
// claim and is checked here rather than trusted.

import { describe, expect, it } from "vitest";
import axe from "axe-core";

import { AXE_TAGS } from "./axe-run.js";

/** The versions the tier conforms to, and the two levels each one is claimed at. */
const CLAIMED_WCAG_VERSIONS: readonly string[] = ["2", "21", "22"];

describe("the tier's axe tag set", () => {
  it("names both levels of every WCAG version it claims", () => {
    // Derived rather than retyped: the set is what selects rules, so a second hand
    // written copy of it here would go green on exactly the omission it is for. The
    // set carried five tags and claimed 2.2 at both levels while naming only its AA.
    expect([...AXE_TAGS].sort()).toStrictEqual(
      CLAIMED_WCAG_VERSIONS.flatMap((version) => [`wcag${version}a`, `wcag${version}aa`]).sort(),
    );
  });

  it("records what the 2.2 tags select at this axe pin", () => {
    // The measurement the tag set's own comment rests on, checked rather than stated:
    // `wcag22a` selects nothing today because axe automates neither of 2.2's Level A
    // additions, and the day it ships one this case goes red and the comment above
    // gets re-read instead of quietly becoming false.
    expect(axe.getRules(["wcag22a"])).toStrictEqual([]);
    expect(axe.getRules(["wcag22aa"]).map((rule) => rule.ruleId)).toStrictEqual(["target-size"]);
  });

  it("negative control: the set is what selects the rules, not a default", () => {
    // Without this the two cases above would pass over a tier whose tags reached axe
    // nowhere — every rule would run, or none would, and the list would be decoration.
    expect(axe.getRules([...AXE_TAGS]).length).toBeGreaterThan(
      axe.getRules(AXE_TAGS.filter((tag) => tag !== "wcag22aa")).length,
    );
  });
});
