// A running run always offers the controls that halt it: pause and stop are never gated on a
// driver, so no capability reading can take them off a run that is going.

import { describe, expect, it } from "vitest";

import { capabilityReadout as readout } from "./driver-capability-readout.test-support.js";
import { offeredRunControls } from "./run-control-gating.js";

const CLAUDE_RUN = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";

describe("the row's offer reading, which the palette contributes from", () => {
  const CAPABLE = readout([["claude", ["steer"]]], [[CLAUDE_RUN, "claude"]]);

  it("offers pause, stop and steer on a running run", () => {
    const offered = offeredRunControls({ runId: CLAUDE_RUN, state: "running" }, CAPABLE);

    expect(offered.primary).toEqual(["pause", "interrupt"]);
    expect(offered.overflow).toEqual(["steer"]);
  });
});
