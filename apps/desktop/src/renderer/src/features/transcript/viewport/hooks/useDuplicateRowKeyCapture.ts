import { useEffect, useRef } from "react";

import { type Clock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";

/**
 * Record the rows that share an identifier with another row in this window.
 * The viewport draws both under distinct keys and the fault is the producer's, so the count
 * goes to the diagnostic capture as one warning per change.
 */
export function useDuplicateRowKeyCapture(
  sessionId: string,
  duplicateKeyCount: number,
  clock: Clock,
): void {
  const recordedCount = useRef(0);
  useEffect(() => {
    if (duplicateKeyCount === recordedCount.current) {
      return;
    }
    recordedCount.current = duplicateKeyCount;
    if (duplicateKeyCount === 0) {
      return;
    }
    windowDiagnosticCapture.record({
      at: diagnosticStampAt(clock),
      severity: "warning",
      source: "features/transcript",
      kind: "duplicate-row-key",
      detail:
        `session ${sessionId}: ${String(duplicateKeyCount)} rows share ` +
        "an identifier with another row in the window",
    });
  }, [sessionId, duplicateKeyCount, clock]);
}
