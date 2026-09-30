// The idle walk: its scheduler's feature detection, its once-per-instance and cancel rules, and
// that it re-reads the board between steps.

import { describe, expect, it } from "vitest";

import { ManualIdleWarmScheduler } from "@test/helpers/idle-warm.js";
import {
  LAZY_BODY_WARM_FALLBACK_DELAY_MS,
  LazyBodyIdleWarm,
  idleWarmScheduler,
} from "./lazy-body-warm.js";
import { type PreloadableRegistry } from "./lazy-body.js";

/** A host that records which API a scheduler chose, and with what. */
function recordingHost(options: {
  readonly withRequestIdle: boolean;
  readonly withCancelIdle: boolean;
}): {
  readonly host: Parameters<typeof idleWarmScheduler>[0];
  readonly calls: string[];
  readonly timeoutDelays: number[];
} {
  const calls: string[] = [];
  const timeoutDelays: number[] = [];
  const host = {
    ...(options.withRequestIdle
      ? {
          requestIdleCallback: (): number => {
            calls.push("requestIdleCallback");
            return 11;
          },
        }
      : {}),
    ...(options.withCancelIdle
      ? {
          cancelIdleCallback: (): void => {
            calls.push("cancelIdleCallback");
          },
        }
      : {}),
    setTimeout: (_step: () => void, delayMs: number): number => {
      calls.push("setTimeout");
      timeoutDelays.push(delayMs);
      return 22;
    },
    clearTimeout: (): void => {
      calls.push("clearTimeout");
    },
  };
  return { host, calls, timeoutDelays };
}

describe("the warm scheduler — the pair is detected together", () => {
  it("takes the host's idle callback when both halves are there", () => {
    const { host, calls } = recordingHost({ withRequestIdle: true, withCancelIdle: true });
    const scheduler = idleWarmScheduler(host);
    scheduler.cancel(scheduler.schedule(() => undefined));
    expect(calls).toStrictEqual(["requestIdleCallback", "cancelIdleCallback"]);
  });

  it("falls to the timeout floor when the cancel half is missing", () => {
    // A host with `requestIdleCallback` and no cancel must fall back to the timeout path.
    const { host, calls, timeoutDelays } = recordingHost({
      withRequestIdle: true,
      withCancelIdle: false,
    });
    const scheduler = idleWarmScheduler(host);
    scheduler.cancel(scheduler.schedule(() => undefined));
    expect(calls).toStrictEqual(["setTimeout", "clearTimeout"]);
    expect(timeoutDelays).toStrictEqual([LAZY_BODY_WARM_FALLBACK_DELAY_MS]);
  });

  it("falls to the timeout floor when the request half is missing", () => {
    const { host, calls } = recordingHost({ withRequestIdle: false, withCancelIdle: true });
    const scheduler = idleWarmScheduler(host);
    scheduler.cancel(scheduler.schedule(() => undefined));
    expect(calls).toStrictEqual(["setTimeout", "clearTimeout"]);
  });

  it("negative control: a host with neither still schedules", () => {
    // Negative control: catches a detector that always answered `setTimeout`.
    const { host, calls } = recordingHost({ withRequestIdle: false, withCancelIdle: false });
    idleWarmScheduler(host).schedule(() => undefined);
    expect(calls).toStrictEqual(["setTimeout"]);
  });
});

/** A board whose unloaded set the case controls, recording what was asked for. */
class RecordingBoard implements PreloadableRegistry<string> {
  #unloaded: string[];
  public readonly preloaded: string[] = [];
  readonly #rejectingKeys: ReadonlySet<string>;

  public readonly unloadedKeys = (): readonly string[] => this.#unloaded;

  public readonly preload = async (key: string): Promise<void> => {
    this.preloaded.push(key);
    // A real board drops the key synchronously on preload, so the fake does too.
    this.#unloaded = this.#unloaded.filter((unloadedKey) => unloadedKey !== key);
    if (this.#rejectingKeys.has(key)) {
      // A real board releases the memo when the load rejects; the fake re-adds the key.
      this.#unloaded.push(key);
      throw new Error(`chunk for ${key} could not be fetched`);
    }
  };

  public constructor(unloaded: readonly string[], rejectingKeys: readonly string[] = []) {
    this.#unloaded = [...unloaded];
    this.#rejectingKeys = new Set(rejectingKeys);
  }

  /** A feature registering late, mid-walk. */
  public addUnloaded(key: string): void {
    this.#unloaded.push(key);
  }
}

describe("the warm walk — one key per callback, once", () => {
  it("warms every unloaded key and then stops arming", () => {
    const board = new RecordingBoard(["diff", "inspector", "terminal"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff", "inspector", "terminal"]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("arms one step at a time rather than looping inside one", () => {
    // One key per callback; a loop inside one callback would hold the main thread.
    const board = new RecordingBoard(["diff", "inspector"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    expect(scheduler.pendingCount).toBe(1);
    expect(board.preloaded).toStrictEqual([]);
  });

  it("re-reads the board between steps", () => {
    // A snapshot at `start` would miss a late registration.
    const board = new RecordingBoard(["diff"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    board.addUnloaded("workflow-run");
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff", "workflow-run"]);
  });

  it("does not start twice", () => {
    // Two starts (StrictMode double mount) must not double-schedule.
    const board = new RecordingBoard(["diff", "inspector"]);
    const scheduler = new ManualIdleWarmScheduler();
    const walk = new LazyBodyIdleWarm(board, scheduler);
    walk.start();
    walk.start();
    expect(scheduler.pendingCount).toBe(1);
    expect(walk.hasStarted).toBe(true);
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff", "inspector"]);
  });

  it("negative control: a walk that was never started warms nothing", () => {
    // Negative control: the walk must not begin in its constructor.
    const board = new RecordingBoard(["diff"]);
    const scheduler = new ManualIdleWarmScheduler();
    const walk = new LazyBodyIdleWarm(board, scheduler);
    expect(walk.hasStarted).toBe(false);
    expect(scheduler.pendingCount).toBe(0);
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual([]);
  });
});

describe("the warm walk — canceling it", () => {
  it("releases the armed handle and warms nothing further", () => {
    const board = new RecordingBoard(["diff", "inspector", "terminal"]);
    const scheduler = new ManualIdleWarmScheduler();
    const walk = new LazyBodyIdleWarm(board, scheduler);
    walk.start();
    walk.cancel();
    expect(scheduler.canceledHandles).toStrictEqual([1]);
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual([]);
  });

  it("stops the walk mid-flight", () => {
    const board = new RecordingBoard(["diff", "inspector", "terminal"]);
    const scheduler = new ManualIdleWarmScheduler();
    const walk = new LazyBodyIdleWarm(board, scheduler);
    walk.start();
    scheduler.runToQuiescence(1);
    walk.cancel();
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff"]);
  });

  it("refuses to start after a cancel", () => {
    // A cleanup that ran before a queued start must not re-arm the walk.
    const board = new RecordingBoard(["diff"]);
    const scheduler = new ManualIdleWarmScheduler();
    const walk = new LazyBodyIdleWarm(board, scheduler);
    walk.cancel();
    walk.start();
    expect(walk.hasStarted).toBe(false);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("is safe to cancel before starting and twice after", () => {
    const board = new RecordingBoard(["diff"]);
    const scheduler = new ManualIdleWarmScheduler();
    const walk = new LazyBodyIdleWarm(board, scheduler);
    expect(() => {
      walk.cancel();
      walk.cancel();
    }).not.toThrow();
    // Nothing was armed, so no handle may reach the host's cancel.
    expect(scheduler.canceledHandles).toStrictEqual([]);
  });
});

describe("the warm walk — a chunk that will not load", () => {
  it("carries on to the next key and raises nothing", async () => {
    // A rejected speculative preload must not surface as an unhandled rejection.
    const board = new RecordingBoard(["diff", "inspector"], ["diff"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    expect(() => {
      scheduler.runToQuiescence();
    }).not.toThrow();
    expect(board.preloaded).toStrictEqual(["diff", "inspector"]);
    // Settle the rejection inside this case so it cannot fail the next file.
    await Promise.resolve();
  });

  it("asks for each key once and ends, when every chunk fails", async () => {
    // A released memo makes a failed key look never-asked; the attempted set stops two failing
    // keys from being refetched forever.
    const board = new RecordingBoard(["diff", "inspector"], ["diff", "inspector"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff", "inspector"]);
    expect(scheduler.pendingCount).toBe(0);
    await Promise.resolve();
  });

  it("negative control: a key still unloaded and never attempted is still warmed", async () => {
    // Negative control: one broken chunk must not leave later bodies cold.
    const board = new RecordingBoard(["diff", "inspector", "terminal"], ["diff"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff", "inspector", "terminal"]);
    await Promise.resolve();
  });
});
