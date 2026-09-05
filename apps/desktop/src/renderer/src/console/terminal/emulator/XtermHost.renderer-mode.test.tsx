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

import { act, render, waitFor, type RenderResult } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { XtermHost } from "./XtermHost.js";
import { hostBoxOf } from "./XtermHost.test-support.js";
import { disposeLiveEmulators } from "./xterm-adapter.test-support.js";
import { newestRenderer, resetWebglFallback } from "./webgl-fallback.test-support.js";

vi.mock("@xterm/addon-webgl", async () => ({
  WebglAddon: (await import("./webgl-fallback.test-support.js")).FakeWebglRenderer,
}));

/** The terminal ids this file's components mount under, reclaimed after each case. */
const COMPONENT_TERMINAL_IDS = ["loss-host-1", "loss-host-2"] as const;

afterEach(() => {
  disposeLiveEmulators();
  resetWebglFallback(COMPONENT_TERMINAL_IDS);
});

/**
 * Render a host and wait until its emulator has attached.
 *
 * The wait is on the ATTRIBUTE rather than on the surface element, and the two are
 * different commits: the surface appears when the chunk lands, and the adapter is built
 * by the effect that runs after that commit. Waiting on the element alone would read the
 * box in between and see the mount-pending value.
 */
async function mountHost(element: React.JSX.Element): Promise<RenderResult> {
  const view = render(element);
  await waitFor(() => {
    expect(hostBoxOf(view.container).getAttribute("data-renderer")).not.toBe("pending");
  });
  return view;
}

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
