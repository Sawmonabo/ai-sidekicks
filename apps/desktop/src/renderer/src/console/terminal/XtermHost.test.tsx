// The mount point: the chunk it waits for, one adapter per mount, disposed with
// it, and a name that carries the write gate.
//
// WHAT THIS FILE IS FOR AND WHAT IT IS NOT. The emulator's behaviour is
// `xterm-adapter.test.ts`'s subject; this one owns the four things the COMPONENT
// decides — that the emulator's code is fetched rather than statically linked, so
// the box stands in as a read-in-flight absence until it lands; that an adapter is
// built once per mount and never in a render pass; that unmounting disposes it
// (which is what returns the pooled renderer slot); and that a lease change
// forwards the write gate without tearing the emulator down. Each is asserted
// through an observable consequence rather than by reading the component's
// internals: the pool's own slot count answers two of them, the absence primitive's
// own class answers the first, and the region's accessible name answers the last.
//
// THE LOADER IS THE REAL ONE. A stub that resolved the adapter synchronously would
// test a component that does not exist — the whole point of the change under test
// is that the module arrives a commit later than the mount, and a substitute that
// erased that gap would pass over the bug it exists to catch.

import { act, render, waitFor, type RenderResult } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { terminalEmulatorLoader } from "./emulator-loader.js";
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

/**
 * Wait for the emulator's chunk to have been fetched AND for every callback
 * registered on it to have run.
 *
 * Awaiting the loader's own promise is what makes the wait exact rather than a
 * guessed number of ticks: the component registered its continuation on that same
 * promise first, so by the time this one settles the component's has already run,
 * and `act` flushes the state it set.
 */
async function settleEmulatorLoad(): Promise<void> {
  await act(async () => {
    await terminalEmulatorLoader.load();
  });
}

/**
 * Whether the LIBRARY thinks this surface may be typed into.
 *
 * xterm.js mirrors its own `disableStdin` option onto the hidden textarea it
 * listens on — at open and again on every change of that option — so this reads
 * the emulator's gate rather than a field of ours that was set beside it. It is
 * the only place the write gate becomes observable outside the adapter, and it is
 * what makes "the gate reached the emulator" a claim a test can hold.
 */
function isEmulatorAcceptingInput(surface: HTMLElement): boolean {
  const textarea = surface.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("the emulator rendered no input");
  }
  return !textarea.readOnly;
}

/** Render a host and wait until its emulator is on screen. */
async function mountHost(element: React.JSX.Element): Promise<RenderResult> {
  const view = render(element);
  await waitFor(() => {
    expect(view.container.querySelector(".meridian-terminal-host__surface")).not.toBeNull();
  });
  return view;
}

describe("the emulator's code is fetched, not linked", () => {
  it("stands the box in as a read-in-flight absence before the chunk lands", async () => {
    const { container } = render(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    // Synchronously after the mount there is no surface, because the module that
    // draws into one has not arrived. The box is still there and still says which
    // gate it is under — only its contents are absent.
    expect(container.querySelector(".meridian-terminal-host")).not.toBeNull();
    expect(container.querySelector(".meridian-terminal-host__surface")).toBeNull();
    const absence = container.querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-loaded");
    expect(absence?.className).toContain("meridian-nothing--block");

    await settleEmulatorLoad();

    // And once it lands the absence is replaced by the emulator rather than joined
    // by it: a skeleton left beside a live grid would read as a second terminal
    // still loading.
    expect(surfaceOf(container).childElementCount).toBeGreaterThan(0);
    expect(container.querySelector(".meridian-nothing")).toBeNull();
  });

  it("negative control: the absence is not the kind that would look finished", async () => {
    const { container } = render(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    // `empty` would claim the shell printed nothing and `not-checked` would claim
    // nobody asked. Both are claims about the SESSION made by a component that is
    // only waiting on its own bytes.
    const absence = container.querySelector(".meridian-nothing");
    expect(absence?.className).not.toContain("meridian-nothing--empty");
    expect(absence?.className).not.toContain("meridian-nothing--not-checked");
    await settleEmulatorLoad();
  });

  it("ignores an emulator that arrives after the pane closed", async () => {
    const observed = vi.fn();
    const { container, unmount } = render(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    // Closed inside the fetch. The promise is still in flight over a component
    // React has already dropped, and settling it into state would be a write
    // against a disposed host.
    unmount();
    await settleEmulatorLoad();
    expect(observed).not.toHaveBeenCalled();
    expect(container.querySelector(".meridian-terminal-host__surface")).toBeNull();
    // No adapter was built, so nothing took a slot that nothing will give back.
    expect(terminalRendererPool.holds("host-1")).toBe(false);
  });

  it("negative control: that same wait does build one for a host still mounted", async () => {
    // Without this the case above would pass against a wait too short for the
    // chunk to have arrived at all, which asserts nothing about the unmount.
    const observed = vi.fn();
    render(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    await settleEmulatorLoad();
    expect(observed).toHaveBeenCalledTimes(1);
  });
});

describe("the mount point — one adapter per mount", () => {
  it("builds an emulator into the host box on mount", async () => {
    const { container } = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    // The library writes its own grid into the box it was opened against, so a
    // non-empty surface is evidence a real emulator attached rather than that a
    // ref was set.
    expect(surfaceOf(container).childElementCount).toBeGreaterThan(0);
  });

  it("reports the renderer it settled on, so a surface can say which it got", async () => {
    const observed = vi.fn();
    await mountHost(
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

  it("disposes on unmount, which is what gives the renderer slot back", async () => {
    const pool = new TerminalRendererPool();
    const { unmount, container } = await mountHost(
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
  it("names the surface read-only while the lease is not the viewer's", async () => {
    const { container } = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    expect(surfaceOf(container).getAttribute("aria-label")).toBe("Terminal output, read-only");
  });

  it("drops the read-only suffix when the viewer holds the shell", async () => {
    const { container } = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled label="Terminal output" />,
    );
    expect(surfaceOf(container).getAttribute("aria-label")).toBe("Terminal output");
  });

  it("opens the emulator's own gate for a lease that was already the viewer's", async () => {
    // The emulator is built a commit AFTER the one that first carried the lease, so
    // a gate forwarded only when the lease MOVES would leave a holder watching a
    // shell they hold — the emulator would be built closed and stay closed until
    // the next transition.
    const { container } = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled label="Terminal output" />,
    );
    expect(isEmulatorAcceptingInput(surfaceOf(container))).toBe(true);
  });

  it("negative control: a watcher's emulator is closed, so the case above is not free", async () => {
    const { container } = await mountHost(
      <XtermHost terminalId="host-2" isWriteEnabled={false} label="Terminal output" />,
    );
    expect(isEmulatorAcceptingInput(surfaceOf(container))).toBe(false);
  });

  it("forwards a lease change without rebuilding the emulator", async () => {
    const observed = vi.fn();
    const { container, rerender } = await mountHost(
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

  it("carries the gate on the host box too, for the styling that has no text", async () => {
    const { container, rerender } = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    const host = container.querySelector(".meridian-terminal-host");
    expect(host?.getAttribute("data-write-enabled")).toBe("false");
    act(() => {
      rerender(<XtermHost terminalId="host-1" isWriteEnabled label="Terminal output" />);
    });
    expect(host?.getAttribute("data-write-enabled")).toBe("true");
  });

  it("negative control: the name is not read-only in both states", async () => {
    // Every case above would pass against a component that hardcoded one name.
    const watching = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    const holding = await mountHost(
      <XtermHost terminalId="host-2" isWriteEnabled label="Terminal output" />,
    );
    expect(surfaceOf(watching.container).getAttribute("aria-label")).not.toBe(
      surfaceOf(holding.container).getAttribute("aria-label"),
    );
  });
});
