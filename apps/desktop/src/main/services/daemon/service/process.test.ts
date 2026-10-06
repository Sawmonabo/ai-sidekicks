// Ending a service main found running, on a fake clock with the system's signals recorded. After a
// stop it asked for: one that exits inside the drain bound gets no signal, one still running after
// it gets SIGTERM and SIGKILL 2 seconds later, both counted from when the stop was sent. A hung one
// gets SIGTERM at once, and SIGKILL only if it still runs once the drain bound and 2 seconds have
// passed. An id that no longer reads as the service is never signaled and counts as exited, a
// second ending joins the first, and a failed look fails the ending.

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DAEMON_STOP_DRAIN_BOUND_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

import { attachToServiceProcess } from "./process.js";

const SERVICE: ProcessIdentity = {
  processId: 3000,
  bootId: "boot-1",
  processStartTime: "Mon Oct  5 08:00:00 2026",
};

/** The signals sent to the service's id, the existence look (signal 0) left out. */
let sentSignals: Array<{ at: number; signal: string }>;
/** Whether the service's process still runs. */
let isServiceRunning: boolean;

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  sentSignals = [];
  isServiceRunning = true;
  vi.spyOn(process, "kill").mockImplementation((processId, signal) => {
    if (processId !== SERVICE.processId) {
      throw new Error(`signaled process ${String(processId)}`);
    }
    // Every signal main sends counts, even one that finds the process gone.
    if (signal !== 0) {
      sentSignals.push({ at: performance.now(), signal: String(signal) });
    }
    if (!isServiceRunning) {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The system's reading of the service's id: the service while it runs, then no process. */
function readService(): Promise<ProcessIdentity | undefined> {
  return Promise.resolve(isServiceRunning ? SERVICE : undefined);
}

it("sends no signal to a service that exits inside the drain bound", async () => {
  const service = attachToServiceProcess(SERVICE, readService);

  void service.end({ cause: "stopAsked", askedAt: 0 });
  await vi.advanceTimersByTimeAsync(DAEMON_STOP_DRAIN_BOUND_MS - 1);
  isServiceRunning = false;
  await vi.advanceTimersByTimeAsync(60_000);

  expect(sentSignals).toStrictEqual([]);
  expect(service.hasExited()).toBe(true);
});

it("counts the drain bound from the stop's send: SIGTERM once it passes, SIGKILL 2 seconds later", async () => {
  const service = attachToServiceProcess(SERVICE, readService);
  const askedAt = performance.now();
  // The answer took a second to arrive; the bound still runs from the send.
  await vi.advanceTimersByTimeAsync(1_000);

  const ending = service.end({ cause: "stopAsked", askedAt });
  await vi.advanceTimersByTimeAsync(DAEMON_STOP_DRAIN_BOUND_MS - 1_001);
  expect(sentSignals).toStrictEqual([]);
  await vi.advanceTimersByTimeAsync(60_000);
  await ending;

  expect(sentSignals).toStrictEqual([
    { at: DAEMON_STOP_DRAIN_BOUND_MS, signal: "SIGTERM" },
    { at: DAEMON_STOP_DRAIN_BOUND_MS + 2_000, signal: "SIGKILL" },
  ]);
});

it("sends a hung service SIGTERM at once, and no SIGKILL when it exits 5 seconds later", async () => {
  const service = attachToServiceProcess(SERVICE, readService);

  void service.end({ cause: "unanswered" });
  await vi.advanceTimersByTimeAsync(5_000);
  isServiceRunning = false;
  await vi.advanceTimersByTimeAsync(60_000);

  expect(sentSignals).toStrictEqual([{ at: 0, signal: "SIGTERM" }]);
});

it("sends a hung service that never exits SIGKILL the drain bound and 2 seconds after SIGTERM, once", async () => {
  const service = attachToServiceProcess(SERVICE, readService);

  const ending = service.end({ cause: "unanswered" });
  // A second ending, as a stop that follows silence would ask, joins the first.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(service.end({ cause: "stopAsked", askedAt: performance.now() })).toBe(ending);
  await vi.advanceTimersByTimeAsync(60_000);

  expect(sentSignals).toStrictEqual([
    { at: 0, signal: "SIGTERM" },
    { at: DAEMON_STOP_DRAIN_BOUND_MS + 2_000, signal: "SIGKILL" },
  ]);
});

it.each([
  ["another process took its id", { ...SERVICE, processStartTime: "Mon Oct  5 09:00:00 2026" }],
  ["the machine restarted since", { ...SERVICE, bootId: "boot-2" }],
])("never signals an id when %s, and counts the service exited", async (_case, reading) => {
  const service = attachToServiceProcess(SERVICE, () => Promise.resolve(reading));

  void service.end({ cause: "unanswered" });
  await vi.advanceTimersByTimeAsync(0);
  await expect(service.whenExited()).resolves.toStrictEqual({ code: null, signal: null });

  expect(sentSignals).toStrictEqual([]);
  expect(service.hasExited()).toBe(true);
});

it("fails the ending, unsignaled, when the system's reading fails", async () => {
  const service = attachToServiceProcess(SERVICE, () =>
    Promise.reject(new Error("ps could not run")),
  );

  const ending = service.end({ cause: "unanswered" });

  await expect(ending).rejects.toThrow("ps could not run");
  expect(sentSignals).toStrictEqual([]);
});
