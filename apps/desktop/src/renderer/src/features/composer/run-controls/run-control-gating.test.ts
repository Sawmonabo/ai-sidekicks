// Which run controls a run's bound driver offers. Steer is the one gated control: a driver
// that declared it absent, or a report never read, leaves it off screen rather than disabled.
// Pause, resume and stop are never gated, so no capability reading can take them off a run.

import { describe, expect, it } from "vitest";

import { readingForRun } from "@renderer/store/driver-capabilities/driver-capability-readings.js";
import { capabilityReadout as readout } from "./driver-capability-readout.test-support.js";
import { isControlOffered, offeredRunControls } from "./run-control-gating.js";

const CLAUDE_RUN = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const CODEX_RUN = "c4a1b2d3-5e6f-4071-8b82-0d3e4f506172";

describe("capability gating resolves the run's own bound driver", () => {
  it("hides Steer on the run whose own driver declared it absent", () => {
    const capabilities = readout(
      [
        ["claude", ["steer"]],
        ["codex", []],
      ],
      [
        [CLAUDE_RUN, "claude"],
        [CODEX_RUN, "codex"],
      ],
    );
    expect(readingForRun(capabilities, CODEX_RUN, "steer")).toBe("undeclared");
    expect(isControlOffered("steer", capabilities, CODEX_RUN)).toBe(false);
  });

  it("negative control: an ungated control is offered through every one of those arms", () => {
    // Without this the gated cases would pass over a gate that hid everything.
    for (const capabilities of [
      undefined,
      readout([
        ["claude", []],
        ["codex", []],
      ]),
    ]) {
      expect(isControlOffered("pause", capabilities, CLAUDE_RUN)).toBe(true);
      expect(isControlOffered("resume", capabilities, CLAUDE_RUN)).toBe(true);
      expect(isControlOffered("interrupt", capabilities, CLAUDE_RUN)).toBe(true);
    }
  });
});

describe("the row's offer reading, which the palette contributes from", () => {
  const CAPABLE = readout([["claude", ["steer"]]], [[CLAUDE_RUN, "claude"]]);

  it("offers pause, stop and steer on a running run", () => {
    const offered = offeredRunControls({ runId: CLAUDE_RUN, state: "running" }, CAPABLE);

    expect(offered.primary).toEqual(["pause", "interrupt"]);
    expect(offered.overflow).toEqual(["steer"]);
  });

  it("keeps steer off a run whose driver did not declare it", () => {
    const bare = readout([["codex", []]], [[CODEX_RUN, "codex"]]);

    const offered = offeredRunControls({ runId: CODEX_RUN, state: "running" }, bare);

    expect(offered.overflow).toEqual([]);
  });

  it("keeps steer off a run whose capabilities were never read", () => {
    const offered = offeredRunControls({ runId: CLAUDE_RUN, state: "running" }, undefined);

    expect(offered.overflow).toEqual([]);
  });
});
