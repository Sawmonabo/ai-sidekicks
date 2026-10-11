// A window's diagnostic capture: what arrives before the bridge waits under its bound and the rest
// go as one count, in batches main takes; a batch main refuses is sent once and never captured
// again, so a refusal cannot loop.

import { afterEach, describe, expect, it, vi } from "vitest";

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import {
  WINDOW_DIAGNOSTIC_BATCH_BOUND,
  type WindowDiagnosticReport,
} from "#shared/app-diagnostic/report.js";

import { DiagnosticCapture, WINDOW_DIAGNOSTICS_HELD } from "./capture.js";

function line(index: number): Parameters<DiagnosticCapture["record"]>[0] {
  return {
    at: "2026-10-11T16:00:00.000Z",
    severity: "warning",
    source: "lib/diagnostic-capture",
    kind: "read-failed",
    detail: `read ${String(index)} failed`,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the window's diagnostic capture", () => {
  it("holds what came before the bridge under its bound and sends the rest as a count", async () => {
    const capture = new DiagnosticCapture();
    for (let index = 0; index < WINDOW_DIAGNOSTICS_HELD + 3; index++) {
      capture.record(line(index));
    }
    const batches: (readonly WindowDiagnosticReport[])[] = [];

    capture.sendThrough((batch) => {
      batches.push(batch);
      return Promise.resolve();
    });
    await Promise.resolve();

    expect(batches.every((batch) => batch.length <= WINDOW_DIAGNOSTIC_BATCH_BOUND)).toBe(true);
    const sent = batches.flat();
    expect(sent.filter((report) => report.kind === "captured")).toHaveLength(
      WINDOW_DIAGNOSTICS_HELD,
    );
    expect(sent.at(-1)).toStrictEqual({ kind: "held-back", count: 3 });
  });

  it("sends a batch main refuses once and never captures it again", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const capture = new DiagnosticCapture();
    const send = vi.fn(() => Promise.reject(new Error("main refused the batch")));
    capture.sendThrough(send);

    capture.record(line(0));
    await crossMacrotaskBoundary();

    expect(send).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
