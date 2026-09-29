import { describe, expect, it } from "vitest";

import { APPLY_COALESCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS } from "./live-announcement-caps.js";

describe("the live announcer's hold window", () => {
  it("holds a message for longer than one frame", () => {
    // A live region whose text is set and reverted inside a frame announces nothing:
    // the observer never sees a settled string. `APPLY_COALESCE_MS` is the app's own
    // name for one frame, so the hold has to sit above it.
    expect(LIVE_ANNOUNCEMENT_HOLD_MS).toBeGreaterThan(APPLY_COALESCE_MS);
  });
});
