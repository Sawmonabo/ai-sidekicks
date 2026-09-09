// What a tool row declares about its own treatment, read fail-closed in both
// directions.
//
// The reader is the whole of this module's behaviour, and the two directions it
// fails closed in are two different facts about the wire: a row that declares
// NOTHING is every row this daemon sends, and a row that declares something this
// build does not know is a newer daemon. Collapsing the second into the first would
// be the console guessing, which is exactly what the sub-family slot exists to stop.
//
// EVERY CASE DRIVES THE REAL READER over a real payload record. Nothing here
// reimplements the membership test — a suite that spelled the six names again would
// pass while the module read a seventh.

import { describe, expect, it } from "vitest";

import {
  TOOL_SUB_FAMILIES,
  TOOL_SUB_FAMILY_ARGUMENTS_MEMBER,
  TOOL_SUB_FAMILY_MEMBER,
  TOOL_SUB_FAMILY_SERVER_MEMBER,
  TOOL_SUB_FAMILY_SLOT,
  declaredToolSubFamily,
} from "./tool-sub-families.js";

describe("a tool row's declared sub-family", () => {
  it("reads no sub-family off a payload that declares none", () => {
    // Every row this build can receive: the registered tool payload carries a name,
    // a call id and a duration, and no member saying what kind of tool ran.
    expect(
      declaredToolSubFamily({ toolName: "Bash", toolCallId: "call-1", durationMs: 12 }),
    ).toBeUndefined();
  });

  it("reads every member of the declared vocabulary", () => {
    for (const subFamily of TOOL_SUB_FAMILIES) {
      expect(declaredToolSubFamily({ [TOOL_SUB_FAMILY_MEMBER]: subFamily })).toStrictEqual({
        kind: "declared",
        subFamily,
        serverLabel: undefined,
        argumentSummary: [],
      });
    }
  });

  it("names a value this build does not know rather than dropping it", () => {
    expect(declaredToolSubFamily({ [TOOL_SUB_FAMILY_MEMBER]: "notebook-cell" })).toStrictEqual({
      kind: "unrecognized",
      declared: "notebook-cell",
    });
  });

  it("carries the MCP server label the row names", () => {
    expect(
      declaredToolSubFamily({
        [TOOL_SUB_FAMILY_MEMBER]: "mcp",
        [TOOL_SUB_FAMILY_SERVER_MEMBER]: "sentry",
      }),
    ).toStrictEqual({
      kind: "declared",
      subFamily: "mcp",
      serverLabel: "sentry",
      argumentSummary: [],
    });
  });

  it("carries the argument summary the daemon composed, in order", () => {
    const reading = declaredToolSubFamily({
      [TOOL_SUB_FAMILY_MEMBER]: "mcp",
      [TOOL_SUB_FAMILY_ARGUMENTS_MEMBER]: ["issueId: PROJ-4", "limit: 20"],
    });
    expect(reading).toStrictEqual({
      kind: "declared",
      subFamily: "mcp",
      serverLabel: undefined,
      argumentSummary: ["issueId: PROJ-4", "limit: 20"],
    });
  });

  it("drops a summary element that is not a string rather than stringifying it", () => {
    // `String({})` is `[object Object]`, and putting that on the page would be the
    // console printing something the daemon never sent.
    const reading = declaredToolSubFamily({
      [TOOL_SUB_FAMILY_MEMBER]: "mcp",
      [TOOL_SUB_FAMILY_ARGUMENTS_MEMBER]: ["issueId: PROJ-4", { limit: 20 }, 7, null],
    });
    expect(reading?.kind === "declared" ? reading.argumentSummary : undefined).toStrictEqual([
      "issueId: PROJ-4",
    ]);
  });

  it("treats a non-array summary as no summary at all", () => {
    const reading = declaredToolSubFamily({
      [TOOL_SUB_FAMILY_MEMBER]: "mcp",
      [TOOL_SUB_FAMILY_ARGUMENTS_MEMBER]: "issueId: PROJ-4",
    });
    expect(reading?.kind === "declared" ? reading.argumentSummary : undefined).toStrictEqual([]);
  });

  it("reads no sub-family off a declaration that is not a wire string", () => {
    // The negative control for the unrecognized arm: a number is not a member this
    // build does not know, it is not a declaration at all.
    expect(declaredToolSubFamily({ [TOOL_SUB_FAMILY_MEMBER]: 4 })).toBeUndefined();
    expect(declaredToolSubFamily({ [TOOL_SUB_FAMILY_MEMBER]: null })).toBeUndefined();
  });
});

describe("the tool sub-family slot's contract", () => {
  it("names the feature it is waiting on and carries no governance identifier", () => {
    for (const clause of Object.values(TOOL_SUB_FAMILY_SLOT)) {
      expect(clause.length).toBeGreaterThan(0);
      // Governance ids belong in comments, never in a string a build ships.
      expect(clause).not.toMatch(/\b(?:Plan|Spec|ADR|BL)-\d|\bT-023/);
    }
  });
});
