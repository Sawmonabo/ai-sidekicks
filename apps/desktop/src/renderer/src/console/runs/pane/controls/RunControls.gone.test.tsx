// A run the daemon no longer has: no acts, every figure kept.
//
// Rendered rather than asserted on the reading, because the claim is about what is on
// screen — that the strip goes to the refusal alone and that the row is not removed —
// and a reading test cannot tell the difference between a withdrawn control and a
// control that was never offered.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../../../core/index.js";
import { type ConsoleBridge, type DriverCapabilityReadout } from "../../../bridge/index.js";
import { type RunProjection } from "../run-state-projection.js";
import { RunControls } from "./RunControls.js";
import { capabilityReadout } from "./driver-capability-readout.test-support.js";
import { type RunControlRecord, type RunControlSurface } from "./run-control-surface.js";

const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";

const RUNNING: RunProjection = {
  runId: RUN_ID,
  runVersion: 7,
  state: "running",
  trigger: undefined,
  intendedClose: false,
  failureCategory: undefined,
  providerFailureDetail: undefined,
  rewoundToPosition: undefined,
  executionPosture: undefined,
  firstSeenAtIso: "2026-09-02T09:00:00.000Z",
  updatedAtIso: "2026-09-02T09:00:00.000Z",
  statusRows: [],
};

const CAPABLE: DriverCapabilityReadout = capabilityReadout(
  [["claude", ["steer", "rollback"]]],
  [[RUN_ID, "claude"]],
);

function refusedWith(code: string): RunControlRecord {
  return {
    recordId: "one",
    runId: RUN_ID,
    control: "pause",
    outcome: { kind: "refused", control: "pause", refusal: refuse("run-control", code, "…") },
  };
}

function surfaceHolding(records: readonly RunControlRecord[]): RunControlSurface {
  return {
    dispatcher: {
      comparandFor: (_runId: string, streamReading: number) => streamReading,
    } as RunControlSurface["dispatcher"],
    records,
    inFlightKeys: new Set<string>(),
    dispatch: () => ({ admitted: true, dispatchToken: "token" }),
  };
}

function renderControls(records: readonly RunControlRecord[]): void {
  render(
    <RunControls
      run={RUNNING}
      surface={surfaceHolding(records)}
      bridge={{} as ConsoleBridge}
      driverCapabilities={CAPABLE}
      onTakeTheFloor={vi.fn()}
      onRequestRewind={vi.fn()}
      onRequestSteer={vi.fn()}
    />,
  );
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
