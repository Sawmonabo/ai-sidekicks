// What the synchronous half of a refused termination costs, and who pays for it.
//
// `bounded-cleanup-retry.test.ts` owns the attempt count and the pause between attempts. This
// owns the cost neither measures: every attempt makes two blocking host queries (`terminate`
// reads the root's start stamp before it signals, `isRunning` reads the whole process table),
// each bounded only by `HOST_QUERY_TIMEOUT_MS`, five seconds.
//
// On the path this loop exists for, `application.close()` spends its ceiling and then Windows
// refuses `taskkill`. Charging the probes nothing would let the retry add roughly thirty seconds
// that `tierTimeoutFor` does not reserve (it reserves the ceiling and a settlement residual).
// Vitest's generic timeout would then fire first and take the `unterminable` verdict and the
// profile removal with it, the one settlement a later launch can feel.
//
// The clock is injected because a real probe that spends its ceiling costs five real seconds, and
// three of them would put fifteen seconds of waiting into a tier that exists to de-flake. The
// SIGKILL stays on a real `setTimeout`, so the loop still yields a macrotask between attempts
// rather than asking the same instant twice.
//
// The other stand-ins are `bounded-cleanup.test-support.ts`'s: no platform can be asked to
// refuse a kill on demand.

import { describe, expect, it } from "vitest";

import { HOST_QUERY_TIMEOUT_MS } from "./process-tree/readers.js";
import { BoundedCleanup } from "./bounded-cleanup.js";
import { type ProcessTerminator } from "./cleanup-contract.js";
import {
  applicationThatNeverCloses,
  profileSpy,
  SteppedClock,
  TEST_BUDGET_MS,
  TEST_PROFILE_DIRECTORY,
  TEST_TERMINATION_WAIT_MS,
} from "./bounded-cleanup.test-support.js";

/**
 * A terminator that refuses every kill and charges each probe its full ceiling.
 *
 * No real platform produces this on demand: the queries answer, slowly, and the tree survives.
 * Both readings advance the clock because both are `spawnSync` calls held to the same bound.
 */
function terminatorSpendingItsProbeCeiling(
  clock: SteppedClock,
): ProcessTerminator & { readonly killed: number[] } {
  const killed: number[] = [];
  return {
    killed,
    terminate: (processId: number) => {
      killed.push(processId);
      clock.advance(HOST_QUERY_TIMEOUT_MS);
      return false;
    },
    isRunning: () => {
      clock.advance(HOST_QUERY_TIMEOUT_MS);
      return true;
    },
  };
}

describe("bounded cleanup — the synchronous probes are charged to the deadline", () => {
  it("stops attempting once the probes have spent the budget, and still removes the profile", async () => {
    // The first attempt's two queries alone spend twice the bound this cleanup was given, so
    // every later attempt is refused where it stands rather than adding another pair. The
    // verdict is still the one a reader came for, and the removal still runs: giving up an ask
    // never gives up the directory.
    const clock = new SteppedClock();
    const terminator = terminatorSpendingItsProbeCeiling(clock);
    const profile = profileSpy();
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminator,
      profile,
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
      clock.read,
    ).close();

    expect(
      terminator.killed.length,
      "the retry spent another attempt against an exhausted deadline — three probe pairs is roughly thirty seconds nothing reserves",
    ).toBe(1);
    expect(outcome.settlement).toBe("unterminable");
    expect(
      profile.removalAttempts,
      "the profile was left on disk — stopping an attempt early gave up the removal with it",
    ).toStrictEqual([TEST_PROFILE_DIRECTORY]);
  });

  it("negative control: probes that cost nothing still spend the whole attempt bound", async () => {
    // Without this the case above is ambiguous between "an exhausted deadline stops the loop"
    // and "the loop stopped asking", and the second would retire the retry on every refusal,
    // the defect `bounded-cleanup-retry.test.ts` keeps closed. Same terminator, same budget, a
    // clock that does not move.
    const frozenClock = new SteppedClock();
    const terminator: ProcessTerminator & { readonly killed: number[] } = {
      killed: [],
      terminate: (processId: number) => {
        (terminator.killed as number[]).push(processId);
        return false;
      },
      isRunning: () => true,
    };
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminator,
      profileSpy(),
      TEST_BUDGET_MS,
      TEST_TERMINATION_WAIT_MS,
      frozenClock.read,
    ).close();

    expect(outcome.settlement).toBe("unterminable");
    expect(
      terminator.killed.length,
      "the loop stopped early with budget to spare — the deadline guard is refusing attempts the policy still allows",
    ).toBeGreaterThan(1);
  });
});
