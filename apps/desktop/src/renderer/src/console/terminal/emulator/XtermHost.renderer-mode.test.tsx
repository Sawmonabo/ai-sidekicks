// The mount point, when the renderer under it changes.
//
// The component's own half of the fallback: it moves its rendered reading and tells the
// surface, rather than copying `rendererMode` once at attachment — which is what the old
// component did, so its box read `webgl` over a terminal drawing through the DOM
// renderer and every consumer of the callback believed it. And it hears nothing from an
// emulator it has already unmounted, because a subscription left attached across the
// disposal is a state write into a tree React has dropped.
//
// See `webgl-fallback.test-support.ts` for what is stood in and why this is a file of
// its own rather than a block in `XtermHost.test.tsx`.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { XtermHost } from "./XtermHost.js";
import { hostBoxOf, mountHost } from "./XtermHost.test-support.js";
import { disposeLiveEmulators } from "./xterm-adapter.test-support.js";
import { newestRenderer, resetWebglFallback } from "./webgl-fallback.test-support.js";

vi.mock("@xterm/addon-webgl", async () => ({
  WebglAddon: (await import("./webgl-fallback.test-support.js")).FakeWebglRenderer,
}));

/**
 * The terminal ids THIS file's components mount under, reclaimed after each case.
 *
 * Its own ids and its own name: the shared `COMPONENT_TERMINAL_IDS` is the pair the
 * unmocked suites hold, and two lists under one name in one directory is a page ledger
 * one suite reclaims on another suite's behalf.
 */
const RENDERER_MODE_TERMINAL_IDS = ["loss-host-1", "loss-host-2"] as const;

afterEach(() => {
  disposeLiveEmulators();
  resetWebglFallback(RENDERER_MODE_TERMINAL_IDS);
});

describe("the mount point, when the renderer under it changes", () => {
  it("moves its own reading and tells the surface, rather than reporting the old one", async () => {
    const observed = vi.fn();
    const { container } = await mountHost(
      <XtermHost
        terminalId="loss-host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    expect(hostBoxOf(container).getAttribute("data-renderer")).toBe("webgl");
    expect(observed).toHaveBeenCalledExactlyOnceWith("webgl");

    act(() => {
      newestRenderer().loseContext();
    });

    // The negative control is the old component: it copied `rendererMode` once at
    // attachment and called `onRendererMode` once beside it, so this box would
    // still read `webgl` over a terminal drawing through the DOM renderer, and
    // every consumer of the callback would still believe it.
    expect(hostBoxOf(container).getAttribute("data-renderer")).toBe("dom");
    expect(observed).toHaveBeenCalledTimes(2);
    expect(observed).toHaveBeenLastCalledWith("dom");
  });

  it("negative control: a mode that did not move reports nothing further", async () => {
    // Without this the case above would pass against a host that re-announced on
    // every render, which would make the callback a re-render signal rather than a
    // renderer one.
    const observed = vi.fn();
    const { rerender } = await mountHost(
      <XtermHost
        terminalId="loss-host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    act(() => {
      rerender(
        <XtermHost
          terminalId="loss-host-1"
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
    const { unmount } = await mountHost(
      <XtermHost
        terminalId="loss-host-2"
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
