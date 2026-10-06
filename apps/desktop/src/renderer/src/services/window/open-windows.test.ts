// A window opened again while it is open comes forward through main's reveal path, never through
// the renderer's own `focus()`, which would take focus from a test window main keeps unobtrusive.

import { afterEach, describe, expect, it, vi } from "vitest";

import { FrameWindows } from "#test/helpers/frame-windows.js";
import { OpenWindowFrames } from "#renderer/lib/open-window-frames.js";
import { OpenWindows } from "./open-windows.js";

const frameWindows = new FrameWindows();

afterEach(() => {
  frameWindows.removeAll();
});

describe("a window opened again", () => {
  it("asks main to bring it forward and leaves its own focus alone", () => {
    const openWindows = new OpenWindows({
      openWindow: frameWindows.open,
      consoleDocument: document,
      frames: new OpenWindowFrames(),
    });
    const askedForward: string[] = [];
    const stopAsking = openWindows.bringForwardThrough((windowId) => askedForward.push(windowId));
    const opened = openWindows.open("window/first");
    const focus = vi.spyOn(opened.window, "focus");

    expect(openWindows.open("window/first")).toBe(opened);
    stopAsking();

    expect(askedForward).toStrictEqual(["window/first"]);
    expect(focus).not.toHaveBeenCalled();
    expect(() => openWindows.open("window/first")).toThrow(
      "A window is brought forward only once the bridge is registered.",
    );
  });
});
