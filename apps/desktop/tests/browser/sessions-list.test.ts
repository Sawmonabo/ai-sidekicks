// The sessions list's chord and button, proved by driving the composed window in Chromium, where
// the sessions track animates: the platform modifier and B shows the sessions list beside the rail
// and hides it again, as a press on the Sessions button does, and neither leaves the screen the
// window is on. The screen staying put is the negative control for a chord that navigates.

import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mountApp, SESSIONS_HASH, type MountedApp } from "../helpers/mount-app.js";
import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";

/** A screen other than Sessions, so a chord that navigated would move the window off it. */
const WORKFLOWS_HASH = "#/workflows";

/**
 * Press the platform modifier and B. Both modifiers are dispatched and exactly one can match,
 * since tinykeys resolves `$mod` to `Meta` on a Mac user agent and `Control` elsewhere.
 */
async function pressSessionsListChord(ownerWindow: Window): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(ownerWindow, { key: "b", code: "KeyB", ctrlKey: true });
    fireEvent.keyDown(ownerWindow, { key: "b", code: "KeyB", metaKey: true });
    await crossMacrotaskBoundary();
  });
}

/** The rail's Sessions button; throws when the rail draws none. */
function sessionsButtonOf(mounted: MountedApp): HTMLButtonElement {
  const button = [
    ...mounted.ownerWindow.document.querySelectorAll<HTMLButtonElement>(".meridian-rail__button"),
  ].find((candidate) => candidate.getAttribute("aria-label")?.startsWith("Sessions") === true);
  if (button === undefined) {
    throw new Error("the rail drew no Sessions button");
  }
  return button;
}

/** The list the sessions track holds now, by its name, or `null` while the track is closed. */
function trackListName(mounted: MountedApp): string | null {
  return (
    mounted.ownerWindow.document
      .querySelector(".meridian-frame__sessions-track section")
      ?.getAttribute("aria-label") ?? null
  );
}

describe("the sessions list", () => {
  beforeEach(() => {
    window.location.hash = WORKFLOWS_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  it("shows and hides the sessions list on the chord and the button, leaving the screen", async () => {
    const mounted = await mountApp();
    const button = sessionsButtonOf(mounted);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // The button advertises the chord that does what it does.
    expect(button.getAttribute("aria-label")).toMatch(/^Sessions .*B$/u);

    await pressSessionsListChord(mounted.ownerWindow);
    expect(trackListName(mounted)).toBe("Sessions");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(
      mounted.ownerWindow.document.querySelector(".meridian-frame__sessions-track section")?.id,
    );
    expect(mounted.ownerWindow.location.hash).toBe(WORKFLOWS_HASH);

    await act(async () => {
      fireEvent.click(button);
      await crossMacrotaskBoundary();
    });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(mounted.ownerWindow.location.hash).toBe(WORKFLOWS_HASH);

    await act(async () => {
      fireEvent.click(button);
      await crossMacrotaskBoundary();
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await pressSessionsListChord(mounted.ownerWindow);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(mounted.ownerWindow.location.hash).toBe(WORKFLOWS_HASH);
  });
});
