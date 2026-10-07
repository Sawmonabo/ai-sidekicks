// The window's floor and the frame's three tracks, measured in Chromium, since happy-dom has no
// layout. The floor the frame reports is recomputed from its parts when the text size changes, and
// a window held at that floor still fits the rail, the open sessions track and one session view
// side by side with nothing scrolling sideways; one rem narrower, the session view no longer fits.

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { AppFrame } from "#renderer/layout/AppShell/AppFrame.js";
import { DEFAULT_APPEARANCE_RECORD, TEXT_SIZES } from "#shared/appearance.js";
import type { WindowSize } from "#shared/window/size.js";
import { SESSIONS_ROUTE, frameProps, liveBridgeWrapper } from "../helpers/app/frame-fixtures.js";
import { renderSettled } from "../helpers/app/harness.js";

const LARGEST_TEXT_SIZE = TEXT_SIZES.reduce((largest, size) => (size > largest ? size : largest));

/** The tier's own window, restored after each case so the next file starts at it. */
const tierViewport = { width: window.innerWidth, height: window.innerHeight };

/** Mounts the frame with tokens installed, recording every floor it reports. */
async function renderFrame(sessionsTrack?: React.ReactNode): Promise<readonly WindowSize[]> {
  installMeridianTokens(document);
  const floors: WindowSize[] = [];
  const BridgeHost = liveBridgeWrapper();
  await renderSettled(
    <BridgeHost>
      <AppFrame
        {...frameProps(SESSIONS_ROUTE)}
        onWindowFloorChange={(floor) => {
          floors.push(floor);
        }}
        {...(sessionsTrack === undefined ? {} : { sessionsTrack })}
      >
        {/* Sized by the tokens one session view is built from: the conversation at its floor
            beside the agents pane, the widest pane. */}
        <div
          style={{
            inlineSize:
              "calc(var(--meridian-conversation-floor) + var(--meridian-agents-pane-width))",
            blockSize: "1rem",
          }}
        />
      </AppFrame>
    </BridgeHost>,
  );
  await expect.poll(() => floors.length).toBe(1);
  return floors;
}

/** Sizes the page's viewport and confirms it took, so no case measures the tier's default. */
async function resizeViewport(width: number, height: number): Promise<void> {
  await page.viewport(width, height);
  expect({ width: window.innerWidth, height: window.innerHeight }).toStrictEqual({ width, height });
}

function boxOf(selector: string): DOMRect {
  const element = document.querySelector(selector);
  if (element === null) {
    throw new Error(`the frame rendered no ${selector}`);
  }
  return element.getBoundingClientRect();
}

function screenRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>(".meridian-frame__screen");
  if (region === null) {
    throw new Error("the frame rendered no screen region");
  }
  return region;
}

beforeEach(async () => {
  await resizeViewport(tierViewport.width, tierViewport.height);
});

afterEach(async () => {
  cleanup();
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
  await page.viewport(tierViewport.width, tierViewport.height);
});

describe("the window floor", () => {
  it("is reported again, in proportion, when the text size changes", async () => {
    const floors = await renderFrame();
    applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize: LARGEST_TEXT_SIZE });

    await expect.poll(() => floors.length).toBe(2);
    const [atDefault, atLargest] = floors;
    const growth = LARGEST_TEXT_SIZE / DEFAULT_APPEARANCE_RECORD.textSize;
    // Headless Chromium has no title-bar inset, so every part of the floor is root-relative.
    expect(atLargest?.width).toBeCloseTo((atDefault?.width ?? 0) * growth, 3);
    expect(atLargest?.height).toBeCloseTo((atDefault?.height ?? 0) * growth, 3);
  });

  it("holds the rail, the open sessions track and one session view side by side", async () => {
    const [floor] = await renderFrame(<p>sessions</p>);
    if (floor === undefined) {
      throw new Error("the frame reported no floor");
    }
    // Main rounds the floor up to whole pixels before it holds the window there.
    await resizeViewport(Math.ceil(floor.width), Math.ceil(floor.height));

    const rail = boxOf(".meridian-rail");
    const sessionsTrack = boxOf(".meridian-frame__sessions-track");
    const column = boxOf(".meridian-frame__column");
    expect(rail.right).toBeLessThanOrEqual(sessionsTrack.left);
    expect(sessionsTrack.right).toBeLessThanOrEqual(column.left);
    expect(column.right).toBeLessThanOrEqual(window.innerWidth);
    expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    const region = screenRegion();
    expect(region.scrollWidth).toBe(region.clientWidth);

    // Negative control: one rem narrower, the session view no longer fits the screen column.
    await resizeViewport(
      Math.ceil(floor.width) - DEFAULT_APPEARANCE_RECORD.textSize,
      Math.ceil(floor.height),
    );
    expect(region.scrollWidth).toBeGreaterThan(region.clientWidth);
  });

  it("gives the sessions track no width while it is closed", async () => {
    await renderFrame();

    expect(document.querySelector(".meridian-frame__sessions-track")).toBeNull();
    const column = boxOf(".meridian-frame__column");
    expect(column.left).toBe(boxOf(".meridian-rail").right);
    expect(column.right).toBe(window.innerWidth);
  });
});
