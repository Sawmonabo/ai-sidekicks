// A deadline closed once its waits were over bounds a wait handed it afterwards, never leaving that
// wait unbounded.

import { describe, expect, it } from "vitest";

import { makeManualScheduler } from "../../../../__fixtures__/manual-scheduler.js";
import { CodexTurnEndDeadline } from "../turn-end-waiters.js";

const DEADLINE_MS = 5_000;

describe("a turn-end deadline", () => {
  // Mutation: keeping the canceled timer on close arms no new one for a later wait, which then
  // waits for good.
  it("bounds a wait handed it after it was closed", () => {
    const scheduler = makeManualScheduler();
    const deadline = new CodexTurnEndDeadline(scheduler.schedule, DEADLINE_MS);
    deadline.bind(() => undefined);
    deadline.close();

    let hasPassed = false;
    deadline.bind(() => {
      hasPassed = true;
    });
    scheduler.fireDelay(DEADLINE_MS);

    expect(hasPassed).toBe(true);
  });
});
