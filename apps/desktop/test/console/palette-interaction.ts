// Opening the command palette, and knowing when it is ready to be typed into.
//
// WHY THIS IS A MODULE AND NOT THREE LINES AT EACH CALL SITE
//
// Both launching tiers drive the palette — the end-to-end tier runs a command
// through it, the endurance tier churns the filter machinery with it — and both
// used to open it the same way: press the chord, wait for `role="dialog"` to be
// visible, start typing. That sequence has a hole, and it cost a red tier on a CI
// runner before it was found.
//
// THE HOLE. `Dialog.Popup` is handed `initialFocus`, and Base UI does not apply it
// synchronously with the popup's commit. `FloatingFocusManager` runs a layout
// effect on open, defers to `queueMicrotask`, and then calls `enqueueFocus`, which
// is `requestAnimationFrame(() => element.focus())`. So the popup is in the
// document — attached, painted, and `visible` to Playwright — for at least one
// animation frame before the input holds focus.
//
// A wait on the dialog therefore returns while `document.activeElement` is still
// `<body>`, and every keystroke sent in that window is delivered to the document
// and dropped. What follows is silent: the combobox's query stays empty, so
// `autoHighlight` highlights the first row of the UNFILTERED list, and `Enter`
// runs whatever command that happens to be. The tier does not report a lost
// keystroke — it reports that the command it asked for did not take effect, ten
// seconds later, in a message about the console rather than about the test.
//
// It is invisible on a developer's machine, where the frame lands in the round
// trip between two Playwright calls, and reachable on a two-core runner under
// Xvfb and SwiftShader, where frames are scheduled behind everything else. That
// asymmetry is why it has to be a WAIT rather than an ordering that looks right:
// no amount of reading the call site reveals which side of the frame it is on.
//
// THE FIX IS THE PRODUCT'S OWN SIGNAL. Focus landing in the palette's input is
// something the palette does and something the page can be asked about, so the
// wait is for that fact rather than for a duration. A sleep would be the same
// race with a nicer name on a slower runner, and a retry would hide a palette
// that never took focus at all — which is a real defect this now reports as one.

import type { Locator } from "@playwright/test";
import { expect } from "vitest";

import type { ConsoleApplication } from "./electron-harness.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "./launch-body.js";

/**
 * The palette input's accessible name, as `PaletteOverlay.tsx` publishes it.
 *
 * Matched by role and name rather than by class, because that is the contract the
 * component states for a person using a screen reader — the unit tier asserts the
 * same pair — and a class is styling that may be renamed without any promise
 * being broken.
 */
export const PALETTE_INPUT_ACCESSIBLE_NAME = "Search commands";

/** The palette's own chord, pressed as a real key event through the real window. */
const PALETTE_OPEN_CHORD = "ControlOrMeta+KeyK";

/**
 * Open the palette and return its input, once that input holds focus.
 *
 * Two waits, in the order the two facts become true, so whichever is missing is
 * the one that names itself: a palette that never opened fails on the dialog, and
 * one that opened without taking focus fails on the input. Both are charged to the
 * body's allowance, so neither can run past the enclosing budget and have its
 * sentence replaced by the generic overrun.
 */
export async function openPalette(consoleApplication: ConsoleApplication): Promise<Locator> {
  const consoleWindow = consoleApplication.window;
  await consoleWindow.keyboard.press(PALETTE_OPEN_CHORD);
  await consoleWindow.getByRole("dialog").waitFor({
    state: "visible",
    timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  });

  const paletteInput = consoleWindow.getByRole("combobox", {
    name: PALETTE_INPUT_ACCESSIBLE_NAME,
  });
  await expect
    .poll(
      async () => await paletteInput.evaluate((element) => element === document.activeElement),
      {
        timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
        message: "the palette opened but never moved focus into its input",
      },
    )
    .toBe(true);
  return paletteInput;
}

/**
 * Close the palette and wait for it to be gone.
 *
 * Beside `openPalette` because the two are one seam: a caller that opened through
 * the wait above and closed by pressing Escape without observing the dismissal
 * would leave the next step racing a dialog that is still trapping focus.
 */
export async function closePalette(consoleApplication: ConsoleApplication): Promise<void> {
  const consoleWindow = consoleApplication.window;
  await consoleWindow.keyboard.press("Escape");
  await consoleWindow.getByRole("dialog").waitFor({
    state: "hidden",
    timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  });
}
