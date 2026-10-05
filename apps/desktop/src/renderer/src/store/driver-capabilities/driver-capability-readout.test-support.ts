// Readouts and helpers the capability suites use to stand for "nothing was read".

import { type Refusal } from "#renderer/lib/refusal/refusal.js";
import type { DriverCapabilityReadout } from "./driver-capability-readout.js";

/** The refusal a settled reading carries, or a failure naming what was found instead. */
export function settledRefusalOf(readout: DriverCapabilityReadout | undefined): Refusal {
  if (readout?.readRefusal === undefined) {
    throw new Error("the capability read settled without the refusal the case is about");
  }
  return readout.readRefusal;
}

/** A reading no read produces, so a probe whose callback never ran fails loudly. */
export function neverRead(): DriverCapabilityReadout {
  return { flagsByDriverName: new Map(), driverNameByRunId: new Map(), readRefusal: undefined };
}
