// Which run controls a run's bound driver offers.
//
// `steer` is gated on the bound driver's declared flag; pause, resume and interrupt are
// orchestration-layer and never gated. A false flag means the control is absent, not
// disabled, because a disabled one would claim the capability exists.
//
// The driver is per run, not per session: `driver.listCapabilities` answers one report per
// driver and a session may hold runs on several, so reports are kept by driver and resolved
// per run. The run-to-driver join is `run-driver-bindings.ts`, since no run-scoped wire shape
// names a driver but the agent does. The read itself is
// `services/driver-capabilities/driver-capability-read.ts`.
//
// With exactly one driver reported for the node, that driver is the sole fallback. With two or
// more and no named binding the answer is `undefined`, so a gated control is absent, which is
// not the same fact as a driver declaring `false`. This only projects what the daemon
// declared; a control offered can still be refused by the daemon.

import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts/provider-driver";
import type { RunState } from "@ai-sidekicks/contracts/run-state";

import { isLiveRunState } from "@renderer/services/daemon/wire-identifiers.js";
import { readingForRun } from "@renderer/store/driver-capabilities/driver-capability-readings.js";
import { type DriverCapabilityReadout } from "@renderer/store/driver-capabilities/driver-capability-readout.js";
import { type RunControl } from "./services/run-control-dispatch.js";

/**
 * The driver flag each control is gated on, or `undefined` where it is not gated. Total over
 * the controls, so a new one has to answer this rather than default to ungated.
 */
export const CONTROL_CAPABILITY_GATE: Readonly<
  Record<RunControl, DriverCapabilityFlag | undefined>
> = {
  pause: undefined,
  resume: undefined,
  steer: "steer",
  interrupt: undefined,
};

/** The capability-gated half. `pause`, `resume` and `interrupt` are never gated, so not here. */
const OVERFLOW_CONTROLS: readonly RunControl[] = ["steer"];

/** What is offered for one run: the orchestration controls, and the capability-gated one. */
export interface OfferedRunControls {
  /** Never driver-gated: pause or resume, whichever the state admits, and stop. */
  readonly primary: readonly RunControl[];
  /** Capability-gated: steer. */
  readonly overflow: readonly RunControl[];
}

/**
 * Whether a control is offered on the driver this run is bound to. A gated control is offered
 * only where the bound driver's report says `true`; an unread report, an unnameable binding
 * and a declared `false` all leave it off screen.
 */
export function isControlOffered(
  control: RunControl,
  readout: DriverCapabilityReadout | undefined,
  runId: string,
): boolean {
  const gate = CONTROL_CAPABILITY_GATE[control];
  if (gate === undefined) {
    return true;
  }
  return readingForRun(readout, runId, gate) === "declared";
}

/**
 * The controls a run offers, decided in one place so the palette cannot offer steer on a
 * driver that declared none. A paused run offers resume, any other live run offers pause.
 */
export function offeredRunControls(
  run: { readonly runId: string; readonly state: RunState },
  readout: DriverCapabilityReadout | undefined,
): OfferedRunControls {
  const live = isLiveRunState(run.state);
  const primary: RunControl[] = [];
  if (live) {
    primary.push(run.state === "paused" ? "resume" : "pause");
    primary.push("interrupt");
  }
  return {
    primary,
    // Not gated on liveness: the daemon refuses a steer at a run that cannot take one.
    overflow: OVERFLOW_CONTROLS.filter((control) => isControlOffered(control, readout, run.runId)),
  };
}
