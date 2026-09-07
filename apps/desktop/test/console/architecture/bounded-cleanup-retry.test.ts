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
// AND THE WAITS ARE INSIDE THE CLOSE BUDGET RATHER THAN AFTER IT, which is the
// second claim here and the one a reader would not guess from the first. Three
// grace intervals added once `application.close()` had spent its whole registered
// ceiling put the all-refused path past what `tierTimeoutFor` reserves for
// cleanup — so vitest's own timeout fired first and took the `unterminable`
// verdict with it, which is the one settlement a later launch can feel.
//
// The stand-ins are `bounded-cleanup.test-support.ts`'s, for that module's reason:
// no platform can be asked to refuse a kill on demand, and these cases run inside
// the runner, where a terminator that really signalled would reach a process group
// this suite does not own.

import { describe, expect, it } from "vitest";

import { DISPOSAL_ATTEMPTS } from "../../helpers/managed-electron-child.js";
import { BoundedCleanup } from "../bounded-cleanup.js";
import {
  applicationThatNeverCloses,
  applicationWhoseCloseRejects,
  profileSpy,
  TEST_BUDGET_MS,
  TEST_OVERLONG_TERMINATION_WAIT_MS,
  TEST_TERMINATION_WAIT_MS,
  terminatorRefusingThenDelivering,
  terminatorSpy,
} from "./bounded-cleanup.test-support.js";

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

  it("charges the retry's waits to the close budget instead of adding them after it", async () => {
    // THE SECOND FINDING. The close spends its whole ceiling here — the
    // application never settles — and the terminator then refuses every ask, so
    // this is the exact path that used to cost the ceiling PLUS three grace
    // intervals. `tierTimeoutFor` reserves only the ceiling and a two-second
    // settlement residual, so on the registered figures that overrun put the
    // cleanup past its enclosing tier timeout and vitest killed the test before
    // the `unterminable` verdict below could be returned at all.
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
      "a grace interval was added after the close ceiling — the cleanup outruns the tier timeout that reserves it",
    ).toBeLessThan(TEST_BUDGET_MS + TEST_OVERLONG_TERMINATION_WAIT_MS);
  });

  it("still pauses between asks while the budget has room, rather than never pausing", async () => {
    // The foil for the case above, and the reason the pause is DERIVED rather
    // than deleted. This close rejects at once, so almost the whole budget is
    // unspent and every ask is entitled to its full grace — a fix that answered
    // the overrun by dropping the pause would pass the case above and turn the
    // retry into three kills issued in one instant, which asks the platform the
    // same question three times and gives the tree no time to answer.
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
