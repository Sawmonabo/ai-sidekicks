// A paced delivery runs the app's frame work. The fixture's frozen clock runs no frame by itself,
// since no window paces it, so a run whose loop only advanced it would measure an app whose scroll
// writes and other frame work never ran. The concurrent-streaming script is paced across the
// window's own frames into its open session; the frame work it arms must have been armed and must
// all have run once the script is in and the window has drawn a few more frames.

import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";
import { SCENARIO_DRAIN_MS } from "./scenario-delivery-schedule.js";
import {
  ENDURANCE_LAUNCH_OPTIONS,
  openConcurrentStreamingSessionRoute,
  startPacedDelivery,
  waitForDeliveredBeats,
} from "./workload.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";

const bundleIsBuilt = fixtureBundleExists();

/**
 * Frames the window draws after the last beat before the pace stops: enough for the work the last
 * frames armed to run and for what it arms in turn, few enough that the reading still describes
 * the delivery.
 */
const SETTLING_FRAME_COUNT = 30;

describe.skipIf(!bundleIsBuilt)("endurance — a paced delivery runs the app's frame work", () => {
  it("runs every frame callback the delivery arms on the frozen clock", async () => {
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
      await openConcurrentStreamingSessionRoute(appUnderTest);
      const beats = CONCURRENT_STREAMING_SCENARIO.beats;
      const stopPace = await startPacedDelivery(appUnderTest, {
        leadInMs: 0,
        // Past the last beat by the refresh debounce, so the reads the last batch asks for run
        // inside the pace.
        stretchMs: (beats.at(-1)?.atMs ?? 0) + SCENARIO_DRAIN_MS,
        durationMs: IN_WINDOW_STEP_TIMEOUT_MS / 2,
      });
      await waitForDeliveredBeats(appUnderTest, beats.length);
      await appUnderTest.window.evaluate(
        async (frameCount: number) =>
          await new Promise<void>((resolve) => {
            let framesLeft = frameCount;
            const onFrame = (): void => {
              framesLeft -= 1;
              if (framesLeft === 0) {
                resolve();
                return;
              }
              requestAnimationFrame(onFrame);
            };
            requestAnimationFrame(onFrame);
          }),
        SETTLING_FRAME_COUNT,
      );
      const reading = await stopPace();

      expect(reading.beatsAtStop).toBe(beats.length);
      expect(
        reading.peakPendingFrameCount,
        "the delivery armed no frame work on the frozen clock, so nothing here shows it is run",
      ).toBeGreaterThan(0);
      expect(
        reading.pendingFrameCountAtStop,
        "frame work armed on the frozen clock was still waiting once the script was in and the " +
          "window had drawn more frames, so the paced loop did not run it",
      ).toBe(0);
    });
  });
});
