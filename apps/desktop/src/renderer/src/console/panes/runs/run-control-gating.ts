// Which of the six controls a run's BOUND DRIVER offers, and the read that answers.
//
// Split from `run-control-dispatch.ts` because it is a second job: that module
// decides what a control SENDS, and this one decides whether the control is on
// screen at all. Keeping them apart is what lets the gate be asserted without a
// bridge and the dispatch be asserted without a capability read.
//
// WHICH TWO ARE GATED IS THIS MODULE'S OWN RULE, because no committed document
// states it: `steer` and `rollback` are gated on the bound driver's declared flags,
// while pause, resume, interrupt, and cancel are orchestration-layer and are never
// driver-gated. What a false flag DOES is the corpus's — `Spec-023 §Rules every
// console surface obeys`, "Absent, not disabled": such a control is not rendered,
// because a disabled one asserts the capability exists and is momentarily
// unavailable, which would be false.
//
// ON THE BOUND DRIVER — WHICH IS PER RUN, NOT PER SESSION. `driver.listCapabilities`
// answers with one report PER DRIVER (`DriverCapabilityReport` is keyed by its own
// `driverName`), and a session may hold runs on more than one. Intersecting those
// reports with `every` answered a question nobody asked — "do ALL drivers here
// declare this?" — and its `false` hid Rewind on a capable Claude run merely because
// some Codex driver in the same session reported `rollback: false`. So the reports
// are RETAINED BY DRIVER and resolved per run, and one driver's declaration never
// answers for another driver's run.
//
// THE READ ITSELF IS THE BRIDGE'S, NOT THIS FAMILY'S. The declaration is addressed at
// the node rather than at a run, and the composer's accessory rail gates its own
// control on the same answer — so `bridge/driver-capability-read.ts` performs one
// call per bridge and both families resolve against the readout it hands back. This
// module keeps the half that is genuinely the runs pane's: which control is gated on
// which flag, and which driver a RUN is bound to.
//
// WHAT NAMES A RUN'S DRIVER. No run-scoped wire shape does: `RunStateChangeEvent` and
// `RunRolledBackEvent` (the two arms of `run.subscribeState`) and `QueueItemSummary`
// each register no driver member, `runtime_bindings` is a daemon-local table with no
// client read, and `run.running` carries the execution posture rather than the
// binding. The AGENT does — `agent.attached` registers `driverName` on the persona,
// and `run.queued` names the agent a run was created for — so the pair is joined
// through the agent by `bridge/run-driver-binding.ts` and reaches this module as
// `driverNameByRunId`. That join is what makes a node with two drivers installed
// answerable at all: it used to be empty, and the resolution below then fell through
// to `undefined` for every run on such a node, taking Rewind and Steer off every row
// however loudly each run's own driver had declared them.
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

import { type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import { declaredFlagsForDriver, type DriverCapabilityReadout } from "../../bridge/index.js";
import { type RunControl } from "./run-control-dispatch.js";

/**
 * The driver flag each control is gated on, or `undefined` where it is not gated.
 *
 * Total over the six, so a seventh control has to answer this question rather than
 * silently defaulting to ungated. The two flag names are members of the registered
 * `DRIVER_CAPABILITY_FLAGS`, which is what the type annotation pins.
 */
export const CONTROL_CAPABILITY_GATE: Readonly<
  Record<RunControl, DriverCapabilityFlag | undefined>
> = {
  pause: undefined,
  resume: undefined,
  steer: "steer",
  interrupt: undefined,
  cancel: undefined,
  rollback: "rollback",
};

/**
 * Which driver a run is bound to, or `undefined` where the console cannot say.
 *
 * Two sources in priority order and no third: the binding the session's own
 * projection named for this run, then the sole-report fallback the header explains.
 * Guessing between two reported drivers is deliberately not one of them — a wrong
 * guess offers a control the daemon will always refuse, or hides one it would have
 * honoured.
 */
export function boundDriverNameForRun(
  readout: DriverCapabilityReadout | undefined,
  runId: string,
): string | undefined {
  if (readout === undefined) {
    return undefined;
  }
  const named = readout.driverNameByRunId.get(runId);
  if (named !== undefined) {
    return named;
  }
  if (readout.flagsByDriverName.size !== 1) {
    return undefined;
  }
  const [onlyReportedDriverName] = readout.flagsByDriverName.keys();
  return onlyReportedDriverName;
}

/**
 * Whether the driver bound to one run declares one capability flag.
 *
 * Three answers and they are three different facts: `true` — that driver declared
 * it; `false` — that driver declared it absent; `undefined` — the console cannot
 * say, because the read has not answered, the run's binding is not nameable, or the
 * named driver filed no report. Every caller renders `undefined` as ABSENT, on
 * the absent-not-disabled rule the header cites, and never as a declared `false`.
 */
export function driverCapabilityForRun(
  readout: DriverCapabilityReadout | undefined,
  runId: string,
  flag: DriverCapabilityFlag,
): boolean | undefined {
  return declaredFlagsForDriver(readout, boundDriverNameForRun(readout, runId))?.[flag];
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
  return driverCapabilityForRun(readout, runId, gate) === true;
}
