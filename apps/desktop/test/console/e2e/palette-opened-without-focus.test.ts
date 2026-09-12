// Tier: end-to-end. Its spec files are named for the incident they reproduce
// rather than for the module they touch.
//
// Every other console tier renders the console into something that is not the
// application: happy-dom for the unit tier, a Chromium page for the three browser-mode
// tiers. None of them can catch a defect that exists only in the shipped shell, and
// this tier runs the code path a person installing the application would run.
//
// ONE ASSERTION LIBRARY, DELIBERATELY. Playwright ships its own auto-retrying `expect`
// and it is not used here: mixing two `expect`s makes which timeout applies to a line
// a question a reader answers from the import list, and Playwright's web-assertion
// timeouts are read from a test context this runner does not provide. Waiting is
// explicit (`locator.waitFor`, `expect.poll`) and asserting is Vitest's.
//
// THE INCIDENT: the chord opened the palette and the caret was somewhere else.
//
// Reported from CI and unreproducible on a developer's machine, because the palette's
// initial focus is queued on an animation frame and a laptop lands that frame between
// two Playwright round trips. The control below starves frames until the gap is wide
// enough to observe, which is what makes this a test rather than a coin flip. The
// chord path itself is only end to end here: the browser tier's synthetic events never
// traverse Electron's own accelerator handling, so a chord the application menu
// swallowed would pass there.
//

import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { withLaunchedConsole } from "../electron-harness.js";
import { closePalette, openPalette } from "../palette-interaction.js";
import { fixtureBundleExists } from "../fixture-bundle.js";

const bundleIsBuilt = fixtureBundleExists();

/**
 * How long a starved animation frame is held, in milliseconds.
 *
 * Long enough that a frame cannot land inside the round trip between two
 * Playwright calls, which is what makes the control deterministic rather than a
 * coin flip on a fast host; short enough that the reopen it precedes still
 * settles well inside the in-window step bound.
 */
const STARVED_FRAME_DELAY_MS = 1_500;

/**
 * Hold every animation frame back, so a step that silently depends on one shows it.
 *
 * A test instrument and not a stub of the subject: the callbacks still run, on the
 * real frame the window schedules, only later. It perturbs the ENVIRONMENT the way
 * a loaded runner does, which is the condition the defect it controls for needs and
 * the one no local machine reproduces. Irreversible for the window it is applied
 * to, so it is the last thing a body does.
 */
async function delayEveryAnimationFrame(consoleWindow: Page): Promise<void> {
  await consoleWindow.evaluate((delayMs) => {
    const scheduleFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      window.setTimeout(() => {
        scheduleFrame(callback);
      }, delayMs);
      // The handle a caller would cancel with. Nothing in the console cancels a
      // frame it requested, and returning a real id would name a frame that has
      // not been requested yet — so this reports the one honest answer instead.
      return 0;
    }) as typeof window.requestAnimationFrame;
  }, STARVED_FRAME_DELAY_MS);
}

describe.skipIf(!bundleIsBuilt)("end-to-end — palette opened without focus", () => {
  it("opens the palette from a real keystroke and focuses it before a frame lands", async () => {
    await withLaunchedConsole({}, async (consoleApplication) => {
      // A real key event through the real window, which is the only place the
      // whole chord path runs end to end: the browser tier's synthetic events
      // never traverse Electron's own accelerator handling, and a chord the
      // application menu swallowed would still pass there. `openPalette` also
      // waits for the input to hold focus, which is the fact the test below
      // depends on and the one this tier is the only place to observe.
      const paletteInput = await openPalette(consoleApplication);

      // And it closes. Stated because a palette that opens and cannot be
      // dismissed is worse than one that never opened — the person is stuck.
      await closePalette(consoleApplication);

      // THE NEGATIVE CONTROL for that focus wait, and it costs no second launch.
      // Base UI queues the palette's initial focus on an animation frame
      // (`palette-interaction.ts` names the chain), so a runner that is not
      // producing frames leaves the input focusABLE and unfocused for as long as
      // that takes — invisible on a developer's machine, where the frame lands
      // between two Playwright round trips. Delaying every frame widens that
      // window until it is observable: with the wait, focus is there when
      // `openPalette` returns; with the wait deleted, this line reads `false`,
      // which is the defect that failed the tier on CI.
      await delayEveryAnimationFrame(consoleApplication.window);
      await openPalette(consoleApplication);
      expect(await paletteInput.evaluate((element) => element === document.activeElement)).toBe(
        true,
      );
    });
  });
});
