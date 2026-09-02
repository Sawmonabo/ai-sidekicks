// Which of the six controls this driver offers, and the read that answers.
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
// This is a projection of what the daemon DECLARED, never a rule the renderer
// derives. A control that is offered can still be refused — eligibility belongs to
// the daemon and reaches the surface as a typed refusal — and this file decides
// only whether a person is shown a button for a capability the driver does not
// have at all.

import { useEffect, useState } from "react";
import {
  DRIVER_CAPABILITY_FLAGS,
  ListCapabilitiesResultSchema,
  type DriverCapabilityFlag,
} from "@ai-sidekicks/contracts";

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

/** Which driver flags this console has READ. Absent until the read answers. */
export type DeclaredCapabilities = Readonly<Record<DriverCapabilityFlag, boolean>> | undefined;

/**
 * Read the bound drivers' declared capability flags.
 *
 * The reply carries one report per driver and the console holds one binding per
 * run, but no registered reply maps a run to its driver — so a flag is treated as
 * declared only when EVERY reported driver declares it. That is the fail-closed
 * reading: offering a gated control because some other driver supports it would put
 * a button in front of a person that the daemon will always refuse.
 */
export function useDeclaredCapabilities(bridge: ConsoleBridge): DeclaredCapabilities {
  const [flags, setFlags] = useState<DeclaredCapabilities>(undefined);

  useEffect(() => {
    let isMounted = true;
    setFlags(undefined);
    void callDaemon(bridge, DRIVER_LIST_CAPABILITIES_METHOD, {})
      .then((reply) => {
        const parsed = ListCapabilitiesResultSchema.safeParse(reply);
        if (!isMounted || !parsed.success || parsed.data.drivers.length === 0) {
          return;
        }
        const reports = parsed.data.drivers;
        setFlags(
          Object.fromEntries(
            DRIVER_CAPABILITY_FLAGS.map((flag) => [
              flag,
              reports.every((report) => report.capabilities.flags[flag]),
            ]),
          ) as Readonly<Record<DriverCapabilityFlag, boolean>>,
        );
      })
      .catch(() => {
        // A capability read that failed leaves both gated controls absent, which is
        // the fail-closed direction. The failure is not rendered as a refusal: no
        // control was pressed, and a banner for a read nobody asked for would be
        // the console reporting its own housekeeping.
      });
    return () => {
      isMounted = false;
    };
  }, [bridge]);

  return flags;
}

/**
 * Whether a control is OFFERED on this driver.
 *
 * Absent, never disabled: §7.2's absent-not-disabled discipline. An ungated control
 * is always offered, and a gated one is offered only once the read has answered
 * `true` — so an unread capability set offers neither gated control.
 */
export function isControlOffered(control: RunControl, flags: DeclaredCapabilities): boolean {
  const gate = CONTROL_CAPABILITY_GATE[control];
  if (gate === undefined) {
    return true;
  }
  return flags?.[gate] === true;
}
