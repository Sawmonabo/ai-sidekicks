// What has to be true of the launched window before a tier measures anything in it: the readiness
// ladder, then two questions asked of the window (is the document visible, are frames arriving),
// neither trusted from the build's configuration. `electron/harness.ts` owns the process; this is
// the phase after it starts.

import type { ElectronApplication, Page } from "@playwright/test";

import { UNOBTRUSIVE_WINDOWS_ENV } from "#main/windows/reveal.js";
import { isConsoleWindowId } from "#shared/window/frame-name.js";
import { FramePaintProbe, type RendererFrameSource } from "../frame-paint-probe.js";
import {
  POST_READINESS_RESERVE_MS,
  readinessFailure,
  type LaunchDeadline,
} from "./launch-deadline.js";
import { LAUNCH_TRACE_TAG } from "./trace.js";

/** The launched app's pages: the window a person sees, and the hidden console document. */
export interface AppPages {
  /** The first window of session views the console document opened, painting. */
  readonly window: Page;
  /** The hidden console document every window is drawn from; it is never shown and never paints. */
  readonly consolePage: Page;
}

/**
 * Wait for the console document and the first window it opens, and hand back that window painting.
 *
 * Every wait draws from the caller's `deadline`, so the ladder and the two guards cost the launch
 * budget once between them, and a failure at any rung is raised as a readiness failure.
 */
export async function awaitPaintingAppWindow(
  application: ElectronApplication,
  deadline: LaunchDeadline,
): Promise<AppPages> {
  let window: Page;
  let consolePage: Page;
  let visibilityState: string;
  try {
    // Readiness first, then the frame question. Every wait draws from the cold-start budget so a
    // slow boot is charged to what is slow, and the frame paint probe is armed only once the
    // renderer is ready. In the order the renderer reaches them: the console document, which main
    // builds first; its `load`; the window it opens, named by a window id; then the frame element
    // in that window, since its document exists before React draws anything into it.
    consolePage = await application.firstWindow({
      timeout: deadline.remainingMs(POST_READINESS_RESERVE_MS),
    });
    await consolePage.waitForLoadState("load", {
      timeout: deadline.remainingMs(POST_READINESS_RESERVE_MS),
    });
    window = await awaitWindowOfSessionViews(application, deadline);
    await window.waitForSelector(".meridian-frame", {
      timeout: deadline.remainingMs(POST_READINESS_RESERVE_MS),
    });
    // Read through the deadline because `evaluate` has no timeout and ignores Playwright's
    // default; a wedged main thread would leave it pending until the tier gave up.
    visibilityState = await deadline.settleWithin(
      window.evaluate(() => document.visibilityState),
      "the renderer visibility read",
      POST_READINESS_RESERVE_MS,
    );
  } catch (error: unknown) {
    throw readinessFailure(deadline, error);
  }
  // A throttled renderer gives false measurements, so the tiers assert twice instead of trusting
  // the build: what the document reports, and whether frames actually arrive (the endurance tier
  // times the second).
  if (visibilityState !== "visible") {
    throw new Error(
      `the app document is "${visibilityState}" to Chromium, so its renderer is throttled and ` +
        "nothing measured in it would describe the app; the launched build must honor " +
        `${UNOBTRUSIVE_WINDOWS_ENV} by disabling background ` +
        `throttling (src/main/windows/reveal.ts)`,
    );
  }
  const frames = await new FramePaintProbe(rendererFrameSource(window)).probe();
  if (!frames.painting) {
    throw new Error(
      `no animation frame arrived within ${String(frames.budgetMs)} ms of the renderer ` +
        "signaling ready, so it is not painting and nothing timed in it would describe the " +
        "app; an unrevealed window paints only with background throttling off " +
        "(src/main/windows/reveal.ts)",
    );
  }
  // Printed on every launch, passing ones included: the bound can only be re-derived from figures
  // a real runner produced.
  console.error(
    `${LAUNCH_TRACE_TAG} first frame ` +
      `${String(Math.round(frames.frameIntervalMs))} ms in-renderer, ` +
      `${String(frames.waitedMs)} ms driver-side, against a ${String(frames.budgetMs)} ms bound`,
  );
  return { window, consolePage };
}

/**
 * The first page whose frame name is a window of session views' id: the console document opens
 * each window under its id, and its own page carries none.
 */
async function awaitWindowOfSessionViews(
  application: ElectronApplication,
  deadline: LaunchDeadline,
): Promise<Page> {
  // Aborted on return, so the wait armed for a window that never had to come does not stay armed
  // for the rest of the readiness budget.
  const abandonedWait = new AbortController();
  try {
    for (;;) {
      // Armed before the scan: a window opening while a frame name is read would otherwise be
      // missed.
      const nextWindow = application.waitForEvent("window", {
        timeout: deadline.remainingMs(POST_READINESS_RESERVE_MS),
        signal: abandonedWait.signal,
      });
      // Settled by the abort below or by the next turn's wait; never left to reject unheard.
      nextWindow.catch(() => undefined);
      for (const page of application.windows()) {
        const frameName = await deadline.settleWithin(
          page.evaluate(() => window.name),
          "a window's frame name read",
          POST_READINESS_RESERVE_MS,
        );
        if (isConsoleWindowId(frameName)) {
          return page;
        }
      }
      await nextWindow;
    }
  } finally {
    abandonedWait.abort();
  }
}

/**
 * The Playwright implementation of the paint probe's seam. The interval is timed inside the
 * renderer, so the printed figure is the frame schedule without a CDP round trip; the paint probe
 * separately records driver-side wall time, so a disagreement says which half was slow.
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
