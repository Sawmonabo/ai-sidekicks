// The terminal's grid is set at the terminal's type step and moves with `Text size`. The emulator
// sizes its cell from its own option, never from the element it draws into, so a grid left on the
// library's default size reads larger than the pane was sized for. Measured in Chromium, since a
// DOM shim resolves no custom property and the step is one.

import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { XtermMountPoint } from "#renderer/features/terminal/emulator/components/XtermMountPoint.js";
import { renderSettledMountPoint } from "#renderer/features/terminal/emulator/components/XtermMountPoint.test-support.js";
import { TYPE_SCALE_REM } from "#renderer/styles/typography.js";
import { DEFAULT_APPEARANCE_RECORD, type TextSize } from "#shared/appearance.js";

/** A text size whose terminal step is neither the default's nor the library's own 15 px. */
const LARGER_TEXT_SIZE: TextSize = 18;

afterEach(() => {
  cleanup();
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
});

describe("the terminal's type step", () => {
  it("sets the grid at the step at the default text size and again after a step", async () => {
    installMeridianTokens(document);
    applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint terminalId="text-size" isWriteEnabled={false} label="Shell output" />,
    );

    expect(gridFontSizeOf(container)).toBe(terminalStepPx(DEFAULT_APPEARANCE_RECORD.textSize));

    act(() => {
      applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize: LARGER_TEXT_SIZE });
    });

    await waitFor(() => {
      expect(gridFontSizeOf(container)).toBe(terminalStepPx(LARGER_TEXT_SIZE));
    });
  });
});

/** The terminal's step, `text-12`, at `textSize`'s root, as CSS writes it. */
function terminalStepPx(textSize: TextSize): string {
  return `${String((TYPE_SCALE_REM["text-12"] ?? Number.NaN) * textSize)}px`;
}

/**
 * The size the emulator sets its cell at: with its screen reader rows on, the library writes its
 * own `fontSize` option onto the box that holds them each time the cell is measured.
 */
function gridFontSizeOf(container: HTMLElement): string {
  const rowsBox = container.querySelector<HTMLElement>(".xterm-accessibility");
  if (rowsBox === null) {
    throw new Error("the emulator drew no screen reader rows");
  }
  return rowsBox.style.fontSize;
}
