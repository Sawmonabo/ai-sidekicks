// The pure readers over one capability readout: which driver a run is bound to, and
// what this build knows about one flag on it.
//
// NONE OF THEM PERFORMS A READ, which is the whole reason they are not in
// `driver-capability-read.ts` beside the wire. That module owns one call per bridge,
// the scheduler that refreshes it, the cache that shares it, and the two hooks that
// wire its triggers — a subject whose cases need a bridge, a frozen clock, and a
// mounted probe. These need a `Map`. `driver-capability-readings.test.ts` had already
// been split off for exactly that reason and was driving symbols that still lived
// next door; this is the other half of that split.
//
// THE READOUT IS THE PARAMETER AND NEVER A DEPENDENCY. Every function here takes the
// readout it answers about, so the direction of the import is one-way — the wire does
// not reach for these, and a surface holding a readout resolves against them without
// touching the read at all. `undefined` is admitted on every entry point because the
// read may not have answered yet, and that absence is one of the three facts the
// reading vocabulary below exists to keep apart.

import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { DeclaredDriverFlags, DriverCapabilityReadout } from "./driver-capability-read.js";

/**
 * The node's declarations, joined to one session's run-to-driver bindings.
 *
 * The two halves are read separately because they are answered separately — the
 * declarations by a node-scoped call shared across every session in the window, the
 * bindings by one session's own projection — and they are joined HERE, at the
 * consumer, rather than inside the per-bridge cache, which holds no session and must
 * not start holding one.
 *
 * The readout is returned untouched where there is nothing to join, so a surface
 * that asked and got no bindings compares the same pointer it had.
 */
export function withRunDriverBindings(
  readout: DriverCapabilityReadout | undefined,
  driverNameByRunId: ReadonlyMap<string, string>,
): DriverCapabilityReadout | undefined {
  if (readout === undefined || driverNameByRunId.size === 0) {
    return readout;
  }
  return { ...readout, driverNameByRunId };
}

/**
 * One named driver's declared flags, or `undefined` where the console cannot say.
 *
 * `undefined` covers three genuinely identical situations — the read has not
 * answered, the caller could not name the driver, and the reply named no such driver
 * — because in all three nobody has answered the question for THIS binding.
 */
export function declaredFlagsForDriver(
  readout: DriverCapabilityReadout | undefined,
  driverName: string | undefined,
): DeclaredDriverFlags | undefined {
  if (readout === undefined || driverName === undefined) {
    return undefined;
  }
  return readout.flagsByDriverName.get(driverName);
}

/**
 * What this build knows about one driver flag. Declared once, for every consumer.
 *
 * Three answers and they are three different facts: `declared` — that driver
 * declared it; `undeclared` — that driver declared it absent; `unknown` — nobody
 * has answered the question, because the read has not landed, the run's binding is
 * not nameable, or the named driver filed no report. The third is what a boolean
 * cannot carry, and the reason this is a set rather than a flag: a surface that
 * collapsed `unknown` onto `undeclared` would show a session whose read has not
 * landed exactly as it shows one bound to a driver that cannot do the thing.
 */
export const DRIVER_CAPABILITY_READINGS = ["declared", "undeclared", "unknown"] as const;

/** One reading of one driver flag. Derived from the enumeration above. */
export type DriverCapabilityReading = (typeof DRIVER_CAPABILITY_READINGS)[number];

/**
 * Which driver a run is bound to, or `undefined` where the console cannot say.
 *
 * Two sources in priority order and no third: the binding the session's own
 * projection named for this run, then the sole-report fallback — where exactly one
 * driver filed a report, that report is this run's whatever the projection has said,
 * because there is nothing else it could be bound to. Guessing between two reported
 * drivers is deliberately not one of them: a wrong guess offers a control the daemon
 * will always refuse, or hides one it would have honoured.
 */
export function boundDriverNameForRun(
  readout: DriverCapabilityReadout | undefined,
  runId: string,
): string | undefined {
  if (readout === undefined) {
    return undefined;
  }
  return readout.driverNameByRunId.get(runId) ?? soleReportedDriverName(readout);
}

/**
 * The one driver this node reported, where it reported exactly one.
 *
 * The fallback both entry points below share. A node with one driver installed names
 * a binding for no run — `driver.listCapabilities` is addressed at the node and names
 * no run at all — and refusing to answer there would take every capability-gated
 * control off every run on the most ordinary installation there is. With two drivers
 * reported it answers nothing, because then the question really is unanswered.
 */
function soleReportedDriverName(readout: DriverCapabilityReadout): string | undefined {
  if (readout.flagsByDriverName.size !== 1) {
    return undefined;
  }
  const [onlyReportedDriverName] = readout.flagsByDriverName.keys();
  return onlyReportedDriverName;
}

/**
 * What this build knows about one flag on the driver ONE RUN is bound to.
 *
 * The console's single answer to that question. It used to be three: a
 * `boolean | undefined` in the runs pane, a three-value union in the composer, and a
 * `"declared" | "undeclared" | undefined` in the approvals pane — and the first two
 * disagreed about the same run, because only the pane resolved the binding through
 * the sole-report fallback while the rail was handed a driver name the session
 * projection had not supplied. One readout, one run, one moment, two answers, and
 * nothing derived from the other to report the split.
 */
export function readingForDriver(
  readout: DriverCapabilityReadout | undefined,
  driverName: string | undefined,
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
 * The same question asked of a RUN rather than of a named driver.
 *
 * For a surface that holds a run and not a binding — the runs pane, which seats rows
 * it has only run ids for. A surface that already resolved the driver its agent is
 * attached to asks `readingForDriver` with the name it has: throwing that away and
 * re-deriving it from a map the readout may not carry is how the rail came to report
 * `unknown` for a run whose driver the session had named.
 */
export function readingForRun(
  readout: DriverCapabilityReadout | undefined,
  runId: string,
  flag: DriverCapabilityFlag,
): DriverCapabilityReading {
  return readingForDriver(readout, boundDriverNameForRun(readout, runId), flag);
}
