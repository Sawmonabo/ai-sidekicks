// What has to be true of the launched window before a tier measures anything in it.
//
// Split from `electron-harness.ts` on this directory's own shape: the harness owns
// the PROCESS — its profile, its arguments, its disposition — and every phase of a
// launch that is not that already has a module of its own (`launch-deadline.ts`,
// `launch-profile.ts`, `launch-body.ts`, `bounded-cleanup.ts`). This is the phase
// between them: the readiness ladder, and the two questions asked of the window it
// produces before the harness hands it over.
//
// The two questions are asked of every launch and neither answer is trusted from the
// build's own configuration — the guards below say why each is asked separately.

import type { ElectronApplication, Page } from "@playwright/test";

import { UNOBTRUSIVE_WINDOWS_ENV } from "../../src/main/window-reveal.js";
import { FrameWitness, type RendererFrameSource } from "./frame-witness.js";
import {
  POST_READINESS_RESERVE_MS,
  readinessFailure,
  type LaunchDeadline,
} from "./launch-deadline.js";
import { LAUNCH_TRACE_TAG } from "./launch-trace.js";

/**
 * Wait for the application's first window and hand back one that is painting.
 *
 * Every wait draws from the `deadline` the caller minted, so the ladder and the two
 * guards cost the launch budget once between them rather than once each, and a
 * failure at any rung is raised as a readiness failure that names the rung.
 */
export async function awaitPaintingConsoleWindow(
  application: ElectronApplication,
  deadline: LaunchDeadline,
): Promise<Page> {
  let window: Page;
  let visibilityState: string;
  try {
    // READINESS FIRST, THEN THE FRAME QUESTION. Every wait here draws from the
    // COLD-START budget rather than the frame budget, and that split is the fix
    // for the flake the harness used to produce: a slow boot is charged to the
    // thing that is slow, and the frame witness is armed only once the renderer
    // has said it is ready. The signals, in the order the renderer reaches them:
    //
    //   • the first window — the Electron process got as far as opening one.
    //   • `load` — the document and its subresources are in. Cheap, and it can
    //     land AFTER React has mounted, so it is not implied by the selector.
    //   • the frame element, not `domcontentloaded`: the document exists before
    //     React has mounted anything, so waiting on the document alone would let
    //     a test assert against an empty body and call it a pass.
    //
    // Each takes what the deadline has LEFT, so the four of them cost the
    // budget once between them instead of once each.
    window = await application.firstWindow({
      timeout: deadline.remainingMs(POST_READINESS_RESERVE_MS),
    });
    await window.waitForLoadState("load", {
      timeout: deadline.remainingMs(POST_READINESS_RESERVE_MS),
    });
    await window.waitForSelector(".meridian-frame", {
      timeout: deadline.remainingMs(POST_READINESS_RESERVE_MS),
    });
    // Read through the deadline because `evaluate` carries no timeout of its
    // own and ignores Playwright's default one: a renderer whose main thread is
    // wedged would leave this round trip pending until the tier gave up, which
    // is the undiagnosable failure the witness below exists to replace.
    visibilityState = await deadline.settleWithin(
      window.evaluate(() => document.visibilityState),
      "the renderer visibility read",
      POST_READINESS_RESERVE_MS,
    );
  } catch (error: unknown) {
    throw readinessFailure(deadline, error);
  }
  // A measurement from a throttled renderer is a false one. The window is
  // never revealed on macOS and revealed inactive elsewhere, so Chromium would
  // by default throttle its timers and frames and report the document hidden
  // — unless the build switched background throttling off for this launch.
  // The tiers assert the state they measure in rather than trust it, twice:
  // what the document REPORTS, and whether frames actually ARRIVE, since the
  // first is a flag and the second is the thing the endurance tier times.
  if (visibilityState !== "visible") {
    throw new Error(
      `the console document is "${visibilityState}" to Chromium, so its renderer is throttled and ` +
        "nothing measured in it would describe the console; the launched build must honour " +
        `${UNOBTRUSIVE_WINDOWS_ENV} by disabling background throttling (src/main/window-reveal.ts)`,
    );
  }
  const frames = await new FrameWitness(rendererFrameSource(window)).witness();
  if (!frames.painting) {
    throw new Error(
      `no animation frame arrived within ${String(frames.budgetMs)} ms of the renderer ` +
        "signalling ready, so it is not painting and nothing timed in it would describe the " +
        "console; an unrevealed window paints only with background throttling off " +
        "(src/main/window-reveal.ts)",
    );
  }
  // Printed on EVERY launch, passing ones included. The bound above can only
  // be re-derived from figures a real runner produced, and a figure that is
  // printed only when it is already too late is no evidence at all.
  console.error(
    `${LAUNCH_TRACE_TAG} first frame ${String(Math.round(frames.frameIntervalMs))} ms in-renderer, ` +
      `${String(frames.waitedMs)} ms driver-side, against a ${String(frames.budgetMs)} ms bound`,
  );
  return window;
}

/**
 * The Playwright implementation of the witness's seam.
 *
 * The interval is timed INSIDE the renderer, by `performance.now()` either side
 * of the two callbacks, so the figure printed above is the frame schedule
 * itself rather than the frame schedule plus a CDP round trip on a loaded
 * runner. The witness separately records the driver-side wall time, so a launch
 * where the two disagree says which half was slow — which is the diagnosis the
 * old single number could not give.
 */
function rendererFrameSource(window: Page): RendererFrameSource {
  return {
    awaitTwoFrames: () =>
      window.evaluate(
        () =>
          new Promise<number>((resolveInterval) => {
            const requestedAt = performance.now();
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolveInterval(performance.now() - requestedAt);
              });
            });
          }),
      ),
  };
}
