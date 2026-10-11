// What the window's diagnostic capture sends while a case runs, read as the lines it captured. The
// capture sends at the end of the turn a line arrives in, so a read waits one microtask turn, by
// which time every line captured before it has gone; what waited before the collection started is
// sent nowhere first.

import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";
import type { DiagnosticRecord } from "#shared/app-diagnostic/report.js";

/** The lines the capture sent since the collection started, and how to stop collecting. */
export interface SentDiagnostics {
  /** Every line captured since the collection started. */
  readonly records: () => Promise<readonly DiagnosticRecord[]>;
  readonly stop: () => void;
}

/** Collects what the window's diagnostic capture sends, in place of the bridge, until `stop`. */
export async function collectSentDiagnostics(): Promise<SentDiagnostics> {
  const stopDiscarding = windowDiagnosticCapture.sendThrough(() => Promise.resolve());
  await Promise.resolve();
  stopDiscarding();
  const sent: DiagnosticRecord[] = [];
  const stop = windowDiagnosticCapture.sendThrough((reports) => {
    for (const report of reports) {
      if (report.kind === "captured") {
        sent.push(report.record);
      }
    }
    return Promise.resolve();
  });
  return {
    records: async () => {
      await Promise.resolve();
      return [...sent];
    },
    stop,
  };
}
