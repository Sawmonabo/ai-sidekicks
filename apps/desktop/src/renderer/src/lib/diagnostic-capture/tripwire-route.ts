// The route from the tripwire registry into the diagnostic capture. It is its own module because
// `lib/tripwires/registry.ts` must not learn where reports go and `capture.ts` must not learn that
// tripwires exist. Tripwire kinds are invariant breaches the app cannot fix and its author
// cannot see, which the diagnostic band exists for, so every record is an error.

import type { Clock } from "../clock.js";
import { diagnosticStampAt, windowDiagnosticCapture } from "./capture.js";
import type { DiagnosticCapture } from "./capture.js";
import { windowTripwires } from "../tripwires/registry.js";
import type { TripwireRegistry, TripwireReport } from "../tripwires/registry.js";

/** The subsystem name every routed record carries. */
const TRIPWIRE_SOURCE = "lib/tripwires/registry";

/**
 * Route one registry's reports into one capture until the returned function is called.
 * `at` supplies the stamp so the route uses the app's clock, not `Date`.
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
