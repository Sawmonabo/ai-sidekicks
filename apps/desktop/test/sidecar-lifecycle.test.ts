// Quit-drain tests: the will-quit hold, its re-entry guard, and the hard cap.
//
// Electron is replaced by an EventEmitter with a `quit` spy: the behavior under test is
// listener order plus promise timing, which needs no real Electron.

import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { registerSidecarLifecycle } from "../src/main/sidecar-lifecycle.js";

/** An Electron `App` stand-in: an EventEmitter with a `quit` spy and a `will-quit` emitter. */
function makeFakeApp(): {
  app: import("electron").App;
  quit: ReturnType<typeof vi.fn>;
  emitWillQuit: () => { defaultPrevented: boolean };
} {
  const emitter = new EventEmitter();
  const quit = vi.fn();
  const app = Object.assign(emitter, { quit }) as unknown as import("electron").App;
  return {
    app,
    quit,
    emitWillQuit: () => {
      let defaultPrevented = false;
      emitter.emit("will-quit", {
        preventDefault: () => {
          defaultPrevented = true;
        },
      });
      return { defaultPrevented };
    },
  };
}

/** A logger that records error lines instead of writing to the console. */
function makeRecordingLogger(): { logger: Pick<Console, "error">; errors: string[] } {
  const errors: string[] = [];
  return {
    logger: {
      error: (...args: unknown[]) => {
        errors.push(args.join(" "));
      },
    },
    errors,
  };
}

/** Yields so the drain's await chain and the `process.nextTick(app.quit)` tail can finish. */
async function flushAsyncQuitChain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => process.nextTick(resolve));
}

describe("registerSidecarLifecycle", () => {
  it("holds the quit, runs the drain once, and quits again", async () => {
    const { app, quit, emitWillQuit } = makeFakeApp();
    const drain = vi.fn(async () => {});

    registerSidecarLifecycle(app, drain);
    const { defaultPrevented } = emitWillQuit();

    expect(defaultPrevented).toBe(true);
    expect(drain).toHaveBeenCalledTimes(1);
    await flushAsyncQuitChain();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("logs and still quits when the drain throws", async () => {
    const { app, quit, emitWillQuit } = makeFakeApp();
    const { logger, errors } = makeRecordingLogger();
    const drain = vi.fn(async () => {
      throw new Error("synthetic drain failure");
    });

    registerSidecarLifecycle(app, drain, { logger });
    emitWillQuit();
    await flushAsyncQuitChain();

    expect(quit).toHaveBeenCalledTimes(1);
    expect(errors.some((line) => line.includes("synthetic drain failure"))).toBe(true);
  });

  it("does not drain again when will-quit fires a second time (re-entry guard)", async () => {
    const { app, quit, emitWillQuit } = makeFakeApp();
    const drain = vi.fn(async () => {});

    registerSidecarLifecycle(app, drain);
    expect(emitWillQuit().defaultPrevented).toBe(true);
    await flushAsyncQuitChain();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);

    // Electron re-fires `will-quit` once `app.quit()` is re-issued; the guard lets it through.
    expect(emitWillQuit().defaultPrevented).toBe(false);
    await flushAsyncQuitChain();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("drains again after a peer cancels the re-issued quit (one-shot guard)", async () => {
    // `app.quit` re-emits `will-quit` synchronously, as Electron does.
    const emitter = new EventEmitter();
    const emitWillQuit = (): { defaultPrevented: boolean } => {
      let defaultPrevented = false;
      emitter.emit("will-quit", {
        preventDefault: () => {
          defaultPrevented = true;
        },
      });
      return { defaultPrevented };
    };
    const quit = vi.fn(() => {
      emitWillQuit();
    });
    const app = Object.assign(emitter, { quit }) as unknown as import("electron").App;
    const drain = vi.fn(async () => {});

    registerSidecarLifecycle(app, drain);

    // A peer listener cancels only the re-issued quit (the second emit), as an
    // unsaved-work prompt would.
    let peerCalls = 0;
    emitter.on("will-quit", (event) => {
      peerCalls += 1;
      if (peerCalls === 2) {
        event.preventDefault();
      }
    });

    expect(emitWillQuit().defaultPrevented).toBe(true);
    await flushAsyncQuitChain();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);

    // The app stayed alive, so a later quit attempt must drain again: a permanent
    // latch would skip the drain here.
    expect(emitWillQuit().defaultPrevented).toBe(true);
    await flushAsyncQuitChain();
    expect(drain).toHaveBeenCalledTimes(2);
    expect(quit).toHaveBeenCalledTimes(2);
  });

  it("quits anyway when the drain never settles within the hard cap", async () => {
    vi.useFakeTimers();
    try {
      const { app, quit, emitWillQuit } = makeFakeApp();
      const { logger, errors } = makeRecordingLogger();
      const hangingDrain = vi.fn((): Promise<void> => new Promise<void>(() => {}));

      registerSidecarLifecycle(app, hangingDrain, { logger, hardCapMs: 50 });
      expect(emitWillQuit().defaultPrevented).toBe(true);

      await vi.advanceTimersByTimeAsync(60);
      await flushAsyncQuitChain();

      expect(hangingDrain).toHaveBeenCalledTimes(1);
      expect(quit).toHaveBeenCalledTimes(1);
      expect(errors.some((line) => line.includes("did not resolve within 50 ms"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
