// What a REFUSED kill costs, and how many times the cleanup asks.
//
// `bounded-cleanup.test.ts` beside this holds the RACE — which settlement a close
// reaches and whether the profile came off disk. This holds the one outcome that
// is not a race at all: the platform reporting that it could not kill the tree,
// which `terminateProcessTree` exists to report separately precisely because it
// is the cleanup outcome a LATER launch can feel.
//
// THE RETRY BELONGS INSIDE THE ONE PASS, and that is the finding rather than a
// preference. The launcher's close is idempotent by a `closed` guard set BEFORE
// the cleanup runs, so a caller handed `unterminable` cannot ask again by closing
// again — and on a vitest timeout the settle-time registration is the only caller
// there is. So the ask is repeated here, bounded by the SAME figure the
// settle-time child disposal uses (`DISPOSAL_ATTEMPTS`, imported rather than
// restated), in the same shape: attempt, wait for the tree's own evidence, return
// the moment it is gone.
//
// AND THE WAITS ARE INSIDE A BUDGET RATHER THAN BESIDE ONE, which is the second
// claim here and the one a reader would not guess from the first. Three grace
// intervals added once `application.close()` had spent its whole registered
// ceiling put the all-refused path past what `tierTimeoutFor` reserves for
// cleanup — so vitest's own timeout fired first and took the `unterminable`
// verdict with it, which is the one settlement a later launch can feel.
//
// WHICH BUDGET IS THE THIRD CLAIM, AND CHARGING IT TO THE WRONG ONE DELETED THE
// PAUSE. The waits were charged to the CLOSE's origin, and on the path this file
// is about that origin is already spent — so every retry timer was zero-length
// and the three attempts ran back to back inside a few milliseconds. A platform
// whose refusal is transient was therefore asked three times before it could
// answer differently, reported `unterminable`, and had its profile removed under
// a live Electron. The waits belong to the TERMINATION phase's own deadline,
// which `#terminateUntilGone` restarts at its first attempt, and the case below
// separates the two by making a refusal that clears on its own.
//
// The stand-ins are `bounded-cleanup.test-support.ts`'s, for that module's reason:
// no platform can be asked to refuse a kill on demand, and these cases run inside
// the runner, where a terminator that really signalled would reach a process group
// this suite does not own.

import { describe, expect, it } from "vitest";

import { DISPOSAL_ATTEMPTS } from "./managed-electron-child.js";
import { BoundedCleanup } from "../console/bounded-cleanup.js";
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
 * Sized against the two shapes it has to separate rather than against a runner:
 * a loop that does not pause reaches its attempt bound inside one millisecond,
 * and a loop that does waits `TEST_SPACED_TERMINATION_WAIT_MS` before its second
 * ask. This sits between them with room on both sides, and it is derived from
 * that figure so the two cannot drift into each other.
 */
const TRANSIENT_REFUSAL_MS = TEST_SPACED_TERMINATION_WAIT_MS / 3;

describe("bounded cleanup — a tree that refuses the kill", () => {
  it("asks again while the platform refuses, and settles once the kill lands", async () => {
    // THE FINDING. One ask was all this ever made, and the caller could not make
    // a second: the launcher's close sets its `closed` guard before this cleanup
    // runs, so a settle-time disposer handed `unterminable` had no way to retry
    // and the tree it could not kill outlived the worker. The retry therefore
    // belongs inside the one pass — bounded, and by the same figure the child
    // disposal next door uses rather than a second `3` written here.
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
    // The reading that separates a retry from one ask reported late: every
    // attempt reached the terminator, and the last one is the ask that landed.
    expect(terminator.killed).toStrictEqual(Array.from({ length: DISPOSAL_ATTEMPTS }, () => 4242));
  });

  it("reports a tree that refuses every attempt, bounded rather than forever", async () => {
    // The other half, and the reason the loop is a bound rather than a condition:
    // past this many asks the tree is unkillable by this process, and holding
    // teardown open for the same answer buys nothing. The verdict is the one a
    // later launch can feel, so it is `unterminable` and not a quiet `terminated`.
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
    // THE THIRD FINDING, and the one only a self-clearing refusal can state. The
    // close spends its whole ceiling here, so the CLOSE's deadline is at zero by
    // the time the loop starts — and charging the pause to that origin made
    // `min(grace, 0)` the wait for every attempt. The three asks then ran inside
    // one millisecond, so this terminator's refusal had not yet cleared when the
    // bound was reached: `unterminable`, the profile removed, and an Electron
    // still running that would have died inside the grace it was never given.
    //
    // Charged to the termination phase's own origin the first pause is the whole
    // of that phase's budget, which is longer than the refusal lasts, so the
    // second ask lands after it has cleared. The window opens at the first ask,
    // which is what keeps this a statement about the SPACING of the retries.
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
    // The reading that makes it about the pause rather than about luck: the
    // second ask is the one that landed, so a pause really did separate them.
    expect(terminator.killed).toStrictEqual([4242, 4242]);
    // Non-vacuity: the close really did spend its ceiling, so the loop began
    // with the close's own budget at zero — the state the charge was wrong for.
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(TEST_BUDGET_MS);
  });

  it("bounds the whole cleanup by the two phases rather than by a grace per attempt", async () => {
    // THE SECOND FINDING. The close spends its whole ceiling here — the
    // application never settles — and the terminator then refuses every ask, so
    // this is the exact path that used to cost the ceiling PLUS three grace
    // intervals. `tierTimeoutFor` reserves only the ceiling and a two-second
    // settlement residual, so on the registered figures that overrun put the
    // cleanup past its enclosing tier timeout and vitest killed the test before
    // the `unterminable` verdict below could be returned at all.
    //
    // The pause is bounded by what the TERMINATION phase has left, so a grace
    // longer than that phase's whole budget is truncated to it — one pause here
    // rather than three, and the total is the two phases and never the sum of a
    // grace per attempt.
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminatorSpy(false),
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_OVERLONG_TERMINATION_WAIT_MS,
    ).close();
    expect(outcome.settlement).toBe("unterminable");
    // Non-vacuity: the close really did spend the ceiling, so what follows is a
    // statement about the retry rather than about a cleanup that finished early.
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(TEST_BUDGET_MS);
    expect(
      outcome.waitedMs,
      "a grace interval was added beside the phase budgets — the cleanup outruns the tier timeout that reserves them",
    ).toBeLessThan(TEST_BUDGET_MS + TEST_OVERLONG_TERMINATION_WAIT_MS);
  });

  it("still pauses between asks while the budget has room, rather than never pausing", async () => {
    // The foil for the cases above, and the reason the pause is DERIVED rather
    // than deleted. This close rejects at once, so almost the whole budget is
    // unspent and every ask is entitled to its full grace — a fix that answered
    // the overrun by dropping the pause would pass the truncation case and turn
    // the retry into three kills issued in one instant, which asks the platform
    // the same question three times and gives the tree no time to answer.
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
    // Without this the two cases above are ambiguous between "the loop retries a
    // refusal" and "the loop always spends its bound", and the second would put
    // three kills and two waits on every ordinary cleanup this harness performs.
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
