// The browser tier: assertions a DOM shim cannot answer. happy-dom returns zeroes from every
// `getBoundingClientRect`, resolves no custom property through the cascade and lays nothing
// out, so a width or a resolved color asserted there would pass while measuring nothing. Every
// case here measures a box or reads a computed style in real Chromium.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, pressKeys, renderSettled } from "../helpers/app-harness.js";

import { createFixtureComposition } from "@renderer/app/fixture-composition.js";
import { AppProviders } from "@renderer/app/providers.js";
import { applyColorScheme, installMeridianTokens } from "@renderer/app/token-installation.js";
import { MERIDIAN_STYLE_ELEMENT_ID } from "@renderer/app/token-installation.js";
import { FIRST_RUN_SCENARIO_ID } from "../../fixtures/scenarios/first-run.js";
import { LEADING_EDGE_WIDTH_PX } from "@renderer/styles/palette.js";
import { MOTION_DURATIONS_MS } from "@renderer/styles/motion.js";
import { tokenVariableName } from "@renderer/styles/tokens.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { ScrollController } from "@renderer/features/transcript/scroll/scroll-chokepoint.js";

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

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
  applyColorScheme(document, "light");
});

afterEach(async () => {
  applyColorScheme(document, "system");
  // Leave the emulated system preference where the page found it.
  await emulateSystemScheme("light");
});

describe("browser — the token sheet reaches the cascade", () => {
  it("installs exactly one sheet, however many times it is asked", () => {
    installMeridianTokens(document);
    installMeridianTokens(document);
    expect(document.querySelectorAll(`#${MERIDIAN_STYLE_ELEMENT_ID}`)).toHaveLength(1);
  });

  it("resolves a color token through the cascade rather than to an empty string", () => {
    // The unit tier reads the TypeScript record; only a real cascade proves it reached the
    // document. An unresolved custom property is the empty string and paints as nothing.
    expect(tokenValue("text")).toMatch(/^oklch\(/);
    expect(tokenValue("ground")).toMatch(/^oklch\(/);
  });

  it("carries the attribution edge and the motion durations as real values", () => {
    expect(tokenValue("leading-edge")).toBe(`${String(LEADING_EDGE_WIDTH_PX)}px`);
    expect(tokenValue("motion-settle")).toBe(`${String(MOTION_DURATIONS_MS["motion-settle"])}ms`);
  });

  it("swaps the palette when the scheme attribute flips, in both directions", () => {
    const light = tokenValue("ground");
    applyColorScheme(document, "dark");
    const dark = tokenValue("ground");
    expect(dark).not.toBe(light);
    applyColorScheme(document, "light");
    expect(tokenValue("ground")).toBe(light);
  });

  it("hands the browser's own controls the scheme the operator chose", async () => {
    // A custom property reaches nothing the browser paints for itself (scrollbar, form controls,
    // the canvas behind the document); `color-scheme` does, and only a real engine resolves it.
    //
    // A dark system under an explicit light choice is the case worth driving: with the root's
    // `light dark` left in force the document paints light and Chromium paints its own UI dark
    // inside it. The mirror mismatch is reachable the same way.
    await emulateSystemScheme("dark");
    applyColorScheme(document, "light");
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("light");

    await emulateSystemScheme("light");
    applyColorScheme(document, "dark");
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark");

    // Negative control: with no choice expressed the root keeps offering both, so a system-scheme
    // window still follows the OS.
    applyColorScheme(document, "system");
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("light dark");
  });
});

describe("browser — the frame lays out", () => {
  it("gives the rail a real width and the screen the rest of the row", async () => {
    const { container } = await renderSettled(
      <AppProviders composition={createFixtureComposition(FIRST_RUN_SCENARIO_ID)} />,
    );

    const rail = container.querySelector(".meridian-rail");
    const frame = container.querySelector(".meridian-frame");
    expect(rail).not.toBeNull();
    expect(frame).not.toBeNull();
    if (rail === null || frame === null) {
      return;
    }

    const railBox = rail.getBoundingClientRect();
    const frameBox = frame.getBoundingClientRect();
    // Zero would be the happy-dom answer for both; a rail with no width is a rail nobody can
    // click.
    expect(railBox.width).toBeGreaterThan(0);
    expect(railBox.height).toBeGreaterThan(0);
    expect(frameBox.width).toBeGreaterThan(railBox.width);
  });

  it("opens the palette on its chord and lists the frame's own commands", async () => {
    // The palette is chrome and must work before any feature registers anything, so on a first
    // run it lists the frame's own navigation and appearance commands. A real key press proves
    // the whole path: the chord listener, the registry, the `when` evaluation and the portal.
    await renderSettled(
      <AppProviders composition={createFixtureComposition(FIRST_RUN_SCENARIO_ID)} />,
    );

    expect(document.querySelector("[role='dialog']")).toBeNull();
    await pressKeys("{Control>}{Shift>}p{/Shift}{/Control}");
    await pressKeys("{Meta>}{Shift>}p{/Shift}{/Meta}");

    const dialog = document.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    const listed = [...(dialog?.querySelectorAll("[role='option']") ?? [])].map(
      (option) => option.textContent ?? "",
    );
    // The palette walks the same closed set as the rail; a destination reachable by icon and not
    // by command would be the two disagreeing about where a person can go.
    expect(listed.some((text) => text.includes("Go to Sessions"))).toBe(true);
    expect(listed.some((text) => text.includes("Go to Workflows"))).toBe(true);
    expect(listed.some((text) => text.includes("Go to Settings"))).toBe(true);
  });

  it("does not scroll the frame horizontally at a narrow window", async () => {
    const { container } = await renderSettled(
      <AppProviders composition={createFixtureComposition(FIRST_RUN_SCENARIO_ID)} />,
    );
    const frame = container.querySelector(".meridian-frame");
    expect(frame).not.toBeNull();
    if (frame === null) {
      return;
    }
    // A frame wider than its own box means something inside it refuses to compress.
    expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth + 1);
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
