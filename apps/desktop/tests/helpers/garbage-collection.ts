// A full collection of the page's heap, for the browser tiers, which run Chromium with `gc()`
// exposed.

import { expect } from "vitest";

/** Collects every object nothing holds, now. Fails the case when the page cannot. */
export function collectGarbage(): void {
  const { gc } = globalThis as { gc?: () => void };
  if (gc === undefined) {
    expect.fail("the page cannot collect its garbage");
  }
  gc();
}
