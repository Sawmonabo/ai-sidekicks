// Whether the tier reserves as much wall time as one `BoundedCleanup` can consume end to end.
//
// A cleanup is two phases: `application.close()` raced against `CLEANUP_BUDGET_MS`, then, when the
// close is abandoned, a termination loop that restarts the same figure at its own first attempt.
// The tier's slice must cover both, or vitest kills the test before the `unterminable` verdict
// exists and before the profile comes off disk. `CLEANUP_PHASES` is only a count, so the first
// case measures a real `BoundedCleanup` against an injected clock and the second holds the
// reserved slice against that spend. The loop's stop rule is `bounded-cleanup-probe-budget.test.ts`
// and each probe's charge is `cleanup-terminator-budget.test.ts`.
//
// The clock is injected because a close that really hangs for the registered ceiling, followed by
// three probe pairs at the host-query ceiling, is most of a minute of waiting.

import { describe, expect, it } from "vitest";

import { BoundedCleanup } from "./bounded-cleanup.js";
import {
  BODY_ALLOWANCE_MS,
  CLEANUP_BUDGET_MS,
  FRAME_PAINT_PROBE_TIMEOUT_MS,
  READINESS_BUDGET_MS,
} from "./launch-budgets.js";
import {
  CLEANUP_PHASES,
  CLEANUP_SLICE_MS,
  LAUNCH_BUDGET_MS,
  MINIMUM_SETTLEMENT_RESIDUAL_MS,
  POST_READINESS_RESERVE_MS,
  tierTimeoutFor,
} from "./launch-deadline.js";
import {
  applicationSpendingItsCloseBudget,
  budgetRecordingTerminator,
  profileSpy,
  SteppedClock,
  TEST_BUDGET_MS,
  TEST_PROFILE_DIRECTORY,
  TEST_TERMINATION_WAIT_MS,
  type RecordedBudgets,
} from "./bounded-cleanup.test-support.js";

/** The pid the scripted application reports; nothing here signals it. */
const TEST_PROCESS_ID = 4242;

describe("bounded cleanup — what a close that had to be terminated actually costs", () => {
  it("spends a second full budget on termination after the close spent the first", async () => {
    // The close spends the whole bound on this clock and hangs; the terminator refuses every kill
    // and charges half the bound per probe, so the loop's own deadline, restarted at its first
    // attempt, stops it. `waitedMs` runs from the close's start, so it is the whole cleanup's
    // spend.
    const clock = new SteppedClock();
    const recorded: RecordedBudgets = { terminate: [], isRunning: [] };
    const profile = profileSpy();
    const outcome = await new BoundedCleanup(
      applicationSpendingItsCloseBudget(clock, TEST_BUDGET_MS, TEST_PROCESS_ID),
      budgetRecordingTerminator(clock, recorded, TEST_BUDGET_MS / 2),
      profile,
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
      clock.read,
    ).close();

    expect(outcome.settlement).toBe("unterminable");
    expect(
      recorded.terminate[0],
      "the first kill was charged what the CLOSE had left — the termination phase is not restarting its deadline, and a hung close would leave nothing to kill with",
    ).toBe(TEST_BUDGET_MS);
    expect(
      outcome.waitedMs,
      "a whole cleanup no longer costs the close bound once per phase — the reserved slice below is derived from this figure",
    ).toBe(TEST_BUDGET_MS * CLEANUP_PHASES);
    // The profile removal must still happen after the overrun.
    expect(profile.removalAttempts).toStrictEqual([TEST_PROFILE_DIRECTORY]);
  });

  it("negative control: a close that settles inside its bound spends only one phase", async () => {
    // Tells "termination restarts the budget" from "every cleanup costs two budgets"; same clock
    // and bound, but the close works.
    const clock = new SteppedClock();
    const recorded: RecordedBudgets = { terminate: [], isRunning: [] };
    const outcome = await new BoundedCleanup(
      {
        close: () => {
          clock.advance(TEST_BUDGET_MS / 2);
          return Promise.resolve();
        },
        processId: () => TEST_PROCESS_ID,
      },
      budgetRecordingTerminator(clock, recorded, TEST_BUDGET_MS / 2),
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
      clock.read,
    ).close();

    expect(outcome.settlement).toBe("closed");
    expect(recorded.terminate, "a settled close reached the termination phase").toStrictEqual([]);
    expect(outcome.waitedMs).toBeLessThan(TEST_BUDGET_MS);
  });
});

describe("launch budget — the reserved cleanup slice covers every phase a cleanup has", () => {
  it("reserves the close bound once per phase rather than once in total", () => {
    // Fails if the slice reserves only one phase.
    expect(CLEANUP_SLICE_MS).toBeGreaterThanOrEqual(CLEANUP_BUDGET_MS * CLEANUP_PHASES);
  });

  it("holds back the whole slice from every readiness wait", () => {
    // The reserve a readiness wait draws against must hold back both cleanup phases, or the ladder
    // spends the termination phase's time.
    expect(POST_READINESS_RESERVE_MS).toBeGreaterThanOrEqual(
      FRAME_PAINT_PROBE_TIMEOUT_MS + CLEANUP_BUDGET_MS * CLEANUP_PHASES,
    );
  });

  it("leaves a launching tier both cleanup phases and the settlement residual", () => {
    // Once the ladder, the witness and the body have spent their whole allowance, the tier must
    // still wait for a hung close, the termination after it and the synchronous profile removal.
    const afterEveryOtherPhase =
      tierTimeoutFor(BODY_ALLOWANCE_MS) -
      (READINESS_BUDGET_MS + FRAME_PAINT_PROBE_TIMEOUT_MS + BODY_ALLOWANCE_MS);
    expect(afterEveryOtherPhase).toBeGreaterThanOrEqual(
      CLEANUP_BUDGET_MS * CLEANUP_PHASES + MINIMUM_SETTLEMENT_RESIDUAL_MS,
    );
  });

  it("negative control: the slice is derived from the registry row, not written down", () => {
    // Fails if `CLEANUP_SLICE_MS` is a literal that satisfies the cases above instead of tracking
    // the registry row.
    expect(CLEANUP_SLICE_MS % CLEANUP_BUDGET_MS).toBe(0);
    expect(CLEANUP_SLICE_MS / CLEANUP_BUDGET_MS).toBe(CLEANUP_PHASES);
    expect(LAUNCH_BUDGET_MS).toBe(
      READINESS_BUDGET_MS + FRAME_PAINT_PROBE_TIMEOUT_MS + CLEANUP_SLICE_MS,
    );
  });
});
