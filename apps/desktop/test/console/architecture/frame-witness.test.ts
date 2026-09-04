// The frame witness answers "is this renderer painting?" and not "is it fast?".
//
// Every Electron tier goes through `launchConsole`, and until this file existed
// the witness inside it had no test at all: the only way to exercise it was to
// launch a real window, which can only produce the PASSING case — no fixture can
// make a real Chromium stop painting on demand, and none can make it paint late
// on demand either. So the one behaviour that matters, the boundary between late
// and never, was the one behaviour nothing checked, and it was wrong: the bound
// was a fixed 2 000 ms from window creation, which two CI runs
// (33914273796 endurance, 33914986509 e2e) crossed on windows that were painting
// perfectly well.
//
// The seam is what makes this testable without an Electron process:
// `FrameWitness` takes its `RendererFrameSource` as a constructor argument, so a
// source that resolves late and a source that never resolves are each one object
// literal. The class under test is the REAL one the harness constructs — a local
// re-implementation of the race would pass while the shipped witness stayed
// broken.
//
// Every case runs against a small injected budget rather than the shipped
// `FRAME_WITNESS_TIMEOUT_MS`, and that is deliberate on two counts: the shipped
// value is a property of CI runners rather than of the race, and a suite that
// spent it would take 15 seconds to prove a timeout fires.
//
// The budget this witness sits INSIDE is a different subject with a different
// failure mode, and it is `launch-deadline.test.ts`. The two were one file until
// that file passed 400 lines carrying three subjects at once.

import { describe, expect, it } from "vitest";

import {
  FRAME_WITNESS_TIMEOUT_MS,
  FrameWitness,
  MEASURED_WORST_LOCAL_MS,
  type RendererFrameSource,
} from "../frame-witness.js";
import { READINESS_BUDGET_MS } from "../launch-deadline.js";

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
    // The case both CI failures were: a window that painted, just not within the
    // window the old fused race allowed it.
    const outcome = await new FrameWitness(
      frameSourceDeliveringAfter(TEST_BUDGET_MS * 0.6, 97),
      TEST_BUDGET_MS,
    ).witness();
    expect(outcome.painting).toBe(true);
    // The reported interval is the RENDERER's figure, passed through untouched —
    // not the driver-side wall time, which is the other half of the diagnosis.
    expect(outcome).toMatchObject({ painting: true, frameIntervalMs: 97 });
  });

  it("fails a renderer whose frames never arrive", async () => {
    // The condition the witness exists for: background throttling left on, so
    // the callbacks are registered against a schedule that never runs.
    const outcome = await new FrameWitness(
      frameSourceThatNeverDelivers(),
      TEST_BUDGET_MS,
    ).witness();
    expect(outcome.painting).toBe(false);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(TEST_BUDGET_MS * 0.9);
  });

  it("negative control: the same budget that passed the late case fails a slower one", async () => {
    // Without this the case above is ambiguous between "the budget admitted a
    // late frame" and "the witness admits everything". Same witness, same
    // budget, one source moved past it.
    const budget = TEST_BUDGET_MS;
    const inside = await new FrameWitness(
      frameSourceDeliveringAfter(budget * 0.6, 12),
      budget,
    ).witness();
    const outside = await new FrameWitness(
      frameSourceDeliveringAfter(budget * 3, 12),
      budget,
    ).witness();
    expect([inside.painting, outside.painting]).toStrictEqual([true, false]);
  });

  it("lets a genuine renderer failure through rather than reporting it as unpainted", async () => {
    // A closed page or a crashed renderer rejects the probe. Reporting that as
    // "not painting" would send a reader to `window-reveal.ts` for a crash, so
    // the rejection propagates and the caller reports what actually happened.
    const crashed: RendererFrameSource = {
      awaitTwoFrames: () =>
        Promise.reject(new Error("Target page, context or browser has been closed")),
    };
    await expect(new FrameWitness(crashed, TEST_BUDGET_MS).witness()).rejects.toThrow(
      /has been closed/u,
    );
  });

  it("survives an abandoned probe rejecting after the budget expired", async () => {
    // The launch path closes the application right after a failed witness, which
    // rejects the probe that is still outstanding. Unhandled, that rejection
    // fails the whole tier on something other than the witness's own verdict —
    // so the outcome must settle AND the late rejection must reach a handler.
    let rejectAbandonedProbe: (reason: Error) => void = () => undefined;
    const abandoned: RendererFrameSource = {
      awaitTwoFrames: () =>
        new Promise<number>((_resolveInterval, reject) => {
          rejectAbandonedProbe = reject;
        }),
    };
    const outcome = await new FrameWitness(abandoned, TEST_BUDGET_MS).witness();
    expect(outcome.painting).toBe(false);
    rejectAbandonedProbe(new Error("Target page, context or browser has been closed"));
    // Give the rejection a turn to surface. If the witness had left it
    // unhandled, this is where the process would report it.
    await new Promise((resolveTick) => {
      setTimeout(resolveTick, 10);
    });
  });
});

describe("frame witness — the shipped budget", () => {
  it("leaves the measured worst case at least two orders of magnitude of headroom", () => {
    // Not a re-statement of the constant: it holds the RELATIONSHIP the constant's
    // derivation claims, so shrinking the bound toward the measured figure — the
    // move that produced the flake this replaces — fails here and says why.
    expect(FRAME_WITNESS_TIMEOUT_MS).toBeGreaterThan(MEASURED_WORST_LOCAL_MS * 100);
  });

  it("stays inside half the cold-start budget it must not swallow", () => {
    // The ordering property the witness's derivation claims: readiness is the
    // longer wait, so a launch whose problem is the WINDOW runs out of readiness
    // first and fails naming the window rather than being reported as a renderer
    // that would not paint. Both constants are importable now that they live in
    // a module free of `@playwright/test`, so this is the real inequality rather
    // than the literal it used to restate against itself.
    expect(FRAME_WITNESS_TIMEOUT_MS).toBeLessThanOrEqual(READINESS_BUDGET_MS / 2);
  });
});
