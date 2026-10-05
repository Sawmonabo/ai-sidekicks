// The pure readers over one capability readout: which driver a run is bound to, and what this
// build knows about one flag on it. None performs a read (the wire is in
// `services/driver-capabilities/driver-capability-read.ts`); each takes the readout it answers
// about, and `undefined` is admitted because the read may not have answered yet.

import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";

import type { DeclaredDriverFlags, DriverCapabilityReadout } from "./driver-capability-readout.js";

/**
 * The service's declarations, joined to one session's run-to-driver bindings.
 *
 * Joined at the consumer, not in the per-bridge cache, which holds no session. The readout is
 * returned untouched where there is nothing to join, so a caller compares the same pointer.
 *
 * @consumedBy the run controls' Interrupt and Interrupt everything
 */
export function withRunDriverBindings(
  readout: DriverCapabilityReadout | undefined,
  driverNameByRunId: ReadonlyMap<string, ProviderName>,
): DriverCapabilityReadout | undefined {
  if (readout === undefined || driverNameByRunId.size === 0) {
    return readout;
  }
  return { ...readout, driverNameByRunId };
}

/**
 * One named driver's declared flags, or `undefined` where the console cannot say: the read has
 * not answered, the caller could not name the driver, or the reply named no such driver.
 */
export function declaredFlagsForDriver(
  readout: DriverCapabilityReadout | undefined,
  driverName: ProviderName | undefined,
): DeclaredDriverFlags | undefined {
  if (readout === undefined || driverName === undefined) {
    return undefined;
  }
  return readout.flagsByDriverName.get(driverName);
}

/**
 * What this build knows about one driver flag. Declared once, for every consumer.
 *
 * `declared`: that driver declared it. `undeclared`: that driver declared it absent.
 * `unknown`: nobody has answered, because the read has not landed, the run's binding is not
 * nameable, or the named driver filed no report. A boolean cannot carry the third, and
 * collapsing it onto `undeclared` would show an unread session like one bound to a driver that
 * cannot do the thing.
 */
export const DRIVER_CAPABILITY_READINGS = ["declared", "undeclared", "unknown"] as const;

/** One reading of one driver flag. Derived from the enumeration above. */
export type DriverCapabilityReading = (typeof DRIVER_CAPABILITY_READINGS)[number];

/**
 * Which driver a run is bound to, or `undefined` where the console cannot say.
 *
 * The binding the session's projection named for this run wins; otherwise, if exactly one
 * driver filed a report, that report is this run's. Guessing between two reported drivers
 * would offer a control the daemon always refuses or hide one it would honor.
 */
export function boundDriverNameForRun(
  readout: DriverCapabilityReadout | undefined,
  runId: string,
): ProviderName | undefined {
  if (readout === undefined) {
    return undefined;
  }
  return readout.driverNameByRunId.get(runId) ?? soleReportedDriverName(readout);
}

/**
 * What this build knows about one flag on the driver one run is bound to.
 *
 * The console's single answer to that question, so a view using the sole-report fallback and
 * one handed a driver name cannot disagree about one readout.
 */
export function readingForDriver(
  readout: DriverCapabilityReadout | undefined,
  driverName: ProviderName | undefined,
  flag: DriverCapabilityFlag,
): DriverCapabilityReading {
  const resolved =
    driverName ?? (readout === undefined ? undefined : soleReportedDriverName(readout));
  const flags = declaredFlagsForDriver(readout, resolved);
  if (flags === undefined) {
    return "unknown";
  }
  return flags[flag] ? "declared" : "undeclared";
}

/**
 * The same question asked of a run rather than of a named driver, for callers that hold a run
 * id and not a binding, such as the composer's run controls. A caller that already resolved the
 * driver asks `readingForDriver` with the name it has.
 */
export function readingForRun(
  readout: DriverCapabilityReadout | undefined,
  runId: string,
  flag: DriverCapabilityFlag,
): DriverCapabilityReading {
  return readingForDriver(readout, boundDriverNameForRun(readout, runId), flag);
}

/**
 * The one driver the service reported, where it reported exactly one.
 *
 * `driver.listCapabilities` is addressed at the service and names no run, so refusing to answer
 * on a one-driver installation would take every capability-gated control off every run. With
 * two drivers reported the question really is unanswered.
 */
function soleReportedDriverName(readout: DriverCapabilityReadout): ProviderName | undefined {
  if (readout.flagsByDriverName.size !== 1) {
    return undefined;
  }
  const [onlyReportedDriverName] = readout.flagsByDriverName.keys();
  return onlyReportedDriverName;
}
