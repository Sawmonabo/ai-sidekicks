// Which of the six controls a run's BOUND DRIVER offers, and the read that answers.
//
// Split from `run-control-dispatch.ts` because it is a second job: that module
// decides what a control SENDS, and this one decides whether the control is on
// screen at all. Keeping them apart is what lets the gate be asserted without a
// bridge and the dispatch be asserted without a capability read.
//
// `Spec-023 §Console Design (Meridian)` §7.2: "Two of the six are capability-gated
// on the bound driver: `steer` and `rollback`. Pause, resume, interrupt, and cancel
// are orchestration-layer and are never driver-gated. A gated control whose flag is
// false is ABSENT, not greyed, on the absent-not-disabled discipline."
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
// WHAT NAMES A RUN'S DRIVER, AND WHAT DOES NOT. Nothing this console can read today
// carries the pair on a run-scoped shape: `RunStateChangeEvent` and
// `RunRolledBackEvent` (the two arms of `run.subscribeState`) and `QueueItemSummary`
// each register no driver member, `runtime_bindings` is a daemon-local table with no
// client read, and `run.running` carries the execution posture rather than the
// binding. The one client-readable shape that pairs the two is
// `ProviderCommandBindingGroup` on the `driver.listProviderCommands` reply —
// `{ runId, binding: { driverName, providerAccountId } }` — which is addressed by
// AGENT and which no console surface reads yet. `driverNameByRunId` is where such a
// read lands; it is empty until one exists, and the resolution below falls back on
// the only binding the capability reply itself admits: with exactly ONE driver
// reported for the session, that driver is the only one any run in it can hold. With
// two or more and no named binding, the answer is `undefined` — the console cannot
// say — and a gated control is absent, which is a different fact from a driver
// having declared `false` and is never reported as one.
//
// This is a projection of what the daemon DECLARED, never a rule the renderer
// derives. A control that is offered can still be refused — eligibility belongs to
// the daemon and reaches the surface as a typed refusal — and this file decides
// only whether a person is shown a button for a capability the driver does not
// have at all.

import { useEffect, useState } from "react";
import { ListCapabilitiesResultSchema, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import {
  DRIVER_LIST_CAPABILITIES_METHOD,
  callDaemon,
  type ConsoleBridge,
} from "../../bridge/index.js";
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

/** One driver's declared flags, exactly as its own report carried them. */
export type DeclaredDriverFlags = Readonly<Record<DriverCapabilityFlag, boolean>>;

/** What the capability read answered. Absent until the read answers. */
export interface DriverCapabilityReadout {
  /**
   * One entry per reported driver, keyed by the reply's own `driverName`.
   *
   * Retained, never folded: the reports are separate declarations by separate
   * drivers, and any collapse of them is an answer to a question the surface does
   * not ask.
   */
  readonly flagsByDriverName: ReadonlyMap<string, DeclaredDriverFlags>;
  /**
   * Which driver each run is bound to, for every run a read has named a binding for.
   *
   * Empty today — see the header for the shapes that were checked and what each one
   * does and does not carry. It is a map rather than a derivation so that the read
   * which lands it changes one producer and no consumer.
   */
  readonly driverNameByRunId: ReadonlyMap<string, string>;
}

/**
 * Read the bound drivers' declared capability flags.
 *
 * A read that failed leaves the readout absent, which is the fail-closed direction:
 * both gated controls stay off screen. The failure is not rendered as a refusal —
 * no control was pressed, and a banner for a read nobody asked for would be the
 * console reporting its own housekeeping.
 */
export function useDriverCapabilities(bridge: ConsoleBridge): DriverCapabilityReadout | undefined {
  const [readout, setReadout] = useState<DriverCapabilityReadout | undefined>(undefined);

  useEffect(() => {
    let isMounted = true;
    setReadout(undefined);
    void callDaemon(bridge, DRIVER_LIST_CAPABILITIES_METHOD, {})
      .then((reply) => {
        const parsed = ListCapabilitiesResultSchema.safeParse(reply);
        if (!isMounted || !parsed.success || parsed.data.drivers.length === 0) {
          return;
        }
        const flagsByDriverName = new Map<string, DeclaredDriverFlags>();
        for (const report of parsed.data.drivers) {
          flagsByDriverName.set(report.driverName, report.capabilities.flags);
        }
        setReadout({ flagsByDriverName, driverNameByRunId: NO_RUN_BINDINGS });
      })
      .catch(() => {
        // See the doc comment: a failed capability read is an absent readout.
      });
    return () => {
      isMounted = false;
    };
  }, [bridge]);

  return readout;
}

/**
 * Which driver a run is bound to, or `undefined` where the console cannot say.
 *
 * Two sources in priority order and no third: a binding a read named for this run,
 * then the sole-report fallback the header explains. Guessing between two reported
 * drivers is deliberately not one of them — a wrong guess offers a control the
 * daemon will always refuse, or hides one it would have honoured.
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
 * §7.2's absent-not-disabled discipline, and never as a declared `false`.
 */
export function driverCapabilityForRun(
  readout: DriverCapabilityReadout | undefined,
  runId: string,
  flag: DriverCapabilityFlag,
): boolean | undefined {
  const driverName = boundDriverNameForRun(readout, runId);
  if (readout === undefined || driverName === undefined) {
    return undefined;
  }
  return readout.flagsByDriverName.get(driverName)?.[flag];
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

/** No run has a named binding yet. Frozen so no caller writes one in place. */
const NO_RUN_BINDINGS: ReadonlyMap<string, string> = new Map<string, string>();
