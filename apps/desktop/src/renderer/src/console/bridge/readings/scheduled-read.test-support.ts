// Advancing the one frozen clock a console reading schedules against.
//
// Every read this console performs goes through a `RefreshScheduler`, and every
// scheduler is armed on the clock `consoleClockFor` resolves — the fixture's frozen
// one wherever a scenario is playing. So a suite that mounts a reading and asserts
// what it asked the daemon has to MOVE that clock, and moving it is three things at
// once: reaching the right clock, advancing it far enough that the absolute deadline
// fires rather than only the debounce, and letting the call's own promise chain
// settle inside `act` so React has committed what the answer changed.
//
// Written once because every suite that mounts a scheduled reading needs it. Each
// hand-rolled copy had its own idea of how far to advance and how many microtasks to
// drain, which is how one of them came to advance by the debounce and pass only
// because its case asked exactly once.
//
// TWO SETTLES, BECAUSE A REPLY CAN BE PARKED IN TWO PLACES. A suite whose growth or
// daemon door is overridden with a resolved value waits only for the scheduler, and
// moving the clock is the whole of that. A suite driving a SCENARIO waits for the
// scheduler and then for the reply the scenario is holding, and only an engine advance
// releases the second — so the pair below is one role split by what is being waited
// for, never two ideas about how long to wait.
//
// IN `readings/` RATHER THAN AT `bridge/` TOP, where it was first written. The top of
// this family is the bridge ITSELF — the contract, the shape claim, the live
// implementation, the provider — and a harness is none of those. What it is about is
// the READING: how far one has got and when it has finished getting there, which is
// this directory's subject and no one wire's. That it is reached by `queue/`,
// `quotas/` and `driver-capabilities/` alike is the same evidence that put the
// lifecycle here — a mechanism every feed borrows belongs with the ones that fold
// none, never inside one of its borrowers.

import { act } from "@testing-library/react";

import { ManualClock, REFRESH_MAX_WAIT_MS } from "../../core/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "../../core/settle.test-support.js";
import type { ConsoleBridge } from "../console-bridge.js";

/**
 * The frozen clock this bridge's readings schedule against.
 *
 * Throws rather than falling back to a real clock: a suite whose bridge carried no
 * frozen clock would advance nothing, wait out no window, and report the absence of a
 * read it never gave the scheduler a chance to perform.
 */
export function frozenClockOf(bridge: ConsoleBridge): ManualClock {
  const { clock } = bridge.scenarioEngine ?? {};
  if (!(clock instanceof ManualClock)) {
    throw new Error("this bridge carries no frozen clock, so no scheduled read can be settled");
  }
  return clock;
}

/**
 * Let the scheduler's window elapse and the read that follows it settle.
 *
 * The ABSOLUTE deadline rather than the debounce, so a case that asked more than once
 * still reaches a performed read: a continuous stream of reasons keeps pushing the
 * debounce out, and the deadline measured from the first request is what stops that
 * from postponing the read forever.
 */
export async function settleScheduledRead(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    frozenClockOf(bridge).advance(REFRESH_MAX_WAIT_MS);
    await crossMacrotaskBoundary();
  });
}

/**
 * How many scenario intervals a read costs whose reply the scenario HOLDS.
 *
 * Two, and the second is not belt-and-braces. A scripted reply carrying `afterMs` is
 * parked on the engine and released by an ADVANCE OF THE ENGINE, so the first interval
 * spends the scheduler's window and issues the read — and the reply parks at that
 * moment, for its own latency, which only a further interval releases.
 */
const SCRIPTED_READ_INTERVALS = 2;

/**
 * Let a read settle whose reply the running scenario is holding.
 *
 * THROUGH THE ENGINE RATHER THAN THE CLOCK, which is the whole difference from
 * {@link settleScheduledRead}. `ScenarioEngine.advance` moves the clock it owns AND
 * releases every reply parked on it; the clock's own `advance` does the first half
 * only, so a suite that moved the clock fired the scheduler's window, issued the read,
 * and then waited out its budget against a reply nothing was ever going to release.
 * A suite whose replies are overridden with resolved values needs neither half of that
 * and takes the sibling.
 *
 * Throws where no scenario is running, for {@link frozenClockOf}'s reason: a bridge
 * with no engine releases nothing, and the case should fail at the line that asked
 * rather than at the assertion that read a loading state three settles later.
 */
export async function settleScriptedRead(bridge: ConsoleBridge): Promise<void> {
  const { scenarioEngine } = bridge;
  if (scenarioEngine === undefined) {
    throw new Error("this bridge is running no scenario, so no scripted reply can be released");
  }
  for (let interval = 0; interval < SCRIPTED_READ_INTERVALS; interval += 1) {
    await act(async () => {
      scenarioEngine.advance(PAST_REFRESH_DEBOUNCE_MS);
      await crossMacrotaskBoundary();
    });
    await settle();
  }
}
