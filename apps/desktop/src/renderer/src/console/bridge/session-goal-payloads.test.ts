// What the goal readings admit, asserted where the validator lives.
//
// These cases moved here with the schemas. Left in the approvals suite they would
// have been a view family's test of a bridge-family rule, and the rule they cover is
// the daemon's own: a goal is one to four thousand and ninety-six code units,
// non-blank, and NUL-free, and the text the console sends is the text the participant
// typed rather than one this module trimmed into shape.

import { describe, expect, it } from "vitest";

import {
  SESSION_GOAL_MAX_LENGTH,
  SESSION_GOAL_MIN_LENGTH,
  isSendableGoalText,
  readGoalOriginKeys,
  readGoalPayloadText,
} from "./session-goal-payloads.js";

describe("what a sendable goal is", () => {
  it("accepts ordinary text and text at the ceiling", () => {
    expect(isSendableGoalText("Ship the approvals pane")).toBe(true);
    expect(isSendableGoalText("g".repeat(SESSION_GOAL_MAX_LENGTH))).toBe(true);
  });

  it("refuses empty, blank, over-long, and NUL-bearing text", () => {
    expect(SESSION_GOAL_MIN_LENGTH).toBe(1);
    expect(isSendableGoalText("")).toBe(false);
    expect(isSendableGoalText("   ")).toBe(false);
    expect(isSendableGoalText("g".repeat(SESSION_GOAL_MAX_LENGTH + 1))).toBe(false);
    // Written as an escape so no file in this tree carries the code point.
    expect(isSendableGoalText("ship\u0000it")).toBe(false);
  });

  it("admits text a trim would have rewritten", () => {
    // A `trim().min(1)` would accept this and let a caller send text nobody wrote.
    // The reading answers about the value as typed, surrounding space included, and
    // the caller sends that same value.
    expect(isSendableGoalText("  ship it  ")).toBe(true);
  });
});

describe("what a goal payload carries", () => {
  it("reads the goal text a set payload carries", () => {
    expect(readGoalPayloadText({ goal: { text: "ship it" } })).toBe("ship it");
  });

  it("answers undefined for a payload with no readable goal", () => {
    expect(readGoalPayloadText({ goal: {} })).toBeUndefined();
    expect(readGoalPayloadText({ goal: { text: 7 } })).toBeUndefined();
    expect(readGoalPayloadText(undefined)).toBeUndefined();
  });

  it("reads the origin keys the accepting daemon stamped", () => {
    expect(readGoalOriginKeys({ originNodeId: "node-a", originSeq: 4 })).toStrictEqual({
      originNodeId: "node-a",
      originSeq: 4,
    });
  });

  it("answers undefined for keys no fold could rank by", () => {
    // The negative controls a hand-shaped read would have passed: a string sequence,
    // a fractional one, and an empty node id all read as an order.
    expect(readGoalOriginKeys({ originNodeId: "node-a", originSeq: "4" })).toBeUndefined();
    expect(readGoalOriginKeys({ originNodeId: "node-a", originSeq: 4.5 })).toBeUndefined();
    expect(readGoalOriginKeys({ originNodeId: "", originSeq: 4 })).toBeUndefined();
    expect(readGoalOriginKeys({})).toBeUndefined();
  });
});
