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
// control on the same answer — so `bridge/driver-capabilities/driver-capability-read.ts` performs one
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
// through the agent by `bridge/driver-capabilities/run-driver-binding.ts` and reaches this module as
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

import { type DriverCapabilityFlag, type RunState } from "@ai-sidekicks/contracts";

import { readingForRun, type DriverCapabilityReadout } from "../../../bridge/index.js";
import { isLiveRunState } from "../run-status.js";
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
 * What a row OFFERS for one run, split the way the row draws it.
 *
 * Two lists rather than one, because the row's two halves are two different
 * density rules: `primary` is always visible on the run, `overflow` is the
 * one-click-away set. A caller that only wants "every control this run offers"
 * concatenates them, which is what the palette contribution does.
 */
export interface OfferedRunControls {
  /** Always visible on the row: the pause/resume verb the state admits, and stop. */
  readonly primary: readonly RunControl[];
  /** One click away, and capability-gated: steer, cancel, rewind. */
  readonly overflow: readonly RunControl[];
}

/**
 * The controls a run's row offers, as the row itself decides it.
 *
 * ONE READING, TWO READERS, and that is the reason this exists rather than the
 * row keeping the rule to itself. `RunControls.tsx` draws these and the palette
 * contributes exactly the same set, so "every action is palette-reachable under
 * the same when-grammar as the run controls" is a property of one function rather
 * than a claim two files have to keep agreeing about. A second copy is how the
 * palette ends up offering Rewind on a driver that declared none.
 *
 * `pause` and `resume` are mutually exclusive on the state and never both: the
 * row draws pause as `StepIn`, which sends `run.pause` and then takes the floor,
 * so a bare pause beside it would be two buttons for one call.
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
    // Not gated on liveness, matching the row: a completed run can still be
    // rewound, and cancel is refused by the daemon rather than hidden here.
    overflow: OVERFLOW_CONTROLS.filter((control) => isControlOffered(control, readout, run.runId)),
  };
}

/**
 * The one-click-away half, in the design's own order.
 *
 * `pause`, `resume`, and `interrupt` are the always-visible half and are not on
 * this list; `pause` reaches the row through `StepIn`, which sends it.
 */
const OVERFLOW_CONTROLS: readonly RunControl[] = ["steer", "cancel", "rollback"];
