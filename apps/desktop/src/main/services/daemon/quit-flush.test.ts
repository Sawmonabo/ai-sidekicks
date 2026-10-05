// A quit held for the background service's flush: it goes ahead at once when the flush answers and
// at 10 seconds when it never does, a failed flush is recorded and the app still quits, and the
// quit asked for again passes through once while a quit a peer cancels flushes again.

import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { MainDiagnosticLog } from "../diagnostic-log.js";

import { SERVICE_FLUSH_WAIT_MS } from "./daemon-supervisor.js";
import { installQuitFlush } from "./quit-flush.js";

/** An Electron `App` stand-in: `quit` re-emits `before-quit` at once, as Electron does. */
function quittingApp(): {
  readonly app: Parameters<typeof installQuitFlush>[0];
  readonly emitter: EventEmitter;
  readonly quit: ReturnType<typeof vi.fn>;
  readonly emitBeforeQuit: () => boolean;
} {
  const emitter = new EventEmitter();
  const emitBeforeQuit = (): boolean => {
    let isPrevented = false;
    emitter.emit("before-quit", {
      preventDefault: () => {
        isPrevented = true;
      },
    });
    return isPrevented;
  };
  const quit = vi.fn(() => {
    emitBeforeQuit();
  });
  const app = Object.assign(emitter, { quit }) as unknown as Parameters<typeof installQuitFlush>[0];
  return { app, emitter, quit, emitBeforeQuit };
}

let log: { write: Mock<MainDiagnosticLog["write"]> };

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  log = { write: vi.fn<MainDiagnosticLog["write"]>() };
});

afterEach(() => {
  vi.useRealTimers();
});

function install(app: Parameters<typeof installQuitFlush>[0], flush: () => Promise<void>): void {
  installQuitFlush(app, flush, { log, now: () => new Date() });
}

describe("a quit held for the service's flush", () => {
  it("quits at once when the flush answers, and lets the quit it asks for through", async () => {
    const { app, quit, emitBeforeQuit } = quittingApp();
    const flush = vi.fn(() => Promise.resolve());
    install(app, flush);

    expect(emitBeforeQuit()).toBe(true);
    expect(flush).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);

    expect(quit).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(log.write).not.toHaveBeenCalled();
  });

  it("quits at 10 seconds when the flush never answers, and records it", async () => {
    const { app, quit, emitBeforeQuit } = quittingApp();
    install(app, () => new Promise<void>(() => undefined));

    expect(emitBeforeQuit()).toBe(true);
    await vi.advanceTimersByTimeAsync(SERVICE_FLUSH_WAIT_MS - 1);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(SERVICE_FLUSH_WAIT_MS).toBe(10_000);
    expect(quit).toHaveBeenCalledOnce();
    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message:
          "The background service's flush did not answer within 10 seconds; the app quit without it.",
      }),
    );
  });

  it("records a failed flush and still quits", async () => {
    const { app, quit, emitBeforeQuit } = quittingApp();
    install(app, () => Promise.reject(new Error("the link closed")));

    emitBeforeQuit();
    await vi.advanceTimersByTimeAsync(0);

    expect(quit).toHaveBeenCalledOnce();
    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "The background service's flush failed at quit: the link closed",
      }),
    );
  });

  it("flushes again when a peer cancels the quit it asked for", async () => {
    const { app, emitter, quit, emitBeforeQuit } = quittingApp();
    const flush = vi.fn(() => Promise.resolve());
    install(app, flush);
    // A peer cancels only the quit asked for again, as an unsaved-work prompt would.
    let peerCalls = 0;
    emitter.on("before-quit", (event: { preventDefault: () => void }) => {
      peerCalls += 1;
      if (peerCalls === 2) {
        event.preventDefault();
      }
    });

    emitBeforeQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(emitBeforeQuit()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(flush).toHaveBeenCalledTimes(2);
    expect(quit).toHaveBeenCalledTimes(2);
  });
});
