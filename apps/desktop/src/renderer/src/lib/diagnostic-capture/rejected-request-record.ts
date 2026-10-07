// The one way a rejected request nothing on screen waits on reaches diagnostics: the window's
// diagnostic capture is where its failure surfaces, as an error.

import { RealClock } from "../clock.js";
import { normalizeWireRejection } from "../wire/rejection.js";
import { diagnosticStampAt, windowDiagnosticCapture } from "./capture.js";

/**
 * Record one rejected request in the window's diagnostic capture as an error. `source` names the
 * subsystem that made the request, `kind` what failed; the detail is the rejection's own sentence.
 */
export function recordRejectedRequest(source: string, kind: string, failure: unknown): void {
  windowDiagnosticCapture.record({
    at: diagnosticStampAt(new RealClock()),
    severity: "error",
    source,
    kind,
    detail: normalizeWireRejection(source, failure).detail,
  });
}
