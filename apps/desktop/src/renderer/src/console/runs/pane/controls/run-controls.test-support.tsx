// The control strip mounted the way the row mounts it, and the run it is mounted for.
//
// Hoisted on second use, per `apps/desktop/AGENTS.md`: the gone suite and the shell
// suite both need one running run, one driver that declared the two gated controls, and
// a surface holding a chosen record set — and two copies of that scaffolding is how one
// of them quietly stops covering an arm the other still does.
//
// THE SURFACE IS HAND-BUILT AND THE STRIP IS NOT. What both suites assert is what the
// row DRAWS: which controls are on screen, and which of them may be pressed. The
// surface is the collaborator that holds the in-flight set and the settled records, so
// a suite states those directly rather than driving a transport to arrive at them; the
// component under test is imported whole.

import { render } from "@testing-library/react";

import { type ConsoleBridge, type DriverCapabilityReadout } from "../../../bridge/index.js";
import { type FrameStore } from "../../../store/index.js";
import { quietShell } from "../../../store/shell-condition.test-support.js";
import { type RunProjection } from "../run-state-projection.js";
import { RunControls } from "./RunControls.js";
import { capabilityReadout } from "./driver-capability-readout.test-support.js";
import { type RunControlRecord, type RunControlSurface } from "./run-control-surface.js";

/** A real identifier, because the row renders it and the readout is keyed by it. */
export const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";

/** A run the daemon is executing: pause, stop, and the whole overflow are offered. */
export const RUNNING: RunProjection = {
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

/** The same run at rest, which is what puts `resume` on the strip in place of pause. */
export const PAUSED: RunProjection = { ...RUNNING, state: "paused" };

/** A driver that declared both gated controls, so the overflow is at its widest. */
export const CAPABLE: DriverCapabilityReadout = capabilityReadout(
  [["claude", ["steer", "rollback"]]],
  [[RUN_ID, "claude"]],
);

/** A surface holding the records under test, nothing in flight, admitting every press. */
export function surfaceHolding(records: readonly RunControlRecord[]): RunControlSurface {
  return {
    dispatcher: {
      comparandFor: (_runId: string, streamReading: number) => streamReading,
    } as RunControlSurface["dispatcher"],
    records,
    inFlightKeys: new Set<string>(),
    dispatch: () => ({ admitted: true, dispatchToken: "token" }),
  };
}

/** The strip, over one run, one record set, and one shell condition. */
export function renderControls(
  options: {
    readonly run?: RunProjection;
    readonly records?: readonly RunControlRecord[];
    readonly frameStore?: FrameStore;
    /** A surface that records what was dispatched, where a case asks whether one was. */
    readonly surface?: RunControlSurface;
    /** The compose callbacks, for the cases that ask whether a press reached them. */
    readonly onRequestRewind?: () => void;
    readonly onRequestSteer?: () => void;
  } = {},
): HTMLElement {
  const { container } = render(
    <RunControls
      run={options.run ?? RUNNING}
      surface={options.surface ?? surfaceHolding(options.records ?? [])}
      bridge={{} as ConsoleBridge}
      frameStore={options.frameStore ?? quietShell()}
      driverCapabilities={CAPABLE}
      onTakeTheFloor={() => undefined}
      onRequestRewind={options.onRequestRewind ?? (() => undefined)}
      onRequestSteer={options.onRequestSteer ?? (() => undefined)}
    />,
  );
  return container;
}
