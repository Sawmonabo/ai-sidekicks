import { describe, expect, it } from "vitest";

import { APPLY_COALESCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS } from "./live-announcement-caps.js";

describe("the live announcer's hold window", () => {
  it("holds a message for longer than one frame", () => {
    // A region set and reverted within a frame announces nothing; `APPLY_COALESCE_MS` is one frame.
    expect(LIVE_ANNOUNCEMENT_HOLD_MS).toBeGreaterThan(APPLY_COALESCE_MS);
  });
});
