import { describe, expect, it } from "vitest";
import { foldSessionGoal } from "./session-goal.js";
import { event, goalClear, goalUpdate } from "./session-goal.test-support.js";

// The projection's REVISION: which log entry it was read from. The fold runs over
// the whole timeline, so it answers with a fresh object on every beat of any kind —
// and a consumer that keys on the object rather than on this member acts on a goal
// change once per event the session ever carries.

describe("the projection names the entry it was read from", () => {
  it("holds the revision across events that are not goal events", () => {
    const beforeTheBeats = foldSessionGoal([goalUpdate(1, "ship it")]);
    const afterTheBeats = foldSessionGoal([
      goalUpdate(1, "ship it"),
      event(2, "usage.token_count"),
      event(3, "run.turn_started"),
    ]);
    expect(afterTheBeats).toStrictEqual(beforeTheBeats);
  });

  it("moves the revision when a further goal update wins", () => {
    const first = foldSessionGoal([goalUpdate(1, "ship it")]);
    const second = foldSessionGoal([goalUpdate(1, "ship it"), goalUpdate(2, "ship it twice")]);
    expect(second.revision).not.toBe(first.revision);
  });

  it("moves the revision when the goal is re-set to the text it already had", () => {
    // A user setting the same words again is still an act, and a consumer
    // told nothing changed would go on showing whatever it had open. This is the
    // case a text comparison gets wrong and an identity does not.
    const first = foldSessionGoal([goalUpdate(1, "ship it")]);
    const again = foldSessionGoal([goalUpdate(1, "ship it"), goalUpdate(2, "ship it")]);
    expect(again).toStrictEqual({ status: "set", text: "ship it", revision: expect.any(String) });
    expect(again.revision).not.toBe(first.revision);
  });

  it("moves the revision when a clear wins", () => {
    const set = foldSessionGoal([goalUpdate(1, "ship it", "2026-01-01T00:00:00.000Z")]);
    const cleared = foldSessionGoal([
      goalUpdate(1, "ship it", "2026-01-01T00:00:00.000Z"),
      goalClear(2, "2026-01-01T00:00:01.000Z"),
    ]);
    expect(cleared.status).toBe("none");
    expect(cleared.revision).not.toBe(set.revision);
  });

  it("names a session with no goal event at all, distinctly from every event's", () => {
    const never = foldSessionGoal([event(1, "run.queued")]);
    const cleared = foldSessionGoal([goalClear(1)]);
    expect(never.status).toBe("none");
    expect(cleared.status).toBe("none");
    // Both read "no goal", and they are not the same reading: one session has never
    // had one and the other has had one taken away.
    expect(never.revision).not.toBe(cleared.revision);
  });

  it("negative control: an unrelated beat does move the projection OBJECT", () => {
    // The defect this member exists for. Without it there is nothing stable to key
    // on, and this is the assertion that fails the moment the fold starts returning
    // the same object for a timeline that grew.
    const first = foldSessionGoal([goalUpdate(1, "ship it")]);
    const second = foldSessionGoal([goalUpdate(1, "ship it"), event(2, "usage.token_count")]);
    expect(second).not.toBe(first);
    expect(second.revision).toBe(first.revision);
  });
});
