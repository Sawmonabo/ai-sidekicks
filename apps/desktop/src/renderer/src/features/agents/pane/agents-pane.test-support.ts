// How every Agents pane suite lets a scheduled read land.
//
// THE ADVANCE IS DERIVED, NOT TYPED OUT. What the settle has to do is pass the refresh
// scheduler's TRAILING debounce, and what it must not do is reach the absolute deadline:
// a settle that crossed `REFRESH_MAX_WAIT_MS` would fire the starvation arm and a case
// counting reads would be counting the harness.

import { act } from "@testing-library/react";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";

/**
 * How far a settle moves the scenario clock.
 *
 * Comfortably past {@link REFRESH_DEBOUNCE_MS} so a requested read actually fires, and
 * well short of the absolute deadline so the settle never fires the starvation arm
 * itself. Four debounce windows rather than a round number, because the multiple is
 * the claim: the headroom is measured in the bound it is clearing.
 */
const SETTLE_ADVANCE_MS: number = REFRESH_DEBOUNCE_MS * 4;

/** {@link drainScheduledReads} inside `act`, for a suite that has a mounted tree. */
export async function settleReads(bridge: PlatformBridge): Promise<void> {
  await act(async () => {
    await drainScheduledReads(bridge);
  });
}

/**
 * Move the scenario clock past the debounce and let every settled reply land.
 *
 * The microtask passes drain the read's own `await` chain — the call, the parse, and
 * the store apply — which is why a single `await Promise.resolve()` is not enough and
 * why the count lives here rather than being rediscovered per suite.
 */
async function drainScheduledReads(bridge: PlatformBridge): Promise<void> {
  bridge.scenarioEngine?.advance(SETTLE_ADVANCE_MS);
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve();
  }
}
