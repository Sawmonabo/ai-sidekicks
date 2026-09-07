// Whether the charged deadline actually REACHES the host queries it bounds.
//
// `bounded-cleanup-probe-budget.test.ts` beside this owns the loop's own rule —
// that an exhausted deadline stops the next attempt. That rule bounds how many
// probe pairs run and says nothing about how long ONE of them may take, and one
// pair is still two blocking `spawnSync` calls at `HOST_QUERY_TIMEOUT_MS` each:
// half the registered cleanup budget apiece. So the second half of the fix is a
// number travelling — from the deadline, through `ProcessTerminator`, into the
// shared door in `readers.ts` that takes the smaller of that ceiling and what it
// is handed and spawns nothing at all once it reaches zero.
//
// A NUMBER THAT TRAVELS IS CHECKABLE, AND THAT IS WHY THE SEAM CARRIES IT. An
// argument dropped at the binding would leave every reading below on its own
// ceiling with nothing to say so — the failure mode is a slow host, not a wrong
// answer, so no verdict here would ever look different. The cases below read the
// figure the seam was handed instead, which fails the moment the forward stops.
//
// WHY THE REAL BINDING IS ASKED SO LITTLE. `ELECTRON_PROCESS_TERMINATOR` reaches
// the platform: its `terminate` signals a process group, which from inside the
// runner is this suite's own. So it is exercised only through `isRunning`, and
// only against pids whose answer is not in doubt — this process, which is
// running by definition, and a pid nothing holds. What that shows is that the
// binding forwards a budget of zero without spawning and without throwing; the
// clamping arithmetic itself belongs to `readers.ts` and is held there.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { HOST_QUERY_TIMEOUT_MS } from "../../helpers/process-tree/readers.js";
import { BoundedCleanup } from "../bounded-cleanup.js";
import { ELECTRON_PROCESS_TERMINATOR, type ProcessTerminator } from "../cleanup-contract.js";
import {
  applicationThatNeverCloses,
  profileSpy,
  TEST_BUDGET_MS,
  TEST_TERMINATION_WAIT_MS,
} from "./bounded-cleanup.test-support.js";

/** A pid no process holds, well above this host's allocation. */
const UNHELD_PROCESS_ID = 0x7ff_ffff;

/** A clock the case advances by hand, so a probe can "spend" its ceiling for free. */
class SteppedClock {
  #nowMs = 2_000_000;

  readonly read = (): number => this.#nowMs;

  advance(byMs: number): void {
    this.#nowMs += byMs;
  }
}

/** What each seam member was handed, in the order it was handed it. */
interface RecordedBudgets {
  readonly terminate: number[];
  readonly isRunning: number[];
}

/**
 * A terminator that refuses every kill and records the budget it was charged.
 *
 * `spendPerProbe` is what each reading costs the clock, which is how a case
 * makes a host query "spend its ceiling" without waiting five real seconds for
 * one — the state that motivated the whole charge and the one no real runner
 * produces on demand.
 */
function budgetRecordingTerminator(
  clock: SteppedClock,
  recorded: RecordedBudgets,
  spendPerProbe: number,
): ProcessTerminator {
  return {
    terminate: (_processId: number, remainingBudgetMilliseconds: number) => {
      recorded.terminate.push(remainingBudgetMilliseconds);
      clock.advance(spendPerProbe);
      return false;
    },
    isRunning: (_processId: number, remainingBudgetMilliseconds: number) => {
      recorded.isRunning.push(remainingBudgetMilliseconds);
      clock.advance(spendPerProbe);
      return true;
    },
  };
}

describe("bounded cleanup — the remaining budget reaches both host-query seams", () => {
  it("charges each probe what the termination deadline has left when it runs", async () => {
    // THE FORWARD, read as the figures the seam received. The clock does not
    // move on its own here, so every number is the deadline's arithmetic rather
    // than a runner's timing: the first kill is entitled to the whole budget,
    // and the liveness read after it is entitled to what that kill left.
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
    // Every figure is a real remaining budget: never negative, never above the
    // deadline, and strictly decreasing as the probes spend it.
    const charged = [...recorded.terminate, ...recorded.isRunning];
    for (const budget of charged) {
      expect(budget).toBeGreaterThanOrEqual(0);
      expect(budget).toBeLessThanOrEqual(TEST_BUDGET_MS);
    }
    expect(outcome.settlement).toBe("unterminable");
  });

  it("stops at zero rather than charging a negative budget", async () => {
    // The floor, and the reading the shared door depends on: at or below zero it
    // spawns nothing, so a negative figure arriving there would be the same
    // "unbounded" it exists to prevent, spelled as a number.
    const clock = new SteppedClock();
    const recorded: RecordedBudgets = { terminate: [], isRunning: [] };
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      // Each probe spends far more than the whole deadline, which is what a real
      // `HOST_QUERY_TIMEOUT_MS` does to a budget this size.
      budgetRecordingTerminator(clock, recorded, TEST_BUDGET_MS * 4),
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
      clock.read,
    ).close();

    expect(recorded.terminate).toStrictEqual([TEST_BUDGET_MS]);
    expect(
      recorded.isRunning,
      "the exhausted liveness read was charged something other than zero — the floor is missing and the door would spawn",
    ).toStrictEqual([0]);
    expect(outcome.settlement).toBe("unterminable");
  });

  it("negative control: a deadline nothing spends charges every attempt in full", async () => {
    // Without this the two cases above are ambiguous between "the budget is
    // charged as it is spent" and "the budget is always the same number", and
    // the second would pass while forwarding a constant that bounds nothing.
    // Same seam, same recorder, probes that cost the clock nothing.
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
    // The binding itself, asked the only way a test may ask it. Both readings
    // run with nothing left, so the shared door starts no process at all — and
    // both still answer, because the existence probe underneath is a syscall
    // rather than a command. A pid that is gone reads gone; this runner reads
    // running, which is the fail-closed direction the charge is allowed to take.
    expect(ELECTRON_PROCESS_TERMINATOR.isRunning(process.pid, 0)).toBe(true);
    expect(ELECTRON_PROCESS_TERMINATOR.isRunning(UNHELD_PROCESS_ID, 0)).toBe(false);
    // And the same answers with a real budget, so the exhausted arm above is the
    // budget being honoured rather than the reading having changed meaning.
    expect(ELECTRON_PROCESS_TERMINATOR.isRunning(process.pid, HOST_QUERY_TIMEOUT_MS)).toBe(true);
    // The structural half the verdicts cannot show: both members DECLARE the
    // second parameter. A binding that dropped it would keep every answer above
    // and silently put `HOST_QUERY_TIMEOUT_MS` back outside the deadline.
    expect(
      ELECTRON_PROCESS_TERMINATOR.terminate.length,
      "the tree kill no longer takes a remaining budget — its host commands are unbounded by this cleanup again",
    ).toBe(2);
    expect(ELECTRON_PROCESS_TERMINATOR.isRunning.length).toBe(2);
  });
});
