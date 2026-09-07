// How many times a settling test asks a refusing platform to kill its child.
//
// `electron-child-profile-removal.test.ts` beside this owns the ORDERING — that
// the profile comes off disk only once the child has closed, and that a refused
// kill is retried before it does. This owns the COUNT, which that file cannot
// state: its refusal case spends two refusals and then lets the real terminator
// through, so three asks is the right answer there under either shape.
//
// TWO LOOPS MULTIPLIED, AND THE BOUND SAID THREE. The settle-time disposal
// looped `DISPOSAL_ATTEMPTS` times around a call that itself looped
// `DISPOSAL_ATTEMPTS` times, so a tree that refused every ask was asked NINE
// times against a constant whose own comment says the third ask is already past
// what this process can do. On Windows each of those is a `taskkill` PROCESS
// spawned at a tree that has already refused, six of them added to a teardown
// that is being torn down. A bound declared in one place and spent in two is not
// a bound, so exactly one layer owns the count.
//
// The stand-ins are `electron-child-lifetime.test-support.ts`'s, for that
// module's reason: no platform can be asked to refuse a kill on demand. The
// child is real, because the loop reads `hasClosed` off a real handle, and it is
// reaped in `finally` — a case that proves a refusal by leaking is the defect
// with an assertion beside it.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { spawnManagedElectronChild } from "../../helpers/electron-child.js";
import { DISPOSAL_ATTEMPTS } from "../../helpers/managed-electron-child.js";
import {
  LIFETIME_TEST_TIMEOUT_MS,
  NON_TERMINATING_PROGRAM,
  ObservedTreeTerminator,
  RecordingSettleRegistrar,
} from "./electron-child-lifetime.test-support.js";
import { reap } from "./electron-child-liveness.test-support.js";

/**
 * What each refused attempt is given to produce a `close` that will not come.
 *
 * Short on purpose and injected rather than waited out: every attempt against a
 * permanently refusing platform spends this bound in full, so the production
 * grace would make this case cost three of them for a count that is settled in
 * milliseconds.
 */
const REFUSED_KILL_SETTLE_WAIT_MS = 50;

/**
 * More refusals than any bound under test could spend.
 *
 * `ObservedTreeTerminator` delegates to the real terminator once its refusals
 * run out, and a case measuring a CEILING must not have the platform quietly
 * relieve it partway through — so the budget is larger than the nine the
 * superseded nesting reached, and the child is reaped by the case instead.
 */
const REFUSALS_BEYOND_EVERY_BOUND = 99;

describe("settle-time disposal — one layer owns the attempt count", () => {
  it(
    "asks a permanently refusing platform exactly the declared number of times",
    async () => {
      // THE FINDING, and the reading that makes it a count rather than a shape:
      // every ask reaches the terminator, so `requests.length` IS the bound this
      // path spends. Nine here was the nested loops multiplying; anything below
      // `DISPOSAL_ATTEMPTS` would be a retry that stopped early, which is the
      // opposite defect and the one the refusal ordering case next door covers.
      //
      // ONE REGISTRAR, which is the shape rather than an economy. The spawn door
      // now arms the ONLY settle-time disposer a spawned child has, and the
      // release travels into it as `releaseAfterTermination` — so settling that
      // one registrar settles the whole teardown and `requests.length` is a
      // statement about every ask this child's settlement makes, not about one
      // loop among two.
      const registrar = new RecordingSettleRegistrar();
      const terminator = new ObservedTreeTerminator(REFUSALS_BEYOND_EVERY_BOUND);
      let removals = 0;
      const managed = spawnManagedElectronChild({
        command: process.execPath,
        args: ["-e", NON_TERMINATING_PROGRAM],
        cwd: process.cwd(),
        env: process.env,
        registerSettleTimeTermination: registrar.register,
        terminateProcessTree: terminator.terminate,
        releaseAfterTermination: () => {
          removals += 1;
        },
        terminationExitWaitMs: REFUSED_KILL_SETTLE_WAIT_MS,
      });
      const childProcessId = managed.child.pid ?? 0;

      try {
        await registrar.settle();

        expect(
          terminator.requests.length,
          "the disposal loops multiplied — the declared bound is being spent once per layer rather than once in total",
        ).toBe(DISPOSAL_ATTEMPTS);
        // Non-vacuity in two directions. Every ask was a SIGKILL at this child's
        // own tree, so the count is not being padded by an escalation ladder or
        // by a pid this case never spawned; and the release still ran once, so
        // the bound was reached by spending it rather than by returning early.
        expect(terminator.requests.map((request) => request.signal)).toStrictEqual(
          Array.from({ length: DISPOSAL_ATTEMPTS }, () => "SIGKILL"),
        );
        expect(new Set(terminator.requests.map((request) => request.processId))).toStrictEqual(
          new Set([childProcessId]),
        );
        expect(removals).toBe(1);
      } finally {
        reap(childProcessId);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "negative control: a platform that kills what it is asked to kill is asked once",
    async () => {
      // Without this the case above is ambiguous between "the loop spends its
      // bound on a refusal" and "the loop always spends its bound", and the
      // second would put three kills and two waits on every ordinary teardown
      // this package performs — the cost the early return exists to avoid.
      const registrar = new RecordingSettleRegistrar();
      const terminator = new ObservedTreeTerminator();
      const managed = spawnManagedElectronChild({
        command: process.execPath,
        args: ["-e", NON_TERMINATING_PROGRAM],
        cwd: process.cwd(),
        env: process.env,
        registerSettleTimeTermination: registrar.register,
        terminateProcessTree: terminator.terminate,
        releaseAfterTermination: () => undefined,
        terminationExitWaitMs: REFUSED_KILL_SETTLE_WAIT_MS,
      });
      const childProcessId = managed.child.pid ?? 0;

      try {
        await registrar.settle();

        expect(
          terminator.requests.length,
          "an ordinary teardown spent more than one ask — the retry is running on a kill that landed",
        ).toBe(1);
      } finally {
        reap(childProcessId);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );
});
