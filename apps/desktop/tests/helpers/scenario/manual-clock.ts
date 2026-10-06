// How a case moves the fixture's frozen clock, for every view that schedules a read.
//
// Every read an app view performs goes through the app's one `RefreshScheduler`, which arms
// its debounce on the window's clock, and under the fixture that is the scenario's frozen one.
// Real time moves none of those views, so a case that polled it would poll a still picture until
// its budget ran out. The helper is shared because the views that need moving are in every
// feature. An advance outside `act` lands its state updates untracked, and an unbounded advance
// loops forever against a view that never answers; the last pass runs the caller's assertion
// outside the `try`, so a case that never settles fails with the assertion's own message.

import type { ScenarioEngine } from "#renderer/services/daemon/engine.fixture.js";
import { REFRESH_DEBOUNCE_MS } from "#renderer/lib/reads/refresh/caps.js";
import { settle } from "../settle.js";

/**
 * How many debounce intervals a case may drive before giving up.
 *
 * A count of advances rather than a duration, since the budget is scenario time. Twenty-four
 * intervals is 2880 ms, nearly three times `REFRESH_MAX_WAIT_MS`, the longest a coalescing
 * scheduler holds a read. A caller still waiting past that is waiting on a scenario beat, and
 * raising this number would hide which it was.
 */
const SCENARIO_SETTLE_PASSES = 24;

/**
 * Drive scenario time until `assert` holds, or fail with `assert`'s own message.
 *
 * Stops at the first pass that holds, since every extra advance delivers another scenario beat
 * and moves every deadline the view renders against, which would pin a different composition
 * from the one the case is about.
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
      await settle(() => {
        engine.advance(REFRESH_DEBOUNCE_MS);
      });
    }
  }
  assert();
}
