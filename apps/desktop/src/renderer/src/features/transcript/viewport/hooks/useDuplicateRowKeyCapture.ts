import { useEffect, useRef } from "react";

import { type Clock } from "@renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";

/**
 * Record the rows that share an identifier with another row in this window.
 *
 * The viewport draws both, the repeat under a key of its own, and nothing on screen says
 * so: the fault is the producer's and a person has nothing to do about it. The count goes
 * to the window's diagnostic capture as one warning each time it changes, so a window
 * that stays the same records nothing further.
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
      detail: `session ${sessionId}: ${String(duplicateKeyCount)} rows share an identifier with another row in the window`,
    });
  }, [sessionId, duplicateKeyCount, clock]);
}
