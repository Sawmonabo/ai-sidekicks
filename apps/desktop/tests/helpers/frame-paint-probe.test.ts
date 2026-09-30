// The frame witness answers "is this renderer painting?", not "is it fast?".
//
// `FramePaintProbe` takes its `RendererFrameSource` as a constructor argument, so a source that
// resolves late and one that never resolves are each an object literal; a real window can only
// produce the passing case. The class under test is the real one the harness constructs.
//
// Cases run against a small injected budget, not the shipped `FRAME_PAINT_PROBE_TIMEOUT_MS`,
// which is a property of CI runners and would take 15 seconds to prove a timeout fires. The
// budget this witness sits inside is tested in `launch-deadline.test.ts`.

import { describe, expect, it } from "vitest";

import {
  FramePaintProbe,
  MEASURED_WORST_LOCAL_MS,
  type RendererFrameSource,
} from "./frame-paint-probe.js";
import { FRAME_PAINT_PROBE_TIMEOUT_MS, READINESS_BUDGET_MS } from "./launch-budgets.js";
import { deferredRejection, expectNoUnhandledRejection } from "./deferred-rejection.js";

/** A budget short enough that exhausting it costs the suite nothing. */
const TEST_BUDGET_MS = 200;

/** A renderer that delivers its frames after `afterMs`, reporting `intervalMs`. */
function frameSourceDeliveringAfter(afterMs: number, intervalMs: number): RendererFrameSource {
  return {
    awaitTwoFrames: () =>
      new Promise<number>((resolveInterval) => {
        setTimeout(() => {
          resolveInterval(intervalMs);
        }, afterMs);
      }),
  };
}

/** A throttled renderer: the callbacks are registered and never run. */
function frameSourceThatNeverDelivers(): RendererFrameSource {
  return { awaitTwoFrames: () => new Promise<number>(() => undefined) };
}

describe("frame witness — late is not the same as never", () => {
  it("passes a renderer whose first frame is late but inside the budget", async () => {
    // A window that paints late but inside the budget must pass.
    const outcome = await new FramePaintProbe(
      frameSourceDeliveringAfter(TEST_BUDGET_MS * 0.6, 97),
      TEST_BUDGET_MS,
    ).probe();
    expect(outcome.painting).toBe(true);
    // The renderer's own figure is passed through untouched, not the driver-side wall time.
    expect(outcome).toMatchObject({ painting: true, frameIntervalMs: 97 });
  });

  it("fails a renderer whose frames never arrive", async () => {
    // Background throttling left on: the callbacks are registered against a schedule that never
    // runs.
    const outcome = await new FramePaintProbe(
      frameSourceThatNeverDelivers(),
      TEST_BUDGET_MS,
    ).probe();
    expect(outcome.painting).toBe(false);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(TEST_BUDGET_MS * 0.9);
  });

  it("negative control: the same budget that passed the late case fails a slower one", async () => {
    // Guards the case above: same witness and budget, one source moved past it.
    const budget = TEST_BUDGET_MS;
    const inside = await new FramePaintProbe(
      frameSourceDeliveringAfter(budget * 0.6, 12),
      budget,
    ).probe();
    const outside = await new FramePaintProbe(
      frameSourceDeliveringAfter(budget * 3, 12),
      budget,
    ).probe();
    expect([inside.painting, outside.painting]).toStrictEqual([true, false]);
  });

  it("lets a genuine renderer failure through rather than reporting it as unpainted", async () => {
    // A closed page or crashed renderer rejects the probe. It must propagate, not read as "not
    // painting".
    const crashed: RendererFrameSource = {
      awaitTwoFrames: () =>
        Promise.reject(new Error("Target page, context or browser has been closed")),
    };
    await expect(new FramePaintProbe(crashed, TEST_BUDGET_MS).probe()).rejects.toThrow(
      /has been closed/u,
    );
  });

  it("survives an abandoned probe rejecting after the budget expired", async () => {
    // The launch path closes the application right after a failed witness, rejecting the still
    // outstanding probe. The outcome must settle and the late rejection must reach a handler.
    const abandonedProbe = deferredRejection();
    const outcome = await new FramePaintProbe(
      { awaitTwoFrames: () => abandonedProbe.promise },
      TEST_BUDGET_MS,
    ).probe();
    expect(outcome.painting).toBe(false);
    // Holds the witness to racing the probe: `Promise.race` keeps the loser handled, so an
    // abandoned probe outside a race would fail this line.
    await expectNoUnhandledRejection(() => {
      abandonedProbe.reject(new Error("Target page, context or browser has been closed"));
    });
  });
});

describe("frame witness — the verdict names the bound it applied", () => {
  it("reports the injected bound on both sides of the race", async () => {
    // Both arms carry the bound they were held to, so the failure sentence and the passing
    // breadcrumb name the injected figure, not the module constant.
    const missed = await new FramePaintProbe(
      frameSourceThatNeverDelivers(),
      TEST_BUDGET_MS,
    ).probe();
    const witnessed = await new FramePaintProbe(
      frameSourceDeliveringAfter(TEST_BUDGET_MS * 0.4, 12),
      TEST_BUDGET_MS,
    ).probe();
    expect([missed.budgetMs, witnessed.budgetMs]).toStrictEqual([TEST_BUDGET_MS, TEST_BUDGET_MS]);
    // The injected bound differs from the shipped one, so reporting the constant would fail.
    expect(TEST_BUDGET_MS).not.toBe(FRAME_PAINT_PROBE_TIMEOUT_MS);
  });

  it("negative control: a witness given no bound reports the shipped default", async () => {
    // Guards the case above against an outcome that always carries 200. The source delivers at
    // once, so taking the default costs no wall time.
    const outcome = await new FramePaintProbe(frameSourceDeliveringAfter(0, 3)).probe();
    expect(outcome.budgetMs).toBe(FRAME_PAINT_PROBE_TIMEOUT_MS);
  });
});

describe("frame witness — the shipped budget", () => {
  it("leaves the measured worst case at least two orders of magnitude of headroom", () => {
    // Holds the relationship the derivation claims: shrinking the bound toward the measured
    // figure fails here.
    expect(FRAME_PAINT_PROBE_TIMEOUT_MS).toBeGreaterThan(MEASURED_WORST_LOCAL_MS * 100);
  });

  it("stays inside half the cold-start budget it must not swallow", () => {
    // Readiness is the longer wait, so a launch whose problem is the window fails naming the
    // window instead of a renderer that would not paint.
    expect(FRAME_PAINT_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(READINESS_BUDGET_MS / 2);
  });
});
