// Tier: end-to-end. Spec files are named for the incident they reproduce, not the module they
// touch. Every other tier renders the console into something that is not the application
// (happy-dom, or a Chromium page), so none catches a defect that exists only in the shipped
// app; this tier runs the path a person installing it would run.
//
// Playwright's own auto-retrying `expect` is not used: with two `expect`s, which timeout
// applies to a line is answered from the import list, and its web-assertion timeouts come from
// a test context this runner does not provide. Waiting is explicit (`locator.waitFor`,
// `expect.poll`) and asserting is Vitest's.
//
// The incident: the chord opened the palette and the caret was somewhere else. It reproduced
// only on CI, because the palette's initial focus is queued on an animation frame and a laptop
// lands that frame between two Playwright round trips. The control below starves frames until
// the gap is observable. The chord path is only end to end here: the browser tier's synthetic
// events never traverse Electron's accelerator handling, so a chord the application menu
// swallowed would pass there.
//

import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../helpers/electron-harness.js";
import { closePalette, openPalette } from "../helpers/palette-interaction.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";

const bundleIsBuilt = fixtureBundleExists();

/**
 * How long a starved animation frame is held, in milliseconds: long enough that a frame cannot
 * land between two Playwright calls, short enough that the reopen still settles well inside the
 * in-window step bound.
 */
const STARVED_FRAME_DELAY_MS = 1_500;

/**
 * Hold every animation frame back, so a step that silently depends on one shows it. The
 * callbacks still run on the real frame, only later, as on a loaded runner. Irreversible for the
 * window, so it is the last thing a body does.
 */
async function delayEveryAnimationFrame(consoleWindow: Page): Promise<void> {
  await consoleWindow.evaluate((delayMs) => {
    const scheduleFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      window.setTimeout(() => {
        scheduleFrame(callback);
      }, delayMs);
      // Nothing in the console cancels a requested frame, and a real id would name a frame not
      // yet requested, so the handle is 0.
      return 0;
    }) as typeof window.requestAnimationFrame;
  }, STARVED_FRAME_DELAY_MS);
}

describe.skipIf(!bundleIsBuilt)("end-to-end — palette opened without focus", () => {
  it("opens the palette from a real keystroke and focuses it before a frame lands", async () => {
    await withLaunchedApp({}, async (consoleApplication) => {
      // A real key event through the real window is the only place the whole chord path runs.
      // `openPalette` also waits for the input to hold focus, which the control below depends on.
      const paletteInput = await openPalette(consoleApplication);

      // A palette that opens and cannot be dismissed strands the person.
      await closePalette(consoleApplication);

      // The negative control for that focus wait, at no cost of a second launch. Base UI queues
      // the palette's initial focus on an animation frame (`palette-interaction.ts` names the
      // chain), so a runner producing no frames leaves the input unfocused. Delaying every frame
      // widens that window: with the wait, focus is there when `openPalette` returns; without it,
      // this line reads `false`.
      await delayEveryAnimationFrame(consoleApplication.window);
      await openPalette(consoleApplication);
      expect(await paletteInput.evaluate((element) => element === document.activeElement)).toBe(
        true,
      );
    });
  });
});
