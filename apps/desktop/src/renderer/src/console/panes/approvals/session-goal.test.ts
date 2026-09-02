// The goal's two operations, its bound, and the fold that answers what it is now.
//
// The fold is the interesting half. The goal is a projection of the log rather than
// a stored value, so "what is the goal" has exactly one right answer — whatever the
// latest goal event says — and three ways to get it wrong: read the first event
// instead of the last, treat a clear as an update, or read a malformed payload as
// an empty goal. One case each below.

import { describe, expect, it } from "vitest";

import { SESSION_GOAL_MAX_LENGTH, SESSION_GOAL_MIN_LENGTH } from "./approvals-bounds.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import {
  SESSION_GOAL_CLEAR_METHOD,
  SESSION_GOAL_EVENT_KINDS,
  SESSION_GOAL_UPDATE_METHOD,
  foldSessionGoal,
  sessionGoalTextSchema,
} from "./session-goal.js";

function event(
  sequence: number,
  kind: string,
  payload?: Readonly<Record<string, unknown>>,
): ConsoleSessionEvent {
  return {
    sessionId: "session-one",
    sequence,
    kind,
    occurredAt: "2026-01-01T00:00:00.000Z",
    ...(payload === undefined ? {} : { payload }),
  };
}

function goalUpdate(sequence: number, text: string): ConsoleSessionEvent {
  return event(sequence, "session.goal_updated", { goal: { text } });
}

describe("two operations, never one", () => {
  it("names a distinct method for setting and for clearing", () => {
    expect(SESSION_GOAL_UPDATE_METHOD).toBe("session.goalUpdate");
    expect(SESSION_GOAL_CLEAR_METHOD).toBe("session.goalClear");
    // The whole reason the schema's floor is one character rather than zero: an
    // update with no goal is malformed, and clearing has its own verb.
    expect(SESSION_GOAL_MIN_LENGTH).toBe(1);
    expect(SESSION_GOAL_UPDATE_METHOD).not.toBe(SESSION_GOAL_CLEAR_METHOD);
  });

  it("watches exactly the two projection sources", () => {
    expect([...SESSION_GOAL_EVENT_KINDS]).toStrictEqual([
      "session.goal_updated",
      "session.goal_cleared",
    ]);
  });
});

describe("what a sendable goal is", () => {
  it("accepts ordinary text and text at the ceiling", () => {
    expect(sessionGoalTextSchema.safeParse("Ship the approvals pane").success).toBe(true);
    expect(sessionGoalTextSchema.safeParse("g".repeat(SESSION_GOAL_MAX_LENGTH)).success).toBe(true);
  });

  it("refuses empty, blank, over-long, and NUL-bearing text", () => {
    expect(sessionGoalTextSchema.safeParse("").success).toBe(false);
    expect(sessionGoalTextSchema.safeParse("   ").success).toBe(false);
    expect(sessionGoalTextSchema.safeParse("g".repeat(SESSION_GOAL_MAX_LENGTH + 1)).success).toBe(
      false,
    );
    // Written as an escape so no file in this tree carries the code point.
    expect(sessionGoalTextSchema.safeParse("ship\u0000it").success).toBe(false);
  });

  it("does not rewrite what the participant typed", () => {
    // A `trim().min(1)` would accept this and send text nobody wrote. The value
    // that parses has to be the value that was typed, surrounding space included.
    const parsed = sessionGoalTextSchema.safeParse("  ship it  ");
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : undefined).toBe("  ship it  ");
  });
});

describe("the fold answers what the log says", () => {
  it("takes the latest update and not the first", () => {
    const goal = foldSessionGoal([
      goalUpdate(1, "first goal"),
      event(2, "run.queued"),
      goalUpdate(3, "second goal"),
    ]);
    expect(goal).toStrictEqual({ status: "set", text: "second goal" });
  });

  it("treats a later clear as a clear rather than as an absent update", () => {
    const goal = foldSessionGoal([goalUpdate(1, "first goal"), event(2, "session.goal_cleared")]);
    expect(goal).toStrictEqual({ status: "none" });
  });

  it("reports an unreadable goal event rather than reading it as no goal", () => {
    // "The goal was cleared" and "this build cannot read the latest goal event" are
    // different facts, and the second one must never render as the first.
    const goal = foldSessionGoal([goalUpdate(1, "first goal"), event(2, "session.goal_updated")]);
    expect(goal).toStrictEqual({ status: "unreadable" });
  });

  it("answers none for a log that carries no goal event at all", () => {
    expect(foldSessionGoal([event(1, "run.queued")])).toStrictEqual({ status: "none" });
    expect(foldSessionGoal([])).toStrictEqual({ status: "none" });
  });

  it("negative control: a non-goal event after an update does not change the answer", () => {
    // Without this, a fold that stopped at the last entry of any kind would pass
    // every case above and still be wrong on the ordinary session.
    const goal = foldSessionGoal([goalUpdate(1, "the goal"), event(2, "assistant.message")]);
    expect(goal).toStrictEqual({ status: "set", text: "the goal" });
  });
});
