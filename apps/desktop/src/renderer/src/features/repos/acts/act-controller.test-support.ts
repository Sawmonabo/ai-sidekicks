// The two waits the act suites share: draining queued continuations, and letting one scheduled
// prerequisite read go out past the debounce.

import { type ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";

/** Let every queued continuation run, so a served answer has landed. */
export async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

/** Move past the debounce so the scheduled read goes out, and let it start. */
export async function runScheduledRead(clock: ManualClock): Promise<void> {
  await flush();
  clock.advance(REFRESH_DEBOUNCE_MS);
  await flush();
}
