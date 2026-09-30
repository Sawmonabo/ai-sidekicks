// The route from the tripwire registry into the diagnostic capture. It is its own module because
// `tripwires.ts` must not learn where reports go and `diagnostic-capture.ts` must not learn that
// tripwires exist. Tripwire kinds are invariant breaches the console cannot fix and its author
// cannot see, which the diagnostic band exists for, so every record is an error.

import type { Clock } from "../clock.js";
import { diagnosticStampAt, windowDiagnosticCapture } from "./diagnostic-capture.js";
import type { DiagnosticCapture } from "./diagnostic-capture.js";
import { windowTripwires } from "../tripwires.js";
import type { TripwireRegistry, TripwireReport } from "../tripwires.js";

/** The subsystem name every routed record carries. */
const TRIPWIRE_SOURCE = "console/core/tripwires";

/**
 * Route one registry's reports into one capture until the returned function is called.
 * `at` supplies the stamp so the route uses the console's clock, not `Date`.
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
 * Arm the route between this renderer process's own registry and its own capture, stamping
 * with `clock`. Callers name this rather than the two singletons, so neither is handed out.
 */
export function routeWindowTripwiresToDiagnosticCapture(clock: Clock): () => void {
  return routeTripwiresToDiagnosticCapture(windowTripwires, windowDiagnosticCapture, () =>
    diagnosticStampAt(clock),
  );
}
