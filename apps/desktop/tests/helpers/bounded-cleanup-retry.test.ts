// What a refused kill costs, and how many times the cleanup asks.
//
// `bounded-cleanup.test.ts` holds the race: which settlement a close reaches and whether the
// profile came off disk. This holds the one outcome that is not a race: the platform reporting
// it could not kill the tree, which `terminateProcessTree` reports separately because a later
// launch can feel it.
//
// The retry belongs inside the one pass. The launcher's close is idempotent by a `closed` guard
// set before the cleanup runs, so a caller handed `unterminable` cannot ask again by closing
// again, and on a vitest timeout the settle-time registration is the only caller there is. So
// the ask is repeated here, bounded by the same figure the settle-time child disposal uses
// (`DISPOSAL_ATTEMPTS`, imported), in the same shape: attempt, wait for the tree's own evidence,
// return the moment it is gone.
//
// The waits are inside a budget rather than beside one. Three grace intervals added once
// `application.close()` had spent its whole registered ceiling would put the all-refused path
// past what `tierTimeoutFor` reserves for cleanup, so vitest's timeout would fire first and take
// the `unterminable` verdict with it.
//
// Which budget matters too. The waits belong to the termination phase's own deadline, which
// `#terminateUntilGone` restarts at its first attempt. Charged to the close's origin, which is
// already spent on the path this file covers, they would be zero-length: three attempts back to
// back inside a few milliseconds, a transient refusal reported `unterminable`, and the profile
// removed under a live Electron. The spacing case below separates the two with a refusal that
// clears on its own.
//
// The stand-ins are `bounded-cleanup.test-support.ts`'s: no platform can be asked to refuse a
// kill on demand, and a terminator that really signaled would reach a process group this suite
// does not own.

import { describe, expect, it } from "vitest";

import { DISPOSAL_ATTEMPTS } from "./managed-electron-child.js";
import { BoundedCleanup } from "./bounded-cleanup.js";
import {
  applicationThatNeverCloses,
  applicationWhoseCloseRejects,
  profileSpy,
  TEST_BUDGET_MS,
  TEST_OVERLONG_TERMINATION_WAIT_MS,
  TEST_SPACED_TERMINATION_WAIT_MS,
  TEST_TERMINATION_WAIT_MS,
  terminatorRefusingThenDelivering,
  terminatorRefusingUntil,
  terminatorSpy,
} from "./bounded-cleanup.test-support.js";

/**
 * How long the self-clearing refusal below lasts, in real milliseconds.
 *
 * Sized against the two shapes it separates: a loop that does not pause reaches its attempt
 * bound inside one millisecond, and one that does waits `TEST_SPACED_TERMINATION_WAIT_MS` before
 * its second ask. This sits between them, derived from that figure so the two cannot drift.
 */
const TRANSIENT_REFUSAL_MS = TEST_SPACED_TERMINATION_WAIT_MS / 3;

describe("bounded cleanup — a tree that refuses the kill", () => {
  it("asks again while the platform refuses, and settles once the kill lands", async () => {
    // The caller cannot make a second ask: the launcher's close sets its `closed` guard first,
    // so a settle-time disposer handed `unterminable` could not retry and the tree would outlive
    // the worker. The retry therefore lives inside the one pass, bounded by the same figure as
    // the child disposal in `managed-electron-child.ts`.
    const terminator = terminatorRefusingThenDelivering(DISPOSAL_ATTEMPTS - 1);
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminator,
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
    ).close();
    expect(
      outcome.settlement,
      "the cleanup gave up on the first refusal — a tree that takes the next kill is reported as one nothing could kill",
    ).toBe("terminated");
    // Separates a retry from one ask reported late: every attempt reached the terminator, and
    // the last is the ask that landed.
    expect(terminator.killed).toStrictEqual(Array.from({ length: DISPOSAL_ATTEMPTS }, () => 4242));
  });

  it("reports a tree that refuses every attempt, bounded rather than forever", async () => {
    // The other half, and why the loop is a bound rather than a condition: past this many asks
    // the tree is unkillable by this process and holding teardown open buys nothing. The verdict
    // is `unterminable`, not a quiet `terminated`, because a later launch can feel it.
    const terminator = terminatorSpy(false);
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminator,
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
    ).close();
    expect(outcome.settlement).toBe("unterminable");
    expect(
      terminator.killed.length,
      "the retry is not held to the shared attempt bound — a tree nothing can kill holds teardown open",
    ).toBe(DISPOSAL_ATTEMPTS);
  });

  it("spaces the retries out inside the termination phase when the close budget is spent", async () => {
    // Only a self-clearing refusal can state this. The close spends its whole ceiling here, so
    // the close's deadline is at zero when the loop starts, and charging the pause to that
    // origin makes `min(grace, 0)` the wait for every attempt: the three asks would run inside
    // one millisecond, before this terminator's refusal cleared, giving `unterminable`, a
    // removed profile and an Electron still running that would have died inside the grace.
    //
    // Charged to the termination phase's own origin, the first pause is the whole of that
    // phase's budget, which is longer than the refusal lasts, so the second ask lands after it
    // has cleared. The window opens at the first ask, which keeps this a statement about the
    // spacing of the retries.
    const terminator = terminatorRefusingUntil(TRANSIENT_REFUSAL_MS);
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminator,
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_SPACED_TERMINATION_WAIT_MS,
    ).close();

    expect(
      outcome.settlement,
      "every retry timer was zero-length, so three asks ran inside one instant and a refusal that clears was reported unterminable",
    ).toBe("terminated");
    // Makes it about the pause rather than luck: the second ask is the one that landed, so a
    // pause separated them.
    expect(terminator.killed).toStrictEqual([4242, 4242]);
    // Non-vacuity: the close spent its ceiling, so the loop began with the close's budget at zero.
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(TEST_BUDGET_MS);
  });

  it("bounds the whole cleanup by the two phases rather than by a grace per attempt", async () => {
    // The close spends its whole ceiling here (the application never settles) and the terminator
    // then refuses every ask, the path that would cost the ceiling plus three grace intervals.
    // `tierTimeoutFor` reserves only the ceiling and a two-second settlement residual, so on the
    // registered figures that overrun would put the cleanup past its tier timeout and vitest
    // would kill the test before the `unterminable` verdict could return.
    //
    // The pause is bounded by what the termination phase has left, so a grace longer than that
    // phase's budget is truncated to it: one pause rather than three, and the total is the two
    // phases, never a grace per attempt.
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminatorSpy(false),
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_OVERLONG_TERMINATION_WAIT_MS,
    ).close();
    expect(outcome.settlement).toBe("unterminable");
    // Non-vacuity: the close spent the ceiling, so what follows is about the retry and not a
    // cleanup that finished early.
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(TEST_BUDGET_MS);
    expect(
      outcome.waitedMs,
      "a grace interval was added beside the phase budgets — the cleanup outruns the tier timeout that reserves them",
    ).toBeLessThan(TEST_BUDGET_MS + TEST_OVERLONG_TERMINATION_WAIT_MS);
  });

  it("still pauses between asks while the budget has room, rather than never pausing", async () => {
    // The foil for the cases above, and why the pause is derived rather than deleted. This close
    // rejects at once, so almost the whole budget is unspent and every ask is entitled to its
    // full grace; dropping the pause would pass the truncation case and turn the retry into
    // three kills in one instant, giving the tree no time to answer.
    const outcome = await new BoundedCleanup(
      applicationWhoseCloseRejects(new Error("close refused")),
      terminatorSpy(false),
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
    ).close();
    expect(outcome.settlement).toBe("unterminable");
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(DISPOSAL_ATTEMPTS * TEST_TERMINATION_WAIT_MS);
  });

  it("negative control: a delivered kill is asked exactly once", async () => {
    // Without this the two cases above are ambiguous between "the loop retries a refusal" and
    // "the loop always spends its bound", and the second would put three kills and two waits on
    // every ordinary cleanup.
    const terminator = terminatorSpy(true);
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminator,
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
    ).close();
    expect(outcome.settlement).toBe("terminated");
    expect(terminator.killed).toStrictEqual([4242]);
  });
});
