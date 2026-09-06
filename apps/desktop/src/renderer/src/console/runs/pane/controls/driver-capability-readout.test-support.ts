// A capability readout, built the way the fixture's own scenario builds one.
//
// Hoisted out of `run-control-gating.test.ts` on its second use: the command
// contribution is gated by the same reading the row is, so its suite needs the same
// readout, and a second copy of this would be two answers to what "the driver
// declared nothing" looks like.

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import { type DriverCapabilityReadout } from "../../../bridge/index.js";
import type { DeclaredDriverFlags } from "../../../bridge/driver-capabilities/driver-capability-read.js";

/**
 * One driver's record: the named flags true, every other flag false.
 *
 * Derived from the shipped closed set rather than hand-listed, exactly as the
 * fixture's own scenario does: `DriverCapabilities.flags` is a total record parsed
 * `.strict()`, so a hand list would go stale the day the set grows.
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
