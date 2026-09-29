// How a case moves the fixture's frozen clock, for every surface that schedules a read.
//
// WHY A CASE HAS TO MOVE ANYTHING AT ALL. Every read a console surface performs is
// routed through the console's one `RefreshScheduler`, which arms its debounce on the
// clock it was handed; the readers take the window's clock, and under the fixture
// that is the scenario's frozen one. So real time moves none of
// those surfaces, and a case that polled it — `waitFor` and its five-second budget —
// would be polling a still picture until the budget ran out.
//
// ONE SHARED HELPER. The clock these two functions move is `ScenarioEngine`'s, and the
// surfaces that need moving are in every feature: the repo mounts, the artifact pane, the
// workflow run pane. Parked in one feature it would be a helper no other feature may import,
// so it lives in `tests/helpers/` beside `fixture-bridge.ts` and `scheduled-read.ts`.
//
// ONE HOME FOR BOTH HALVES, because the two are one act done wrong in two ways. An
// advance performed outside `act` lands its state updates untracked, and React reports
// that as a warning while the case reads whichever half of the transition it reached;
// an advance with no bound loops forever against a surface that is never going to
// answer. The loop's last pass therefore runs the caller's assertion outside the
// `try`, so a case that never settles fails with the assertion's own message rather
// than with a timeout that says nothing about what was missing.

import { act } from "@testing-library/react";
import type { ScenarioEngine } from "@renderer/services/daemon/engine.fixture.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { crossMacrotaskBoundary } from "./macrotask-boundary.js";

/**
 * How many debounce intervals a case may drive before giving up.
 *
 * A COUNT OF ADVANCES RATHER THAN A DURATION, because the budget being spent is
 * scenario time and not the runner's. Twenty-four intervals is 2880 ms of scenario
 * time — `REFRESH_MAX_WAIT_MS`, the longest a coalescing scheduler can hold a read,
 * spent nearly three times over. A caller still waiting past that is waiting on a
 * scenario BEAT rather than on a scheduler, and raising this number would hide which
 * of the two it was.
 */
const SCENARIO_SETTLE_PASSES = 24;

/** Move scenario time one debounce interval and flush whatever it released. */
export async function advanceScenarioOneInterval(engine: ScenarioEngine): Promise<void> {
  await act(async () => {
    engine.advance(REFRESH_DEBOUNCE_MS);
    await crossMacrotaskBoundary();
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
  engine: ScenarioEngine,
  assert: () => void,
): Promise<void> {
  for (let pass = 0; pass < SCENARIO_SETTLE_PASSES; pass += 1) {
    try {
      assert();
      return;
    } catch {
      await advanceScenarioOneInterval(engine);
    }
  }
  assert();
}
