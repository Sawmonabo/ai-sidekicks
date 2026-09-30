// Whether the charged deadline reaches the host queries it bounds.
//
// One probe pair is two blocking `spawnSync` calls at `HOST_QUERY_TIMEOUT_MS` each, so the budget
// must travel from the deadline through `ProcessTerminator` into `runBoundedHostCommand` in
// `process-tree/readers.ts`, which takes the smaller of its ceiling and the figure it is handed
// and spawns nothing at zero. A dropped argument would only make a slow host slower with no wrong
// answer to notice, so the cases read the figure the seam was handed.
//
// The real `ELECTRON_PROCESS_TERMINATOR` is asked only through `isRunning`: its `terminate` would
// signal a process group that is this suite's own. The clamping arithmetic is held in `readers.ts`.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { HOST_QUERY_TIMEOUT_MS } from "./process-tree/readers.js";
import { BoundedCleanup } from "./bounded-cleanup.js";
import { ELECTRON_PROCESS_TERMINATOR } from "./cleanup-contract.js";
import {
  applicationThatNeverCloses,
  budgetRecordingTerminator,
  profileSpy,
  SteppedClock,
  TEST_BUDGET_MS,
  TEST_TERMINATION_WAIT_MS,
  type RecordedBudgets,
} from "./bounded-cleanup.test-support.js";

/** A pid no process holds, well above this host's allocation. */
const UNHELD_PROCESS_ID = 0x7ff_ffff;

describe("bounded cleanup — the remaining budget reaches both host-query seams", () => {
  it("charges each probe what the termination deadline has left when it runs", async () => {
    // Reads the figures the seam received. The clock does not move on its own, so every number is
    // the deadline's arithmetic: the first kill gets the whole budget and the liveness read gets
    // what that kill left.
    const clock = new SteppedClock();
    const recorded: RecordedBudgets = { terminate: [], isRunning: [] };
    const spendPerProbe = Math.floor(TEST_BUDGET_MS / 4);
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      budgetRecordingTerminator(clock, recorded, spendPerProbe),
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
      clock.read,
    ).close();

    expect(
      recorded.terminate[0],
      "the tree kill was charged nothing — its host commands are back on their own ceiling, outside this cleanup's deadline",
    ).toBe(TEST_BUDGET_MS);
    expect(
      recorded.isRunning[0],
      "the liveness read reused the kill's budget instead of re-reading — a probe that has already spent the deadline is charged as though it had not",
    ).toBe(TEST_BUDGET_MS - spendPerProbe);
    // Every figure is a real remaining budget: never negative, never above the deadline.
    const charged = [...recorded.terminate, ...recorded.isRunning];
    for (const budget of charged) {
      expect(budget).toBeGreaterThanOrEqual(0);
      expect(budget).toBeLessThanOrEqual(TEST_BUDGET_MS);
    }
    expect(outcome.settlement).toBe("unterminable");
  });

  it("stops at zero rather than charging a negative budget", async () => {
    // The floor: at or below zero `runBoundedHostCommand` spawns nothing, so a negative figure
    // would be unbounded spelled as a number.
    const clock = new SteppedClock();
    const recorded: RecordedBudgets = { terminate: [], isRunning: [] };
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      // Each probe spends more than the whole deadline, as a real host-query timeout would.
      budgetRecordingTerminator(clock, recorded, TEST_BUDGET_MS * 4),
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
      clock.read,
    ).close();

    expect(recorded.terminate).toStrictEqual([TEST_BUDGET_MS]);
    expect(
      recorded.isRunning,
      "the exhausted liveness read was charged something other than zero — the floor is missing and the host command would spawn",
    ).toStrictEqual([0]);
    expect(outcome.settlement).toBe("unterminable");
  });

  it("negative control: a deadline nothing spends charges every attempt in full", async () => {
    // Tells "charged as spent" from "always the same number"; probes cost the clock nothing.
    const clock = new SteppedClock();
    const recorded: RecordedBudgets = { terminate: [], isRunning: [] };
    await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      budgetRecordingTerminator(clock, recorded, 0),
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
      clock.read,
    ).close();

    expect(
      recorded.terminate.length,
      "the loop stopped early with the whole deadline unspent — the guard is refusing attempts the policy allows",
    ).toBeGreaterThan(1);
    expect(new Set([...recorded.terminate, ...recorded.isRunning])).toStrictEqual(
      new Set([TEST_BUDGET_MS]),
    );
  });

  it("forwards an exhausted budget through the real binding without spawning", async () => {
    // Both readings run with nothing left, so no process starts, and both still answer because the
    // existence probe is a syscall. A gone pid reads gone; this runner reads running, the
    // fail-closed direction.
    expect(ELECTRON_PROCESS_TERMINATOR.isRunning(process.pid, 0)).toBe(true);
    expect(ELECTRON_PROCESS_TERMINATOR.isRunning(UNHELD_PROCESS_ID, 0)).toBe(false);
    // Same answer with a real budget, so the exhausted case is the budget being honored.
    expect(ELECTRON_PROCESS_TERMINATOR.isRunning(process.pid, HOST_QUERY_TIMEOUT_MS)).toBe(true);
    // Both members must declare the second parameter; a binding that dropped it keeps every answer
    // above and puts the host-query ceiling back outside the deadline.
    expect(
      ELECTRON_PROCESS_TERMINATOR.terminate.length,
      "the tree kill no longer takes a remaining budget — its host commands are unbounded by this cleanup again",
    ).toBe(2);
    expect(ELECTRON_PROCESS_TERMINATOR.isRunning.length).toBe(2);
  });
});
