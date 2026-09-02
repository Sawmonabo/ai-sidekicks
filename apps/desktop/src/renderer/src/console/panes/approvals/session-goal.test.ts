// The goal's two operations, its bound, and the fold that answers what it is now.
//
// The fold is the interesting half. The goal is a projection of the log rather than
// a stored value, so "what is the goal" has exactly one right answer — whatever the
// event AUTHORED last says — and four ways to get it wrong: read the first event
// instead of the newest, take the newest local position instead of the newest
// reading, treat a clear as an update, or read a malformed payload as an empty
// goal. One case each below, plus the cross-node cases the local-position fold got
// wrong: a delayed update arriving after one authored earlier, a clear and an
// update competing in either direction, an exact-instant tie, and a stamp that does
// not parse.

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

/**
 * One timeline entry.
 *
 * `occurredAt` defaults to a single instant so the cases that are only about kind
 * and payload say nothing about time; the cross-node cases pass their own, which is
 * the whole point of those cases.
 */
function event(
  sequence: number,
  kind: string,
  payload?: Readonly<Record<string, unknown>>,
  occurredAt = "2026-01-01T00:00:00.000Z",
): ConsoleSessionEvent {
  return {
    // The event's own identifier, composed from the position so two rows of one
    // session never share one.
    id: `event-${String(sequence)}`,
    sessionId: "session-one",
    sequence,
    kind,
    occurredAt,
    ...(payload === undefined ? {} : { payload }),
  };
}

function goalUpdate(sequence: number, text: string, occurredAt?: string): ConsoleSessionEvent {
  return event(sequence, "session.goal_updated", { goal: { text } }, occurredAt);
}

function goalClear(sequence: number, occurredAt?: string): ConsoleSessionEvent {
  return event(sequence, "session.goal_cleared", undefined, occurredAt);
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
    const goal = foldSessionGoal([
      goalUpdate(1, "first goal", "2026-01-01T00:00:00.000Z"),
      goalClear(2, "2026-01-01T00:00:01.000Z"),
    ]);
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

// The register's winner is the newest READING, not the newest arrival. A relayed
// event takes its local sequence when it lands here, so a delayed one can sit at a
// higher position than the event it preceded. Every case below is one the fold that
// stopped at the newest local position answered wrong.
describe("the fold ranks readings rather than arrivals", () => {
  it("takes the later instant when it was delivered first", () => {
    // Negative control on the old fold: it returned the earlier instant's text,
    // because that event carries the higher local sequence.
    const goal = foldSessionGoal([
      goalUpdate(1, "authored later", "2026-01-01T00:00:09.000Z"),
      goalUpdate(2, "authored earlier", "2026-01-01T00:00:01.000Z"),
    ]);
    expect(goal).toStrictEqual({ status: "set", text: "authored later" });
  });

  it("lets a clear beat an earlier update and an update beat an earlier clear", () => {
    const clearWins = foldSessionGoal([
      goalClear(1, "2026-01-01T00:00:09.000Z"),
      goalUpdate(2, "authored earlier", "2026-01-01T00:00:01.000Z"),
    ]);
    expect(clearWins).toStrictEqual({ status: "none" });

    const updateWins = foldSessionGoal([
      goalUpdate(1, "authored later", "2026-01-01T00:00:09.000Z"),
      goalClear(2, "2026-01-01T00:00:01.000Z"),
    ]);
    expect(updateWins).toStrictEqual({ status: "set", text: "authored later" });
  });

  it("breaks an exact-instant tie on the higher local sequence", () => {
    // The only order the renderer has below the instant: the store's projected
    // event shape carries no envelope id to break it on.
    const goal = foldSessionGoal([
      goalUpdate(7, "arrived first", "2026-01-01T00:00:05.000Z"),
      goalUpdate(8, "arrived second", "2026-01-01T00:00:05.000Z"),
    ]);
    expect(goal).toStrictEqual({ status: "set", text: "arrived second" });
  });

  it("reports the winner's unreadable payload rather than the loser's readable one", () => {
    const goal = foldSessionGoal([
      goalUpdate(1, "readable but older", "2026-01-01T00:00:01.000Z"),
      event(2, "session.goal_updated", undefined, "2026-01-01T00:00:09.000Z"),
    ]);
    expect(goal).toStrictEqual({ status: "unreadable" });
  });

  it("never lets an unreadable stamp beat a readable one, in either arrival order", () => {
    const unreadableArrivesLast = foldSessionGoal([
      goalUpdate(1, "readable stamp", "2026-01-01T00:00:01.000Z"),
      goalUpdate(2, "unreadable stamp", "whenever"),
    ]);
    expect(unreadableArrivesLast).toStrictEqual({ status: "set", text: "readable stamp" });

    const unreadableArrivesFirst = foldSessionGoal([
      goalUpdate(1, "unreadable stamp", "whenever"),
      goalUpdate(2, "readable stamp", "2026-01-01T00:00:01.000Z"),
    ]);
    expect(unreadableArrivesFirst).toStrictEqual({ status: "set", text: "readable stamp" });
  });
});
