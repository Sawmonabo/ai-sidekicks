// The goal's two operations, and what the fold answers from the log.
//
// Two operations rather than one, because setting a goal and clearing it are
// different acts with different authority — and the fold answers what the log says
// rather than what arrived last, which is why these cases rank readings and not
// arrivals.

import { describe, expect, it } from "vitest";
import { SESSION_GOAL_EVENT_KINDS, foldSessionGoal } from "./session-goal.js";
import { TIED_INSTANT, event, goalClear, goalUpdate } from "./session-goal.test-support.js";

describe("two operations, never one", () => {
  it("names a distinct method for setting and for clearing", () => {
    expect("session.goalUpdate").toBe("session.goalUpdate");
    expect("session.goalClear").toBe("session.goalClear");
    expect("session.goalUpdate").not.toBe("session.goalClear");
  });

  it("watches exactly the two projection sources", () => {
    expect([...SESSION_GOAL_EVENT_KINDS]).toStrictEqual([
      "session.goal_updated",
      "session.goal_cleared",
    ]);
  });
});

describe("the fold answers what the log says", () => {
  it("takes the latest update and not the first", () => {
    const goal = foldSessionGoal([
      goalUpdate(1, "first goal"),
      event(2, "run.queued"),
      goalUpdate(3, "second goal"),
    ]);
    expect(goal).toStrictEqual({
      status: "set",
      text: "second goal",
      revision: expect.any(String),
    });
  });

  it("treats a later clear as a clear rather than as an absent update", () => {
    const goal = foldSessionGoal([
      goalUpdate(1, "first goal", "2026-01-01T00:00:00.000Z"),
      goalClear(2, "2026-01-01T00:00:01.000Z"),
    ]);
    expect(goal).toStrictEqual({ status: "none", revision: expect.any(String) });
  });

  it("reports an unreadable goal event rather than reading it as no goal", () => {
    // "The goal was cleared" and "this build cannot read the latest goal event" are
    // different facts, and the second one must never render as the first.
    const goal = foldSessionGoal([goalUpdate(1, "first goal"), event(2, "session.goal_updated")]);
    expect(goal).toStrictEqual({ status: "unreadable", revision: expect.any(String) });
  });

  it("answers none for a log that carries no goal event at all", () => {
    expect(foldSessionGoal([event(1, "run.queued")])).toStrictEqual({
      status: "none",
      revision: expect.any(String),
    });
    expect(foldSessionGoal([])).toStrictEqual({ status: "none", revision: expect.any(String) });
  });

  it("negative control: a non-goal event after an update does not change the answer", () => {
    // Without this, a fold that stopped at the last entry of any kind would pass
    // every case above and still be wrong on the ordinary session.
    const goal = foldSessionGoal([goalUpdate(1, "the goal"), event(2, "assistant.message")]);
    expect(goal).toStrictEqual({ status: "set", text: "the goal", revision: expect.any(String) });
  });
});

describe("the fold ranks readings rather than arrivals", () => {
  it("takes the later instant when it was delivered first", () => {
    // Negative control on the old fold: it returned the earlier instant's text,
    // because that event carries the higher local sequence.
    const goal = foldSessionGoal([
      goalUpdate(1, "authored later", "2026-01-01T00:00:09.000Z"),
      goalUpdate(2, "authored earlier", "2026-01-01T00:00:01.000Z"),
    ]);
    expect(goal).toStrictEqual({
      status: "set",
      text: "authored later",
      revision: expect.any(String),
    });
  });

  it("lets a clear beat an earlier update and an update beat an earlier clear", () => {
    const clearWins = foldSessionGoal([
      goalClear(1, "2026-01-01T00:00:09.000Z"),
      goalUpdate(2, "authored earlier", "2026-01-01T00:00:01.000Z"),
    ]);
    expect(clearWins).toStrictEqual({ status: "none", revision: expect.any(String) });

    const updateWins = foldSessionGoal([
      goalUpdate(1, "authored later", "2026-01-01T00:00:09.000Z"),
      goalClear(2, "2026-01-01T00:00:01.000Z"),
    ]);
    expect(updateWins).toStrictEqual({
      status: "set",
      text: "authored later",
      revision: expect.any(String),
    });
  });

  it("breaks an exact-instant tie on the envelope id, in either arrival order", () => {
    // The envelope's own identifier is the order below the instant, and it is the
    // same on every node — so the two arrival orders answer alike. Local sequence
    // would have answered "arrived second" once and "arrived first" once.
    const earlierId = event(
      7,
      "session.goal_updated",
      { goal: { text: "lower id" } },
      TIED_INSTANT,
    );
    const laterId = event(8, "session.goal_updated", { goal: { text: "higher id" } }, TIED_INSTANT);
    expect(foldSessionGoal([earlierId, laterId])).toStrictEqual({
      status: "set",
      text: "higher id",
      revision: expect.any(String),
    });
    expect(foldSessionGoal([laterId, earlierId])).toStrictEqual({
      status: "set",
      text: "higher id",
      revision: expect.any(String),
    });
  });

  it("reports the winner's unreadable payload rather than the loser's readable one", () => {
    const goal = foldSessionGoal([
      goalUpdate(1, "readable but older", "2026-01-01T00:00:01.000Z"),
      event(2, "session.goal_updated", undefined, "2026-01-01T00:00:09.000Z"),
    ]);
    expect(goal).toStrictEqual({ status: "unreadable", revision: expect.any(String) });
  });

  it("never lets an unreadable stamp beat a readable one, in either arrival order", () => {
    const unreadableArrivesLast = foldSessionGoal([
      goalUpdate(1, "readable stamp", "2026-01-01T00:00:01.000Z"),
      goalUpdate(2, "unreadable stamp", "whenever"),
    ]);
    expect(unreadableArrivesLast).toStrictEqual({
      status: "set",
      text: "readable stamp",
      revision: expect.any(String),
    });

    const unreadableArrivesFirst = foldSessionGoal([
      goalUpdate(1, "unreadable stamp", "whenever"),
      goalUpdate(2, "readable stamp", "2026-01-01T00:00:01.000Z"),
    ]);
    expect(unreadableArrivesFirst).toStrictEqual({
      status: "set",
      text: "readable stamp",
      revision: expect.any(String),
    });
  });
});

// The two-stage fold. Within one origin daemon its own append order decides, and
// only between different origins' winners does the envelope comparator apply. Every
// case here is one the single-stage `(occurredAt, local sequence)` ranking answered
// wrong, and the last one is the property the whole ranking exists to have.
