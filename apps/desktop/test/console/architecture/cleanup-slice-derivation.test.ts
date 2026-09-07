// What a whole cleanup costs, and whether the tier reserved that much.
//
// `bounded-cleanup-probe-budget.test.ts` beside this owns what stops the retry
// loop, and `cleanup-terminator-budget.test.ts` owns what each probe inside it
// is charged. Neither asks the question this file does, which is the one the
// tier's arithmetic depends on: how much wall time can ONE `BoundedCleanup`
// consume end to end, and does `tierTimeoutFor()` wait that long?
//
// THE FINDING. It did not. A cleanup is two phases — `application.close()` raced
// against `CLEANUP_BUDGET_MS`, and then, when that close had to be abandoned, a
// termination loop that restarts the SAME figure at its own first attempt
// because the close left nothing to draw on. The tier's slice reserved that
// figure once and left the 2 000 ms settlement residual after it, so the second
// phase ran outside what vitest waits for: the test was killed before the
// `unterminable` verdict existed and before the temporary profile came off disk,
// which is the one cleanup outcome a LATER launch feels.
//
// TWO HALVES, AND THE MEASUREMENT IS THE LOAD-BEARING ONE. `CLEANUP_PHASES` is a
// count a reader could get wrong, so the cases below do not trust it: the first
// drives a real `BoundedCleanup` through both phases against an injected clock
// and reads the spend off its own verdict, and the second holds the reserved
// slice against that measured spend. A loop that stopped restarting its deadline
// and a slice that stopped covering both phases each fail here.
//
// The clock is injected because the case cannot be produced any other way — a
// close that really hangs for its whole registered ten seconds, followed by
// three probe pairs each spending a five-second host-query ceiling, is most of a
// minute of waiting inside a tier that exists to de-flake.

import { describe, expect, it } from "vitest";

import { BoundedCleanup } from "../bounded-cleanup.js";
import {
  BODY_ALLOWANCE_MS,
  CLEANUP_BUDGET_MS,
  FRAME_WITNESS_TIMEOUT_MS,
  READINESS_BUDGET_MS,
} from "../launch-budgets.js";
import {
  CLEANUP_PHASES,
  CLEANUP_SLICE_MS,
  LAUNCH_BUDGET_MS,
  MINIMUM_SETTLEMENT_RESIDUAL_MS,
  POST_READINESS_RESERVE_MS,
  tierTimeoutFor,
} from "../launch-deadline.js";
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
    // THE MEASUREMENT the tier arithmetic below rests on. The close is scripted
    // to consume the whole bound on this clock and then hang, which is the state
    // the SIGKILL exists for; the terminator then refuses every kill and charges
    // half the bound per probe, so the loop's own deadline — restarted at its
    // first attempt — is what stops it. `waitedMs` is measured from the close's
    // own start instant, so it is the WHOLE cleanup's spend and not the loop's.
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
    // The verdict and the removal are what the overrun used to cost, so both are
    // asserted here rather than left to the suites that own them separately.
    expect(profile.removalAttempts).toStrictEqual([TEST_PROFILE_DIRECTORY]);
  });

  it("negative control: a close that settles inside its bound spends only one phase", async () => {
    // Without this the case above is ambiguous between "termination restarts the
    // budget" and "every cleanup costs two budgets", and the second would size
    // the tier for a phase that ordinary launches never enter. Same clock, same
    // bound, a close that simply works.
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
    // THE ASSERTION THE OLD DERIVATION FAILS. `CLEANUP_SLICE_MS` was
    // `CLEANUP_BUDGET_MS` — one phase — so this reads 10 000 against a required
    // 20 000 on the registered figures and goes red without touching a tier.
    expect(CLEANUP_SLICE_MS).toBeGreaterThanOrEqual(CLEANUP_BUDGET_MS * CLEANUP_PHASES);
  });

  it("holds back the whole slice from every readiness wait", () => {
    // The reserve a readiness phase draws against, which is what stops the
    // ladder eating a phase that runs after it. Reserving one cleanup budget
    // here let the ladder spend the termination phase's time before that phase
    // existed.
    expect(POST_READINESS_RESERVE_MS).toBeGreaterThanOrEqual(
      FRAME_WITNESS_TIMEOUT_MS + CLEANUP_BUDGET_MS * CLEANUP_PHASES,
    );
  });

  it("leaves a launching tier both cleanup phases and the settlement residual", () => {
    // The claim in the tier's own currency, and the one the finding was written
    // against: after the ladder, the witness, and the body have each spent their
    // whole allowance, what a tier still waits for must cover a hung close, the
    // termination that follows it, and the synchronous profile removal after
    // that. On the old derivation this subtraction leaves 12 000 ms against a
    // required 22 000.
    const afterEveryOtherPhase =
      tierTimeoutFor(BODY_ALLOWANCE_MS) -
      (READINESS_BUDGET_MS + FRAME_WITNESS_TIMEOUT_MS + BODY_ALLOWANCE_MS);
    expect(afterEveryOtherPhase).toBeGreaterThanOrEqual(
      CLEANUP_BUDGET_MS * CLEANUP_PHASES + MINIMUM_SETTLEMENT_RESIDUAL_MS,
    );
  });

  it("negative control: the slice is derived from the registry row, not written down", () => {
    // Without this the three cases above pass over a `CLEANUP_SLICE_MS` someone
    // typed as a literal large enough to satisfy them — which is the shape the
    // whole launch-budget module exists to refuse, and which would stop tracking
    // the row the moment `budgets.json` moved.
    expect(CLEANUP_SLICE_MS % CLEANUP_BUDGET_MS).toBe(0);
    expect(CLEANUP_SLICE_MS / CLEANUP_BUDGET_MS).toBe(CLEANUP_PHASES);
    expect(LAUNCH_BUDGET_MS).toBe(
      READINESS_BUDGET_MS + FRAME_WITNESS_TIMEOUT_MS + CLEANUP_SLICE_MS,
    );
  });
});
