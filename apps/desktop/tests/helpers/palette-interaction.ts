// Opening the command palette, and knowing when it is ready to be typed into.
//
// Waiting for `role="dialog"` to be visible is not enough. `Dialog.Popup` is given `initialFocus`,
// and Base UI applies it late: `FloatingFocusManager` runs a layout effect on open, defers to
// `queueMicrotask`, then `enqueueFocus` calls `requestAnimationFrame(() => element.focus())`. The
// popup is visible for at least one frame before the input holds focus, and keystrokes in that
// window go to the document and are dropped. The query stays empty, `autoHighlight` highlights the
// first row of the unfiltered list, and `Enter` runs whatever command that is, reported ten
// seconds later as an app failure. It is invisible on a developer's machine, where the frame
// lands between two Playwright calls, and reachable on a two-core runner under Xvfb and
// SwiftShader.
//
// So the wait is for focus landing in the palette's input, the product's own signal: a sleep would
// be the same race, and a retry would hide a palette that never took focus.
//
// The two waits are one phase. Two waits each declaring `IN_WINDOW_STEP_TIMEOUT_MS` would entitle
// an opening to twenty seconds, while `launch-body` counts it as one ten-second phase, so
// the phase is minted once and both waits draw from what is left.

import type { Locator, Page } from "@playwright/test";
import { expect } from "vitest";

import type { AppUnderTest } from "./electron/harness.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "./launch/body.js";
import { LaunchDeadline } from "./launch/launch-deadline.js";

/**
 * The palette input's accessible name, as `CommandPalette.tsx` publishes it. Matched by role and
 * name, not class, because that is the contract for a screen-reader user and a class may be
 * renamed without breaking any promise.
 */
const PALETTE_INPUT_ACCESSIBLE_NAME = "Search commands";

/** The palette's own chord, pressed as a real key event through the real window. */
const PALETTE_OPEN_CHORD = "ControlOrMeta+Shift+KeyP";

/**
 * What these helpers need of a launched app: the window and the allowance. Narrowed, as
 * `withBoundedBody` is, so a case that owns no Electron can drive the phase arithmetic. A full
 * `AppUnderTest` satisfies it.
 */
type PaletteApp = Pick<AppUnderTest, "window" | "bodyAllowance">;

/**
 * What one look at the palette input can find. Three states, not a boolean: an absent input is a
 * palette that did not render its combobox or renamed it, while present and unfocused is the
 * frame race this module exists for.
 */
type PaletteInputFocus = "absent" | "present-unfocused" | "focused";

/**
 * Read, in one page turn, whether the palette input exists and holds focus.
 *
 * It uses `page.evaluate`, not `Locator.evaluate`: a locator resolves its element first and waits
 * out Playwright's own locator timeout when nothing matches, which the enclosing poll cannot
 * interrupt, so an absent combobox would overrun the budget and report a locator timeout instead
 * of the focus diagnostic. This returns on the turn it is asked, so the poll's bound is the only
 * clock.
 *
 * The selector is the locator's contract spelled for a page: `CommandPalette.tsx` publishes the
 * name as `aria-label`, and Base UI's combobox root sets `role="combobox"` on the input
 * explicitly. A change to either reads as `absent`.
 */
async function readPaletteInputFocus(appWindow: Page): Promise<PaletteInputFocus> {
  return await appWindow.evaluate((accessibleName): PaletteInputFocus => {
    const paletteInput = document.querySelector(
      `[role="combobox"][aria-label="${accessibleName}"]`,
    );
    if (paletteInput === null) {
      return "absent";
    }
    return paletteInput === document.activeElement ? "focused" : "present-unfocused";
  }, PALETTE_INPUT_ACCESSIBLE_NAME);
}

/**
 * Open the palette and return its input, once that input holds focus.
 *
 * Two waits in the order the facts become true, so the missing one names itself: a palette that
 * never opened fails on the dialog, one that opened without focus fails on the input. Both are
 * charged to the body's allowance so neither's sentence is replaced by the generic overrun. They
 * draw on one phase minted here, so the pair costs the one ten-second opening
 * `launch-body` counts, and an opening that spends the whole phase fails on the focus
 * reading inside it.
 */
export async function openPalette(appUnderTest: PaletteApp): Promise<Locator> {
  const appWindow = appUnderTest.window;
  const openingPhase = new LaunchDeadline(IN_WINDOW_STEP_TIMEOUT_MS);
  await appWindow.keyboard.press(PALETTE_OPEN_CHORD);
  await appWindow.getByRole("dialog").waitFor({
    state: "visible",
    timeout: appUnderTest.bodyAllowance.boundedMs(openingPhase.remainingMs()),
  });

  await expect
    .poll(async () => await readPaletteInputFocus(appWindow), {
      timeout: appUnderTest.bodyAllowance.boundedMs(openingPhase.remainingMs()),
      message:
        "the palette opened but never moved focus into its input — the reading names whether " +
        "the input was absent or present and unfocused",
    })
    .toBe("focused");
  return appWindow.getByRole("combobox", { name: PALETTE_INPUT_ACCESSIBLE_NAME });
}

/**
 * Close the palette and wait for it to be gone. It sits beside `openPalette` because an Escape
 * without observing the dismissal would leave the next step racing a dialog still trapping focus.
 * It is one wait, so it takes its own bound directly.
 */
export async function closePalette(appUnderTest: PaletteApp): Promise<void> {
  const appWindow = appUnderTest.window;
  await appWindow.keyboard.press("Escape");
  await appWindow.getByRole("dialog").waitFor({
    state: "hidden",
    timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  });
}
