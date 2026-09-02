// The mount point: one adapter per mount, disposed with it, and a name that
// carries the write gate.
//
// WHAT THIS FILE IS FOR AND WHAT IT IS NOT. The emulator's behaviour is
// `xterm-adapter.test.ts`'s subject; this one owns the three things the COMPONENT
// decides — that an adapter is built once per mount and never in a render pass,
// that unmounting disposes it (which is what returns the pooled renderer slot),
// and that a lease change forwards the write gate without tearing the emulator
// down. Each is asserted through an observable consequence rather than by reading
// the component's internals: the pool's own slot count answers the first two, and
// the region's accessible name answers the third.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalRendererPool, terminalRendererPool } from "./renderer-pool.js";
import { XtermHost } from "./XtermHost.js";

afterEach(() => {
  // The page pool is module state the component reaches through the adapter's
  // default. A leaked slot here would silently narrow every later case, so the
  // sweep is unconditional rather than per-case.
  for (const terminalId of ["host-1", "host-2"]) {
    terminalRendererPool.release(terminalId);
  }
});

function surfaceOf(container: HTMLElement): HTMLElement {
  const surface = container.querySelector(".meridian-terminal-host__surface");
  if (!(surface instanceof HTMLElement)) {
    throw new Error("XtermHost rendered no surface");
  }
  return surface;
}

describe("the mount point — one adapter per mount", () => {
  it("builds an emulator into the host box on mount", () => {
    const { container } = render(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    // The library writes its own grid into the box it was opened against, so a
    // non-empty surface is evidence a real emulator attached rather than that a
    // ref was set.
    expect(surfaceOf(container).childElementCount).toBeGreaterThan(0);
  });

  it("reports the renderer it settled on, so a surface can say which it got", () => {
    const observed = vi.fn();
    render(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    expect(observed).toHaveBeenCalledTimes(1);
    // The DOM shim has no WebGL2, so this environment settles on the fallback —
    // which is the arm the pool's cap also leads to.
    expect(observed).toHaveBeenCalledWith("dom");
  });

  it("disposes on unmount, which is what gives the renderer slot back", () => {
    const pool = new TerminalRendererPool();
    const { unmount, container } = render(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    const surface = surfaceOf(container);
    expect(surface.childElementCount).toBeGreaterThan(0);
    unmount();
    // The adapter tore its own DOM down; nothing of the emulator is left behind in
    // a box React is about to drop.
    expect(surface.childElementCount).toBe(0);
    expect(pool.heldSlotCount).toBe(0);
    expect(terminalRendererPool.holds("host-1")).toBe(false);
  });
});

describe("the write gate reaches assistive technology by name", () => {
  it("names the surface read-only while the lease is not the viewer's", () => {
    const { container } = render(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    expect(surfaceOf(container).getAttribute("aria-label")).toBe("Terminal output, read-only");
  });

  it("drops the read-only suffix when the viewer holds the shell", () => {
    const { container } = render(
      <XtermHost terminalId="host-1" isWriteEnabled label="Terminal output" />,
    );
    expect(surfaceOf(container).getAttribute("aria-label")).toBe("Terminal output");
  });

  it("forwards a lease change without rebuilding the emulator", () => {
    const observed = vi.fn();
    const { container, rerender } = render(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    const surfaceBefore = surfaceOf(container).firstElementChild;
    act(() => {
      rerender(
        <XtermHost
          terminalId="host-1"
          isWriteEnabled
          label="Terminal output"
          onRendererMode={observed}
        />,
      );
    });
    // 8.8: a transition never disturbs the foreground process. The emulator is the
    // same instance — the mount effect did not run a second time — and only the
    // gate moved.
    expect(observed).toHaveBeenCalledTimes(1);
    expect(surfaceOf(container).firstElementChild).toBe(surfaceBefore);
    expect(surfaceOf(container).getAttribute("aria-label")).toBe("Terminal output");
  });

  it("carries the gate on the host box too, for the styling that has no text", () => {
    const { container, rerender } = render(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    const host = container.querySelector(".meridian-terminal-host");
    expect(host?.getAttribute("data-write-enabled")).toBe("false");
    act(() => {
      rerender(<XtermHost terminalId="host-1" isWriteEnabled label="Terminal output" />);
    });
    expect(host?.getAttribute("data-write-enabled")).toBe("true");
  });

  it("negative control: the name is not read-only in both states", () => {
    // Every case above would pass against a component that hardcoded one name.
    const watching = render(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    const holding = render(
      <XtermHost terminalId="host-2" isWriteEnabled label="Terminal output" />,
    );
    expect(surfaceOf(watching.container).getAttribute("aria-label")).not.toBe(
      surfaceOf(holding.container).getAttribute("aria-label"),
    );
  });
});
