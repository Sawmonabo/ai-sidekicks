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
// EVERY RECORD IS AN ERROR. Every tripwire kind is a console invariant breach, so none
// reaches the band at a lower severity.

import type { ConsoleClock } from "../clock.js";
import { consoleDiagnosticCapture } from "./diagnostic-capture.js";
import type { DiagnosticCapture } from "./diagnostic-capture.js";
import { consoleTripwires } from "../tripwires.js";
import type { TripwireRegistry, TripwireReport } from "../tripwires.js";

/** The subsystem name every routed record carries. */
const TRIPWIRE_SOURCE = "console/core/tripwires";

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
      severity: "error",
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
