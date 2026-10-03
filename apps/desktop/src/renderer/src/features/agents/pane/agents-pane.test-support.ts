// How every Agents pane suite lets a scheduled read land. The advance passes the refresh
// scheduler's trailing debounce but stays short of `REFRESH_MAX_WAIT_MS`, so a case counting
// reads does not count the starvation arm.

import { act } from "@testing-library/react";
import type { ScenarioEngine } from "@renderer/services/daemon/engine.fixture.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";

/**
 * How far a settle moves the scenario clock: four debounce windows, past
 * {@link REFRESH_DEBOUNCE_MS} so a requested read fires, well short of the absolute deadline.
 */
const SETTLE_ADVANCE_MS: number = REFRESH_DEBOUNCE_MS * 4;

/** {@link drainScheduledReads} inside `act`, for a suite that has a mounted tree. */
export async function settleReads(scenarioEngine: ScenarioEngine): Promise<void> {
  await act(async () => {
    await drainScheduledReads(scenarioEngine);
  });
}

/**
 * Move the scenario clock past the debounce and let every settled reply land. The microtask
 * passes drain the read's `await` chain (call, parse, store apply); one is not enough.
 */
async function drainScheduledReads(scenarioEngine: ScenarioEngine): Promise<void> {
  scenarioEngine.advance(SETTLE_ADVANCE_MS);
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve();
  }
}
