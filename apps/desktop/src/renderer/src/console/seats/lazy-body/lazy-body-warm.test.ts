// The idle walk: what it schedules on, when it stops, and what it re-reads.
//
// Both halves are driven here because both are seams a browser would hide. The
// scheduler's feature detection decides whether a walk can be CANCELLED at all, and a
// host that answered `requestIdleCallback` without its cancel would leave a background
// walk running past the window that started it — a leak that shows up as nothing at all
// until an auxiliary window closes. And the walk's own rules — once per instance,
// cancellable at any point, re-read between steps — are the difference between a warm
// board and a loop that re-requests a chunk it already has.

import { describe, expect, it } from "vitest";

import { ManualIdleWarmScheduler } from "./idle-warm.test-support.js";
import {
  LAZY_BODY_WARM_FALLBACK_DELAY_MS,
  LazyBodyIdleWarm,
  idleWarmScheduler,
} from "./lazy-body-warm.js";
import { type LazyBodyBoard } from "./lazy-body.js";

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
    // The arm that matters: a host with `requestIdleCallback` and no cancel would
    // schedule through the idle API and have nothing to stop it with, so the pair is
    // detected together and both branches take `schedule` and `cancel` from one API.
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
    // Without this the two cases above would pass over a detector that answered
    // `setTimeout` unconditionally and never read the idle API at all.
    const { host, calls } = recordingHost({ withRequestIdle: false, withCancelIdle: false });
    idleWarmScheduler(host).schedule(() => undefined);
    expect(calls).toStrictEqual(["setTimeout"]);
  });
});

/** A board whose unloaded set the case controls, recording what was asked for. */
class RecordingBoard implements LazyBodyBoard<string> {
  #unloaded: string[];
  public readonly preloaded: string[] = [];
  readonly #rejectingKeys: ReadonlySet<string>;

  public constructor(unloaded: readonly string[], rejectingKeys: readonly string[] = []) {
    this.#unloaded = [...unloaded];
    this.#rejectingKeys = new Set(rejectingKeys);
  }

  public readonly unloadedKeys = (): readonly string[] => this.#unloaded;

  public readonly preload = async (key: string): Promise<void> => {
    this.preloaded.push(key);
    // A real board's memo is written synchronously by `preload`, which is what stops the
    // next step re-selecting this key — so the fake drops it synchronously too.
    this.#unloaded = this.#unloaded.filter((unloadedKey) => unloadedKey !== key);
    if (this.#rejectingKeys.has(key)) {
      // AND A REAL BOARD RELEASES THAT MEMO WHEN THE LOAD REJECTS, so the key is offered
      // back to `unloadedKeys` — which is exactly the state the walk has to bound and
      // the reason this fake re-adds it rather than leaving it dropped.
      this.#unloaded.push(key);
      throw new Error(`chunk for ${key} could not be fetched`);
    }
  };

  /** A family registering late, mid-walk. */
  public addUnloaded(key: string): void {
    this.#unloaded.push(key);
  }
}

describe("the warm walk — one key per callback, once", () => {
  it("warms every unloaded key and then stops arming", () => {
    const board = new RecordingBoard(["diff", "artifact", "runs"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff", "artifact", "runs"]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("arms one step at a time rather than looping inside one", () => {
    // The whole reason the walk re-arms: a loop inside one idle callback would hold the
    // main thread through a frame the person is looking at, which is what an idle
    // callback exists to avoid.
    const board = new RecordingBoard(["diff", "artifact"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    expect(scheduler.pendingCount).toBe(1);
    expect(board.preloaded).toStrictEqual([]);
  });

  it("re-reads the board between steps", () => {
    // A snapshot taken at `start` would miss a family that registered late and would go
    // on requesting a body someone opened mid-walk.
    const board = new RecordingBoard(["diff"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    board.addUnloaded("workflow-run");
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff", "workflow-run"]);
  });

  it("does not start twice", () => {
    // Two starts on one instance — a frame that mounts twice under StrictMode — must not
    // double-schedule, or every body is fetched by two walks racing each other.
    const board = new RecordingBoard(["diff", "artifact"]);
    const scheduler = new ManualIdleWarmScheduler();
    const walk = new LazyBodyIdleWarm(board, scheduler);
    walk.start();
    walk.start();
    expect(scheduler.pendingCount).toBe(1);
    expect(walk.hasStarted).toBe(true);
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff", "artifact"]);
  });

  it("negative control: a walk that was never started warms nothing", () => {
    // Without this, every case above would pass over a walk that began in its own
    // constructor — and an effect's cleanup could then never stop one.
    const board = new RecordingBoard(["diff"]);
    const scheduler = new ManualIdleWarmScheduler();
    const walk = new LazyBodyIdleWarm(board, scheduler);
    expect(walk.hasStarted).toBe(false);
    expect(scheduler.pendingCount).toBe(0);
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual([]);
  });
});

describe("the warm walk — cancelling it", () => {
  it("releases the armed handle and warms nothing further", () => {
    const board = new RecordingBoard(["diff", "artifact", "runs"]);
    const scheduler = new ManualIdleWarmScheduler();
    const walk = new LazyBodyIdleWarm(board, scheduler);
    walk.start();
    walk.cancel();
    expect(scheduler.cancelledHandles).toStrictEqual([1]);
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual([]);
  });

  it("stops the walk mid-flight", () => {
    const board = new RecordingBoard(["diff", "artifact", "runs"]);
    const scheduler = new ManualIdleWarmScheduler();
    const walk = new LazyBodyIdleWarm(board, scheduler);
    walk.start();
    scheduler.runToQuiescence(1);
    walk.cancel();
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff"]);
  });

  it("refuses to start after a cancel", () => {
    // An effect whose cleanup ran before a queued start would otherwise re-arm a walk
    // for a window that is already gone.
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
    // Nothing was armed, so nothing was cancelled — a `cancel` that passed `undefined`
    // to the host's API would show up here as a recorded handle.
    expect(scheduler.cancelledHandles).toStrictEqual([]);
  });
});

describe("the warm walk — a chunk that will not load", () => {
  it("carries on to the next key and raises nothing", async () => {
    // The walk is speculative: nobody asked for this pane, so the honest place for the
    // failure is the mount, where the surface error boundary can say so. An unhandled
    // rejection here would surface as a crash report for a pane nobody opened.
    const board = new RecordingBoard(["diff", "artifact"], ["diff"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    expect(() => {
      scheduler.runToQuiescence();
    }).not.toThrow();
    expect(board.preloaded).toStrictEqual(["diff", "artifact"]);
    // Let the rejected promise settle inside the case, so an unswallowed rejection is
    // this case's failure rather than the next file's.
    await Promise.resolve();
  });

  it("asks for each key once and ends, when every chunk fails", async () => {
    // THE SPIN THE ATTEMPTED SET EXISTS TO STOP. A released memo makes a failed key
    // indistinguishable from one never asked for, so a walk selecting on the board alone
    // alternates between two such keys forever — one background refetch per idle
    // callback, for surfaces nobody has opened, on exactly the damaged install that can
    // least afford it. The retry a failed chunk gets is the one a person asks for.
    const board = new RecordingBoard(["diff", "artifact"], ["diff", "artifact"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff", "artifact"]);
    expect(scheduler.pendingCount).toBe(0);
    await Promise.resolve();
  });

  it("negative control: a key still unloaded and never attempted is still warmed", async () => {
    // Without this, the case above would pass over a walk that stopped at its first
    // failure — and one broken chunk would leave every later body cold.
    const board = new RecordingBoard(["diff", "artifact", "runs"], ["diff"]);
    const scheduler = new ManualIdleWarmScheduler();
    new LazyBodyIdleWarm(board, scheduler).start();
    scheduler.runToQuiescence();
    expect(board.preloaded).toStrictEqual(["diff", "artifact", "runs"]);
    await Promise.resolve();
  });
});
