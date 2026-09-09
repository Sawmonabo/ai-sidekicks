// The route from the tripwire registry into the diagnostic capture.
//
// Its own module and not a line in either neighbour, because it is the only thing in
// `core/` that knows about both. `tripwires.ts` publishes a sink seam and must not
// learn where reports go; `diagnostic-capture.ts` captures records from anywhere and
// must not learn that tripwires exist. Joining them inside either would make the
// other's header false.
//
// WHY THE TRIPWIRE REGISTRY IS A CAPTURE SOURCE AT ALL. Its records terminated at
// in-process subscribers: a bridge-shape drift or an apply-chokepoint bypass on an
// operator's machine was recorded, counted, and then lost with the window. Every one
// of those kinds is an invariant breach the console cannot fix and its author cannot
// see, which is exactly the class the diagnostic band exists for.
//
// SEVERITY IS A MAPPING AND NOT A CONSTANT. Five of the six kinds are console
// invariant breaches and are errors; `cleanup-refused` is the daemon answering
// honestly about something the console asked for, so it is a warning. Recording it
// at the same severity as a broken store invariant would teach an operator to
// discount both.

import type { ConsoleClock } from "../clock.js";
import { consoleDiagnosticCapture } from "./diagnostic-capture.js";
import type { DiagnosticCapture, DiagnosticSeverity } from "./diagnostic-capture.js";
import { consoleTripwires } from "../tripwires.js";
import type { TripwireKind, TripwireRegistry, TripwireReport } from "../tripwires.js";

/** The subsystem name every routed record carries. */
const TRIPWIRE_SOURCE = "console/core/tripwires";

/**
 * How bad each tripwire kind is once it reaches the band.
 *
 * Total over `TripwireKind` by construction — a seventh kind added to that tuple is
 * a compile error here, which is what keeps a new tripwire from arriving at the band
 * under whatever severity a default would have picked.
 */
const SEVERITY_BY_TRIPWIRE_KIND: Readonly<Record<TripwireKind, DiagnosticSeverity>> = {
  "bridge-shape-drift": "error",
  "persistence-value-class": "error",
  "apply-chokepoint-bypass": "error",
  "wire-figure-formatting": "error",
  "surface-render-failure": "error",
  "cleanup-refused": "warning",
};

/**
 * Route one registry's reports into one capture until the returned function is
 * called.
 *
 * `at` is supplied rather than read here so the route carries the caller's clock —
 * the console has one clock seam and a module that reached for `Date` would be a
 * second one, unreadable to a test that freezes the first.
 */
export function routeTripwiresToDiagnosticCapture(
  registry: TripwireRegistry,
  capture: DiagnosticCapture,
  at: () => string,
): () => void {
  return registry.subscribeToReports((report: TripwireReport) => {
    capture.record({
      at: at(),
      severity: SEVERITY_BY_TRIPWIRE_KIND[report.kind],
      source: TRIPWIRE_SOURCE,
      kind: report.kind,
      detail: `${report.site}: ${report.detail}`,
    });
  });
}

/**
 * Arm the route between this renderer process's own registry and its own capture.
 *
 * The composition site names THIS rather than the two singletons, and that is what
 * keeps them where they are: `consoleTripwires` is deliberately held off the `core/`
 * door because its installer is its own module, and publishing the capture beside it
 * would hand every family above a second way to record. One function crossing the
 * door arms both and publishes neither.
 *
 * Takes the clock the console runs on rather than reaching for `Date`, so a window
 * driven by a frozen clock stamps its records at the instant the rest of the window
 * agrees it is.
 */
export function routeConsoleTripwiresToDiagnosticCapture(clock: ConsoleClock): () => void {
  return routeTripwiresToDiagnosticCapture(consoleTripwires, consoleDiagnosticCapture, () =>
    new Date(clock.now()).toISOString(),
  );
}
