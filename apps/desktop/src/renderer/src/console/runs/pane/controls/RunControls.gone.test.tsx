// A run the daemon no longer has: no acts, every figure kept.
//
// Rendered rather than asserted on the reading, because the claim is about what is on
// screen — that the strip goes to the refusal alone and that the row is not removed —
// and a reading test cannot tell the difference between a withdrawn control and a
// control that was never offered.

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../../core/index.js";
import { RUN_ID, renderControls as renderStrip } from "./run-controls.test-support.js";
import { type RunControlRecord } from "./run-control-surface.js";

function refusedWith(code: string): RunControlRecord {
  return {
    recordId: "one",
    runId: RUN_ID,
    control: "pause",
    outcome: { kind: "refused", control: "pause", refusal: refuse("run-control", code, "\u2026") },
  };
}

function renderControls(records: readonly RunControlRecord[]): void {
  renderStrip({ records });
}

describe("a run the daemon answered does not exist", () => {
  it("offers no control at all, primary or overflow", () => {
    renderControls([refusedWith("run.not_found")]);

    expect(screen.queryAllByRole("button")).toStrictEqual([]);
  });

  it("says the run is gone and that what is shown is the last state reported", () => {
    renderControls([refusedWith("run.not_found")]);

    expect(screen.getByText("run.not_found")).not.toBeNull();
    expect(screen.getByText(/last state the stream reported/)).not.toBeNull();
  });
});

describe("negative control: every other refusal leaves the strip", () => {
  it("keeps the controls after a stale comparand", () => {
    // Withdrawing on any refusal would take away a control the next press would have
    // worked, which is the failure this rule is narrow to avoid.
    renderControls([refusedWith("run.version_conflict")]);

    expect(screen.queryAllByRole("button").length).toBeGreaterThan(0);
    expect(screen.getByText("run.version_conflict")).not.toBeNull();
  });

  it("keeps the controls on a run whose settlements carried no refusal at all", () => {
    renderControls([]);

    expect(screen.queryAllByRole("button").length).toBeGreaterThan(0);
  });
});
