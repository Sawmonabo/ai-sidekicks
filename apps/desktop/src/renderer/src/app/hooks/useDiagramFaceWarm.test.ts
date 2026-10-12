// The diagram label faces warmed for each open window's own palette: a window's text size changing
// warms the faces at its new size, and a window opened later is warmed and watched too.

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { FrameWindows } from "#test/helpers/frame-windows.js";
import type { DiagramPalette } from "#renderer/components/Markdown/diagram/palette.js";
import { OpenWindowFrames } from "#renderer/lib/open-window-frames.js";
import { OpenWindows } from "#renderer/services/window/open-windows.js";
import { useDiagramFaceWarm } from "./useDiagramFaceWarm.js";

const frameWindows = new FrameWindows();

afterEach(() => {
  frameWindows.removeAll();
});

it("warms each open window's faces at its own text size, again when it changes", async () => {
  const openWindows = new OpenWindows({
    openWindow: frameWindows.open,
    consoleDocument: document,
    frames: new OpenWindowFrames(),
  });
  const warmedSizes: number[] = [];
  const pictures = {
    warmDefaultFaces: (palette: DiagramPalette): void => {
      warmedSizes.push(palette.fontSizePx);
    },
  };
  const first = openWindows.open("window/first").window;
  renderHook(() => {
    useDiagramFaceWarm(pictures, openWindows);
  });
  expect(warmedSizes).toStrictEqual([13]);

  act(() => {
    first.document.documentElement.style.setProperty("font-size", "20px");
  });
  await vi.waitFor(() => {
    expect(warmedSizes).toStrictEqual([13, 16.25]);
  });

  const second = openWindows.open("window/second").window;
  expect(warmedSizes).toStrictEqual([13, 16.25, 13]);
  act(() => {
    second.document.documentElement.style.setProperty("font-size", "24px");
  });
  await vi.waitFor(() => {
    expect(warmedSizes).toStrictEqual([13, 16.25, 13, 19.5]);
  });
});
