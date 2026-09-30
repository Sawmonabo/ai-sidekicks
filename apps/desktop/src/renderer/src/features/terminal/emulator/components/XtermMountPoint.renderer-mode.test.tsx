// The mount point when the renderer under it changes: it moves its rendered reading and tells
// its parent rather than copying `rendererMode` once, and hears nothing from an emulator it has
// unmounted (a subscription left across disposal writes state into a dropped tree). See
// `webgl-fallback.test-support.ts` for what is stood in and why this is its own file.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { XtermMountPoint } from "./XtermMountPoint.js";
import { mountPointBoxOf, renderSettledMountPoint } from "./XtermMountPoint.test-support.js";
import { disposeLiveEmulators } from "../xterm-adapter.test-support.js";
import { newestRenderer, resetWebglFallback } from "../webgl-fallback.test-support.js";

vi.mock("@xterm/addon-webgl", async () => ({
  WebglAddon: (await import("../webgl-fallback.test-support.js")).FakeWebglRenderer,
}));

/**
 * The terminal ids this file's components mount under, reclaimed after each case. Separate from
 * the shared `COMPONENT_TERMINAL_IDS` so one suite does not reclaim on another's behalf.
 */
const RENDERER_MODE_TERMINAL_IDS = ["context-loss-1", "context-loss-2"] as const;

afterEach(() => {
  disposeLiveEmulators();
  resetWebglFallback(RENDERER_MODE_TERMINAL_IDS);
});

describe("the mount point, when the renderer under it changes", () => {
  it("moves its own reading and tells its parent, rather than reporting the old one", async () => {
    const observed = vi.fn();
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="context-loss-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    expect(mountPointBoxOf(container).getAttribute("data-renderer")).toBe("webgl");
    expect(observed).toHaveBeenCalledExactlyOnceWith("webgl");

    act(() => {
      newestRenderer().loseContext();
    });

    // A component that copied `rendererMode` once at attachment would still read `webgl` here,
    // and so would every consumer of the callback.
    expect(mountPointBoxOf(container).getAttribute("data-renderer")).toBe("dom");
    expect(observed).toHaveBeenCalledTimes(2);
    expect(observed).toHaveBeenLastCalledWith("dom");
  });

  it("negative control: a mode that did not move reports nothing further", async () => {
    // Without this the case above would pass against a mount point that re-announced on every
    // render, making the callback a re-render signal rather than a renderer one.
    const observed = vi.fn();
    const { rerender } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="context-loss-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    act(() => {
      rerender(
        <XtermMountPoint
          terminalId="context-loss-1"
          isWriteEnabled
          label="Terminal output"
          onRendererMode={observed}
        />,
      );
    });
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it("hears nothing from an emulator it has already unmounted", async () => {
    const observed = vi.fn();
    const { unmount } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="context-loss-2"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    const renderer = newestRenderer();
    unmount();
    renderer.loseContext();

    // One delivery, from the mount. A subscription left attached across the
    // disposal would be a state write into a tree React has dropped.
    expect(observed).toHaveBeenCalledExactlyOnceWith("webgl");
  });
});
