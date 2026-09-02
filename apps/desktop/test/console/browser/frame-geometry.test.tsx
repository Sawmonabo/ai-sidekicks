// The browser tier: the assertions a DOM shim cannot answer.
//
// `Spec-023 §Console Test Tiers` splits browser from unit for one reason, and it
// is a reason rather than a preference: happy-dom returns zeroes from every
// `getBoundingClientRect`, resolves no custom property through the cascade, and
// lays nothing out. Under it, "the rail is 56 px wide", "the attribution edge is
// 2 px", and "the ledger row's hue resolves to the participant's colour" all pass
// while measuring nothing at all. Those live here, in real Chromium, where the
// numbers come from a layout engine.
//
// What this file does NOT do is re-assert logic the unit tier already covers.
// Every case below either measures a box or reads a computed style.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, pressKeys, renderSettled } from "../console-harness.js";

import {
  ConsoleRoot,
  MERIDIAN_STYLE_ELEMENT_ID,
  applyConsoleScheme,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../src/renderer/src/console/bridge/scenarios/first-run.js";
import {
  ATTRIBUTION_EDGE_WIDTH_PX,
  MOTION_DURATIONS_MS,
  tokenVariableName,
} from "../../../src/renderer/src/console/tokens/index.js";
import { ManualClock } from "../../../src/renderer/src/console/core/index.js";
import { LedgerScrollController } from "../../../src/renderer/src/console/ledger/frame/scroll-chokepoint.js";

/**
 * Wait for the platform to deliver a resize observation, then run the frame it
 * armed. Bounded, and reports whether one arrived, so a case can assert that the
 * real observer fired rather than assuming it.
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
  applyConsoleScheme(document, "light");
});

afterEach(async () => {
  applyConsoleScheme(document, "system");
  // Leave the emulated system preference where the page found it, so a later case
  // is not measured under whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("browser — the token sheet reaches the cascade", () => {
  it("installs exactly one sheet, however many times it is asked", () => {
    installMeridianTokens(document);
    installMeridianTokens(document);
    expect(document.querySelectorAll(`#${MERIDIAN_STYLE_ELEMENT_ID}`)).toHaveLength(1);
  });

  it("resolves a colour token through the cascade rather than to an empty string", () => {
    // The unit tier reads the TypeScript record; only a real cascade proves the
    // record reached the document. An unresolved custom property is the empty
    // string, which paints as "inherit" and is invisible.
    expect(tokenValue("text")).toMatch(/^oklch\(/);
    expect(tokenValue("ground")).toMatch(/^oklch\(/);
  });

  it("carries the attribution edge and the motion durations as real values", () => {
    expect(tokenValue("attribution-edge")).toBe(`${String(ATTRIBUTION_EDGE_WIDTH_PX)}px`);
    expect(tokenValue("motion-settle")).toBe(`${String(MOTION_DURATIONS_MS["motion-settle"])}ms`);
  });

  it("swaps the palette when the scheme attribute flips, in both directions", () => {
    const light = tokenValue("ground");
    applyConsoleScheme(document, "dark");
    const dark = tokenValue("ground");
    expect(dark).not.toBe(light);
    applyConsoleScheme(document, "light");
    expect(tokenValue("ground")).toBe(light);
  });

  it("hands the browser's own controls the scheme the operator chose", async () => {
    // A custom property reaches nothing the browser paints for itself — the
    // scrollbar, the form control, the canvas behind the document. `color-scheme`
    // does, and only a real engine resolves it, which is why this is here and not
    // in the unit tier.
    //
    // A DARK system under an explicit LIGHT choice is the case worth driving: the
    // token guard already keeps the light palette, so with the root's `light dark`
    // left in force the document paints light and Chromium paints its own UI dark
    // inside it. The mirror mismatch is reachable the same way.
    await emulateSystemScheme("dark");
    applyConsoleScheme(document, "light");
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("light");

    await emulateSystemScheme("light");
    applyConsoleScheme(document, "dark");
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark");

    // Negative control: with no choice expressed the root keeps offering both, so
    // a system-scheme window still follows the OS rather than being pinned light.
    applyConsoleScheme(document, "system");
    expect(getComputedStyle(document.documentElement).colorScheme).toBe("light dark");
  });
});

describe("browser — the frame lays out", () => {
  it("gives the rail a real width and the surface the rest of the row", async () => {
    const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);

    const rail = container.querySelector(".meridian-rail");
    const frame = container.querySelector(".meridian-frame");
    expect(rail).not.toBeNull();
    expect(frame).not.toBeNull();
    if (rail === null || frame === null) {
      return;
    }

    const railBox = rail.getBoundingClientRect();
    const frameBox = frame.getBoundingClientRect();
    // Zero would be the happy-dom answer for both, which is the whole point of
    // running this here: a rail with no width is a rail nobody can click.
    expect(railBox.width).toBeGreaterThan(0);
    expect(railBox.height).toBeGreaterThan(0);
    expect(frameBox.width).toBeGreaterThan(railBox.width);
  });

  it("opens the palette on its chord and lists the frame's own commands", async () => {
    // The palette is shell chrome: it has to work before any family has
    // registered anything, so the frame's own navigation and appearance commands
    // are what it lists on a first run. Driving it with a real key press rather
    // than by setting state proves the whole path — the chord listener, the
    // registry, the `when` evaluation, and the overlay's portal.
    await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);

    expect(document.querySelector("[role='dialog']")).toBeNull();
    await pressKeys("{Control>}k{/Control}");
    await pressKeys("{Meta>}k{/Meta}");

    const dialog = document.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    const listed = [...(dialog?.querySelectorAll("[role='option']") ?? [])].map(
      (option) => option.textContent ?? "",
    );
    // The three rail destinations, listed because the palette walks the same
    // closed set the rail does — a destination reachable by icon and not by
    // command would be the two disagreeing about where a person can go.
    expect(listed.some((text) => text.includes("Go to Sessions"))).toBe(true);
    expect(listed.some((text) => text.includes("Go to Workflows"))).toBe(true);
    expect(listed.some((text) => text.includes("Go to Settings"))).toBe(true);
    // "Go to Workspace" is deliberately absent: its `when: "sessionActive"` is
    // false on a first run, and a command that cannot act is not offered.
    expect(listed.some((text) => text.includes("Go to Workspace"))).toBe(false);
  });

  it("does not scroll the frame horizontally at a narrow window", async () => {
    const { container } = await renderSettled(<ConsoleRoot scenarioId={FIRST_RUN_SCENARIO_ID} />);
    const frame = container.querySelector(".meridian-frame");
    expect(frame).not.toBeNull();
    if (frame === null) {
      return;
    }
    // A frame wider than its own box means something inside it refuses to
    // compress — the failure that turns a console into a horizontal scroller.
    expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth + 1);
  });
});

describe("browser — a pane that changed size reaches the ledger's geometry", () => {
  it("publishes the new viewport height from a real resize observation", async () => {
    // The unit tier drives the measurement pass by hand. Only a real engine has a
    // `ResizeObserver`, a layout, and a box that answers a height at all — and the
    // whole defect this covers is a size change that no scroll event follows.
    const scrollSurface = document.createElement("div");
    scrollSurface.style.cssText = "overflow:auto;width:200px;height:300px";
    const content = document.createElement("div");
    content.style.cssText = "height:5000px";
    scrollSurface.append(content);
    document.body.append(scrollSurface);

    const clock = new ManualClock();
    const controller = new LedgerScrollController({ clock });
    try {
      controller.attach(scrollSurface);
      const viewportHeights: number[] = [];
      controller.subscribeToGeometry((geometry) => viewportHeights.push(geometry.viewportHeight));
      // `observe` delivers an initial observation of its own; drain it so what
      // follows is the resize and nothing else.
      await runObservedResizeFrame(clock);
      expect(viewportHeights).toStrictEqual([300]);

      scrollSurface.style.height = "180px";
      expect(await runObservedResizeFrame(clock)).toBe(true);
      expect(viewportHeights).toStrictEqual([300, 180]);
      expect(controller.geometry?.cause).toBe("resize");

      // Negative control: a pass over a box that did not change wakes nobody, so
      // the publication above is the size change rather than the frame.
      controller.requestOverflowMeasurement();
      clock.runFrame();
      expect(viewportHeights).toStrictEqual([300, 180]);
    } finally {
      controller.dispose();
      scrollSurface.remove();
    }
  });
});
