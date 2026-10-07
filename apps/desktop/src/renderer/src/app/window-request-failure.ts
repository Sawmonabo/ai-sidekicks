// A window request main refused or never answered is recorded in the window's diagnostic capture:
// nothing on screen waits on these requests, so the capture is where the failure surfaces.

import { RealClock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { normalizeWireRejection } from "#renderer/lib/wire/rejection.js";

/** Record one error in the window's diagnostic capture for a window request that was rejected. */
export function recordWindowRequestFailure(source: string, kind: string, failure: unknown): void {
  windowDiagnosticCapture.record({
    at: diagnosticStampAt(new RealClock()),
    severity: "error",
    source,
    kind,
    detail: normalizeWireRejection(source, failure).detail,
  });
}
