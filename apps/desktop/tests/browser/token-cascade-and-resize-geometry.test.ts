// The browser tier: assertions a DOM shim cannot answer. happy-dom resolves no custom property
// through the cascade and has no layout or `ResizeObserver`, so a resolved color or a published
// viewport height asserted there would pass while measuring nothing. Every case here reads a
// computed style or a real resize observation in Chromium.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { tokenVariableName, type SchemePreference } from "#renderer/styles/tokens.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";

/**
 * Wait for the platform to deliver a resize observation, then run the frame it armed. Bounded;
 * reports whether one arrived so a case can assert the real observer fired.
 */
async function runObservedResizeFrame(clock: ManualClock): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (clock.pendingFrameCount > 0) {
      clock.runFrame();
      return true;
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  }
  return false;
}

function tokenValue(tokenName: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(tokenVariableName(tokenName))
    .trim();
}

/** Applies the default appearance on `scheme`, as main's record would arrive. */
function applyScheme(scheme: SchemePreference): void {
  applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, scheme });
}

beforeEach(() => {
  installMeridianTokens(document);
  applyScheme("light");
});

afterEach(() => {
  applyScheme("system");
});

describe("browser — the token sheet reaches the cascade", () => {
  it("swaps the palette when the scheme attribute flips, in both directions", () => {
    const light = tokenValue("ground");
    applyScheme("dark");
    const dark = tokenValue("ground");
    expect(dark).not.toBe(light);
    applyScheme("light");
    expect(tokenValue("ground")).toBe(light);
  });
});

describe("browser — a pane that changed size reaches the transcript's geometry", () => {
  it("publishes the new viewport height from a real resize observation", async () => {
    // The unit tier drives the measurement pass by hand. Only a real engine has a
    // `ResizeObserver` and a layout, and the defect covered is a size change no scroll event
    // follows.
    const scrollContainer = document.createElement("div");
    scrollContainer.style.cssText = "overflow:auto;width:200px;height:300px";
    const content = document.createElement("div");
    content.style.cssText = "height:5000px";
    scrollContainer.append(content);
    document.body.append(scrollContainer);

    const clock = new ManualClock();
    const controller = new ScrollController({ clock });
    try {
      controller.attach(scrollContainer);
      const viewportHeights: number[] = [];
      controller.subscribeToGeometry((geometry) => viewportHeights.push(geometry.viewportHeight));
      // `observe` delivers an initial observation; drain it so what follows is the resize.
      await runObservedResizeFrame(clock);
      // The controller also re-measures once the webfonts settle; running that pass now keeps
      // it from standing in for the resize observation below.
      await document.fonts.ready;
      while (clock.pendingFrameCount > 0) {
        clock.runFrame();
      }
      expect(viewportHeights).toStrictEqual([300]);

      scrollContainer.style.height = "180px";
      expect(await runObservedResizeFrame(clock)).toBe(true);
      expect(viewportHeights).toStrictEqual([300, 180]);
      expect(controller.geometry?.cause).toBe("resize");

      // Negative control: a pass over an unchanged box wakes nobody, so the publication above is
      // the size change rather than the frame.
      controller.requestOverflowMeasurement();
      clock.runFrame();
      expect(viewportHeights).toStrictEqual([300, 180]);
    } finally {
      controller.dispose();
      scrollContainer.remove();
    }
  });
});
