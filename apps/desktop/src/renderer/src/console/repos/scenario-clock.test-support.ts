// How a case moves the fixture's frozen clock, for every surface in this family that
// schedules a read.
//
// WHY A CASE HAS TO MOVE ANYTHING AT ALL. Every read this family performs is routed
// through the console's one `RefreshScheduler`, which arms its debounce on the clock it
// was handed; the readers take that clock from the bridge, and under the fixture the
// bridge's clock is the scenario's frozen one. So real time moves none of these
// surfaces, and a case that polled it — `waitFor` and its five-second budget — would be
// polling a still picture until the budget ran out.
//
// ONE HOME FOR BOTH HALVES, because the two are one act done wrong in two ways. An
// advance performed outside `act` lands its state updates untracked, and React reports
// that as a warning while the case reads whichever half of the transition it reached;
// an advance with no bound loops forever against a surface that is never going to
// answer. The loop's last pass therefore runs the caller's assertion outside the
// `try`, so a case that never settles fails with the assertion's own message rather
// than with a timeout that says nothing about what was missing.

import { act } from "@testing-library/react";

import type { ConsoleBridge } from "../bridge/index.js";
import { REFRESH_DEBOUNCE_MS } from "../core/index.js";

/**
 * How many debounce intervals a case may drive before giving up.
 *
 * A COUNT OF ADVANCES RATHER THAN A DURATION, because the budget being spent is
 * scenario time and not the runner's. Twenty-four intervals carries the repos scenario
 * past its last beat, which is the furthest anything in this family can be waiting on.
 */
const SCENARIO_SETTLE_PASSES = 24;

/** Move scenario time one debounce interval and flush whatever it released. */
export async function advanceScenarioOneInterval(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(REFRESH_DEBOUNCE_MS);
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve();
    }
  });
}

/**
 * Drive scenario time until `assert` holds, or fail with `assert`'s own message.
 *
 * Stops at the FIRST pass that holds, which is what keeps a surface's pinned state
 * minimal: every extra advance delivers another scenario beat and moves every deadline
 * the surface renders against, so a helper that spent its whole budget would pin a
 * different composition from the one the case is about.
 */
export async function advanceScenarioUntil(
  bridge: ConsoleBridge,
  assert: () => void,
): Promise<void> {
  for (let pass = 0; pass < SCENARIO_SETTLE_PASSES; pass += 1) {
    try {
      assert();
      return;
    } catch {
      await advanceScenarioOneInterval(bridge);
    }
  }
  assert();
}
