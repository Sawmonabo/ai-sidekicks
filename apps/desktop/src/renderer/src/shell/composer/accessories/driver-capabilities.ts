// What each bound driver DECLARED, kept per driver rather than intersected.
//
// `driver.listCapabilities` answers with one report per driver, each naming itself.
// A session can hold more than one, and the composer is addressed at one agent with
// one binding — so the question the rail has to ask is "does THIS driver declare
// it", and an intersection across every reported driver answers a different one:
// it hides a capable driver's control whenever some other driver in the session
// lacks the flag.
//
// FAIL-CLOSED, IN THE ONLY DIRECTION THAT IS HONEST HERE. An unread capability set
// is `unknown` and not `undeclared`: the design's absent-not-disabled discipline
// makes `undeclared` an absence with nothing to say, and rule 8 makes `unknown`
// the `not-checked` reading — the question was never put. Collapsing the two would
// have a composer whose read has not landed look exactly like one bound to a driver
// that cannot compact.
//
// THE REPLY IS PARSED THROUGH THE REGISTERED SCHEMA AND NOTHING ELSE. A report the
// schema will not accept contributes no driver, so a malformed reply leaves every
// gate unread rather than declaring a flag off a shape nobody validated.

import { useEffect, useState } from "react";
import { ListCapabilitiesResultSchema, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import {
  DRIVER_LIST_CAPABILITIES_METHOD,
  callDaemon,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";
import type { CompactionCapabilityState } from "./CompactionControl.js";

/** Every reported driver's declared flags, keyed by its own wire-verbatim name. */
export type DeclaredCapabilitiesByDriver = Readonly<
  Record<string, Readonly<Record<DriverCapabilityFlag, boolean>>>
>;

/** Read the bound drivers' declarations. `undefined` until the read answers. */
export function useDeclaredCapabilitiesByDriver(
  bridge: ConsoleBridge,
): DeclaredCapabilitiesByDriver | undefined {
  const [reportsByDriver, setReportsByDriver] = useState<DeclaredCapabilitiesByDriver | undefined>(
    undefined,
  );

  useEffect(() => {
    let isMounted = true;
    setReportsByDriver(undefined);
    void callDaemon(bridge, DRIVER_LIST_CAPABILITIES_METHOD, {})
      .then((reply) => {
        const parsed = ListCapabilitiesResultSchema.safeParse(reply);
        if (!isMounted || !parsed.success) {
          return;
        }
        setReportsByDriver(
          Object.fromEntries(
            parsed.data.drivers.map((report) => [report.driverName, report.capabilities.flags]),
          ),
        );
      })
      .catch(() => {
        // A capability read that failed leaves every gate unread, which is the
        // fail-closed direction. It is not rendered as a refusal: no control was
        // pressed, and a banner for a read nobody asked for would be the console
        // reporting its own housekeeping.
      });
    return () => {
      isMounted = false;
    };
  }, [bridge]);

  return reportsByDriver;
}

/**
 * The compaction capability of one named driver, in the control's own vocabulary.
 *
 * `unknown` covers three genuinely identical situations — the read has not
 * answered, the wire has not named this agent's driver, and the reply named no such
 * driver — because in all three nobody has answered the question for THIS binding.
 */
export function compactionCapabilityFor(
  reportsByDriver: DeclaredCapabilitiesByDriver | undefined,
  driverName: string | undefined,
): CompactionCapabilityState {
  if (reportsByDriver === undefined || driverName === undefined) {
    return "unknown";
  }
  const flags = reportsByDriver[driverName];
  if (flags === undefined) {
    return "unknown";
  }
  return flags.context_compaction ? "declared" : "undeclared";
}
