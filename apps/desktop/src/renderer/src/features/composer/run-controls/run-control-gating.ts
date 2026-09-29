// Which run controls a run's BOUND DRIVER offers, and the read that answers.
//
// Split from `run-control-dispatch.ts` because it is a second job: that module
// decides what a control SENDS, and this one decides whether the control is on
// screen at all. Keeping them apart is what lets the gate be asserted without a
// bridge and the dispatch be asserted without a capability read.
//
// WHICH ONE IS GATED IS THIS MODULE'S OWN RULE, because no committed document states
// it: `steer` is gated on the bound driver's declared flag, while pause and interrupt
// are orchestration-layer and are never driver-gated. What a false flag DOES is the
// console's standing rule — absent, not disabled: such a control is not rendered,
// because a disabled one asserts the capability exists and is momentarily unavailable,
// which would be false.
//
// ON THE BOUND DRIVER — WHICH IS PER RUN, NOT PER SESSION. `driver.listCapabilities`
// answers with one report PER DRIVER (`DriverCapabilityReport` is keyed by its own
// `driverName`), and a session may hold runs on more than one. Intersecting those
// reports with `every` would answer a question nobody asked — "do ALL drivers here
// declare this?" — so the reports are RETAINED BY DRIVER and resolved per run, and one
// driver's declaration never answers for another driver's run.
//
// THE READ ITSELF IS THE BRIDGE'S, NOT THIS FAMILY'S. The declaration is addressed at
// the node rather than at a run, so `bridge/driver-capabilities/driver-capability-read.ts`
// performs one call per bridge and every gate resolves against the readout it hands
// back. This module keeps which control is gated on which flag, and which driver a RUN
// is bound to.
//
// WHAT NAMES A RUN'S DRIVER. No run-scoped wire shape does: `RunStateChangeEvent` and
// `RunRolledBackEvent` (the two arms of `run.subscribeState`) and `QueueItemSummary`
// each register no driver member, `runtime_bindings` is a daemon-local table with no
// client read, and `run.running` carries the execution posture rather than the
// binding. The AGENT does — `agent.attached` registers `driverName` on the persona,
// and `run.queued` names the agent a run was created for — so the pair is joined
// through the agent by `bridge/driver-capabilities/run-driver-binding.ts` and reaches
// this module as `driverNameByRunId`. That join is what makes a node with two drivers
// installed answerable at all.
//
// The sole-report fallback stays beneath it, for the session whose join has nothing
// to say yet: with exactly ONE driver reported for the node, that driver is the only
// one any run can hold. With two or more and no named binding, the answer is
// `undefined` — the console cannot say — and a gated control is absent, which is a
// different fact from a driver having declared `false` and is never reported as one.
//
// This is a projection of what the daemon DECLARED, never a rule the renderer
// derives. A control that is offered can still be refused — eligibility belongs to
// the daemon and reaches the surface as a typed refusal — and this file decides
// only whether a person is shown a button for a capability the driver does not
// have at all.

import { type DriverCapabilityFlag, type RunState } from "@ai-sidekicks/contracts";

import { isLiveRunState } from "@renderer/services/daemon/wire-identifiers.js";
import { readingForRun } from "@renderer/store/driver-capabilities/driver-capability-readings.js";
import { type DriverCapabilityReadout } from "@renderer/console/bridge/driver-capabilities/driver-capability-read.js";
import { type RunControl } from "./services/run-control-dispatch.js";

/**
 * The driver flag each control is gated on, or `undefined` where it is not gated.
 *
 * Total over the controls, so a new one has to answer this question rather than
 * silently defaulting to ungated. The flag name is a member of the registered
 * `DRIVER_CAPABILITY_FLAGS`, which is what the type annotation pins.
 */
export const CONTROL_CAPABILITY_GATE: Readonly<
  Record<RunControl, DriverCapabilityFlag | undefined>
> = {
  pause: undefined,
  resume: undefined,
  steer: "steer",
  interrupt: undefined,
};

/**
 * What is OFFERED for one run: the orchestration controls, and the capability-gated one.
 *
 * A caller that only wants "every control this run offers" concatenates the two lists,
 * which is what the palette contribution does.
 */
export interface OfferedRunControls {
  /** Never driver-gated: pause or resume, whichever the state admits, and stop. */
  readonly primary: readonly RunControl[];
  /** Capability-gated: steer. */
  readonly overflow: readonly RunControl[];
}

/**
 * Whether a control is OFFERED on the driver this run is bound to.
 *
 * Absent, never disabled. An ungated control is always offered, and a gated one is
 * offered only where the bound driver's report says `true` — so an unread capability
 * set, an unnameable binding, and a declared `false` all leave it off screen, which
 * is the fail-closed direction for all three.
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
 * The controls a run offers, decided in one place.
 *
 * One function, so the palette cannot offer steer on a driver that declared none.
 * Pause and resume are mutually exclusive on the state and never both: a paused run
 * offers resume, any other live run offers pause.
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

/** The capability-gated half. `pause`, `resume` and `interrupt` are never gated, so not here. */
const OVERFLOW_CONTROLS: readonly RunControl[] = ["steer"];
