// A capability readout, built the way the fixture's own scenario builds one. Shared so the
// gating and command-contribution suites cannot disagree on what "declared nothing" looks like.

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";
import { type DriverCapabilityReadout } from "@renderer/store/driver-capabilities/driver-capability-readout.js";
import type { DeclaredDriverFlags } from "@renderer/store/driver-capabilities/driver-capability-readout.js";

/**
 * One driver's record: the named flags true, every other flag false. Derived from the closed
 * flag set because `DriverCapabilities.flags` is a total strict record.
 */
export function declaredFlags(declared: readonly DriverCapabilityFlag[]): DeclaredDriverFlags {
  const asserted = new Set<DriverCapabilityFlag>(declared);
  return Object.fromEntries(
    DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, asserted.has(flag)]),
  ) as DeclaredDriverFlags;
}

/** A readout over the named reports, with the named run bindings. */
export function capabilityReadout(
  reports: readonly (readonly [string, readonly DriverCapabilityFlag[]])[],
  bindings: readonly (readonly [string, string])[] = [],
): DriverCapabilityReadout {
  return {
    flagsByDriverName: new Map(
      reports.map(([driverName, declared]) => [driverName, declaredFlags(declared)]),
    ),
    driverNameByRunId: new Map(bindings),
    readRefusal: undefined,
  };
}
