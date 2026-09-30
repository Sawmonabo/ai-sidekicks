// The palette's chord, proved by driving the composed window: the platform modifier, Shift and P
// opens the palette, which makes the frame's background inert for exactly as long as it is open,
// and the platform modifier and K does not.
//
// Cases drive the real `AppProviders` against the fixture bridge the renderer project compiles in.

import { act, cleanup, fireEvent, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSIONS_HASH, mountApp } from "@test/helpers/mount-app.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";

/**
 * Press a key with the platform modifier, whichever `$mod` resolves to on this host.
 *
 * Both presses are dispatched and exactly one can match: tinykeys resolves `$mod` to `Meta` on a
 * Mac user agent and `Control` elsewhere, and a press with the wrong modifiers is dropped, so the
 * test need not re-derive the platform rule.
 */
async function pressWithModifier(key: {
  readonly key: string;
  readonly code: string;
  readonly shiftKey?: boolean;
}): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(window, { ...key, ctrlKey: true });
    fireEvent.keyDown(window, { ...key, metaKey: true });
    await crossMacrotaskBoundary();
  });
}

/** Press the palette's chord: the platform modifier, Shift and P. */
async function pressPaletteChord(): Promise<void> {
  await pressWithModifier({ key: "P", code: "KeyP", shiftKey: true });
}

/** The wrapper the frame inerts; throws when the frame renders none. */
function backgroundOf(mounted: RenderResult): HTMLElement {
  const background = mounted.container.querySelector<HTMLElement>(".meridian-frame__background");
  if (background === null) {
    throw new Error("the frame rendered no background wrapper to inert");
  }
  return background;
}

describe("AppProviders — the palette chord", () => {
  beforeEach(() => {
    window.location.hash = SESSIONS_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  it("carries inert for exactly as long as the palette is open", async () => {
    const mounted = await mountApp();
    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(false);

    await pressPaletteChord();
    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(true);

    // Negative control: a frame that inerted on any keystroke, or never cleared, fails here.
    await pressPaletteChord();
    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(false);
  });

  it("negative control: the platform modifier and K does not open the palette", async () => {
    // The palette's chord is Shift and P; a window that also opened on K would pass the case
    // above while binding the wrong keys.
    const mounted = await mountApp();

    await pressWithModifier({ key: "k", code: "KeyK" });

    expect(backgroundOf(mounted).hasAttribute("inert")).toBe(false);
  });
});
