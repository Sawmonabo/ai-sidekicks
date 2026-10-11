// A window's diagnostic capture: a repeated line goes three times a minute and the rest as one
// count; what arrives before the bridge waits under its bound and the rest go as one count, in
// batches main takes; a batch main refuses is sent once and never captured again, so a refusal
// cannot loop.

import { afterEach, describe, expect, it, vi } from "vitest";

import { APP_DIAGNOSTIC_RATE_BOUNDS } from "#shared/app-diagnostic/rate-limit.js";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Every batch handed to main so far, in order. */
function batchesSentThrough(capture: DiagnosticCapture): (readonly WindowDiagnosticReport[])[] {
  const batches: (readonly WindowDiagnosticReport[])[] = [];
  capture.sendThrough((batch) => {
    batches.push(batch);
    return Promise.resolve();
  });
  return batches;
}

describe("the window's diagnostic capture", () => {
  it("sends a repeat three times a minute and the rest as one count", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const capture = new DiagnosticCapture();
    const batches = batchesSentThrough(capture);

    for (let time = 0; time < 5; time++) {
      capture.record(line(0));
    }
    await Promise.resolve();
    expect(batches.flat()).toHaveLength(APP_DIAGNOSTIC_RATE_BOUNDS.perRecord);

    vi.advanceTimersByTime(APP_DIAGNOSTIC_RATE_BOUNDS.windowMs);
    await Promise.resolve();
    expect(batches.flat().slice(APP_DIAGNOSTIC_RATE_BOUNDS.perRecord)).toStrictEqual([
      { kind: "held-back", cause: "past-rate", count: 2 },
    ]);
  });

  it("holds what came before the bridge under its bound and sends the rest as a count", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const capture = new DiagnosticCapture();
    for (let index = 0; index < WINDOW_DIAGNOSTICS_HELD + 3; index++) {
      capture.record(line(index));
    }

    const batches = batchesSentThrough(capture);
    await Promise.resolve();

    expect(batches.every((batch) => batch.length <= WINDOW_DIAGNOSTIC_BATCH_BOUND)).toBe(true);
    // The count of what did not fit goes within the rate, ahead of the lines it follows.
    const sentLineCount = batches.flat().filter((report) => report.kind === "captured").length;
    expect(sentLineCount).toBe(APP_DIAGNOSTIC_RATE_BOUNDS.all - 1);
    expect(batches.flat().at(-1)).toStrictEqual({
      kind: "held-back",
      cause: "window-buffer-full",
      count: 3,
    });

    // Every line that waited is told: sent, or counted past the rate once the minute ends.
    vi.advanceTimersByTime(APP_DIAGNOSTIC_RATE_BOUNDS.windowMs);
    await Promise.resolve();
    expect(batches.flat().at(-1)).toStrictEqual({
      kind: "held-back",
      cause: "past-rate",
      count: WINDOW_DIAGNOSTICS_HELD - sentLineCount,
    });
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
