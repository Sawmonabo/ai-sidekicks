// The honest-chrome plane, in a real layout engine.
//
// Two claims a DOM shim cannot answer, and both are load-bearing rather than
// decorative. The strip has to sit ABOVE the surface — a banner about an outage that
// scrolled with the content would be a banner a person can lose — and its sheet has
// to reach the cascade at all, because this module's stylesheet enters through a
// SUB-MODULE door rather than the family barrel and an unresolved custom property
// paints as nothing rather than as an error.
//
// Driven through the `shell` scenario, which opens degraded on purpose: the frozen
// clock only moves when a driver advances it, so tick zero is what this tier sees.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";

import {
  ConsoleRoot,
  applyConsoleScheme,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { SHELL_SCENARIO_ID } from "../../../src/renderer/src/console/bridge/scenarios/shell.js";

async function mountShellScenario(): Promise<HTMLElement> {
  document.location.hash = "";
  installMeridianTokens(document);
  applyConsoleScheme(document, "light");
  const { container } = await renderSettled(<ConsoleRoot scenarioId={SHELL_SCENARIO_ID} />);
  return container;
}

describe("browser — the shell-state strip", () => {
  it("lays out above the surface rather than inside it", async () => {
    const container = await mountShellScenario();
    const strip = container.querySelector(".meridian-shell-state");
    const surface = container.querySelector(".meridian-frame__surface");
    expect(strip, "the shell scenario opens degraded, so the strip is standing").not.toBeNull();
    expect(surface).not.toBeNull();
    const stripBox = strip?.getBoundingClientRect();
    const surfaceBox = surface?.getBoundingClientRect();
    // Measured rather than asserted from the markup: the claim is about where a
    // person's eye lands, which is a layout fact.
    expect(stripBox?.height ?? 0).toBeGreaterThan(0);
    expect(stripBox?.bottom ?? 0).toBeLessThanOrEqual(surfaceBox?.top ?? 0);
  });

  it("resolves its own sheet's spacing through the cascade", async () => {
    // The sheet enters through `frame/shell-state/index.ts`, which is the one edge
    // the bundler sees for this module. Under a shim every computed value is the
    // empty string and this passes while measuring nothing; here it is the layout
    // engine answering.
    const container = await mountShellScenario();
    const strip = container.querySelector(".meridian-shell-state");
    expect(strip).not.toBeNull();
    const spacing = getComputedStyle(strip as Element).rowGap;
    expect(spacing).toMatch(/^\d+(\.\d+)?px$/u);
    expect(spacing).not.toBe("0px");
  });
});
