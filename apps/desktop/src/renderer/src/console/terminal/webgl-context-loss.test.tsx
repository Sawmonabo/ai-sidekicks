// The GPU takes the context away, and everything above the emulator finds out.
//
// WHY THIS FILE MOCKS ONE LIBRARY AND NOTHING ELSE. `xterm-adapter.test.ts` and
// `XtermHost.test.tsx` drive `@xterm/xterm` itself, and they say why. Neither can
// reach this path: the DOM shim has no WebGL2, so `WebglAddon.activate` throws
// before a context exists and no instance in those files is ever on the renderer
// that can lose one. The addon is the one collaborator this environment cannot
// supply, so it is the one thing stood in for here — the emulator, the adapter,
// the pool, the loader, and the component are all the real ones, and the fallback
// under test is the adapter's own private path reached through the addon's own
// event.
//
// The file is separate rather than a block in either of those, because the mock is
// module-scoped: applied there it would put every one of their cases on a renderer
// this environment does not have, which is the opposite of what they assert.

import { act, render, waitFor, type RenderResult } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { terminalEmulatorLoader } from "./emulator-loader.js";
import { TerminalRendererPool, terminalRendererPool } from "./renderer-pool.js";
import { XtermTerminalAdapter, type TerminalRendererMode } from "./xterm-adapter.js";
import { XtermHost } from "./XtermHost.js";

/**
 * A renderer that activates, then loses its context on demand.
 *
 * Hoisted because `vi.mock`'s factory runs before the module body. Every instance
 * registers itself, which is how a test reaches the one an adapter built for
 * itself — a component's adapter is not a value the test holds.
 */
const { FakeWebglRenderer } = vi.hoisted(() => {
  class FakeWebglRenderer {
    public static readonly live: FakeWebglRenderer[] = [];
    readonly #contextLossListeners: (() => void)[] = [];

    public constructor() {
      FakeWebglRenderer.live.push(this);
    }

    /** `ITerminalAddon`'s half. Loading it is what makes the instance `webgl`. */
    public activate(): void {
      // The real addon compiles shaders here. Nothing to do for a fake context.
    }

    public dispose(): void {
      this.#contextLossListeners.length = 0;
    }

    public onContextLoss(listener: () => void): { dispose: () => void } {
      this.#contextLossListeners.push(listener);
      return {
        dispose: (): void => {
          this.#contextLossListeners.length = 0;
        },
      };
    }

    /** What the GPU driver does, as something a test can do. */
    public loseContext(): void {
      for (const listener of [...this.#contextLossListeners]) {
        listener();
      }
    }
  }
  return { FakeWebglRenderer };
});

vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: FakeWebglRenderer }));

const liveAdapters: XtermTerminalAdapter[] = [];
const liveHosts: HTMLElement[] = [];

afterEach(() => {
  for (const adapter of liveAdapters.splice(0)) {
    adapter.dispose();
  }
  for (const host of liveHosts.splice(0)) {
    host.remove();
  }
  FakeWebglRenderer.live.length = 0;
  // The page ledger is module state the component reaches through the adapter's
  // default pool. A mount here really does take a slot — the fake activates where
  // the real addon throws — and no context exists behind it, so the allowance goes
  // back rather than staying spent.
  for (const terminalId of ["loss-host-1", "loss-host-2"]) {
    terminalRendererPool.reclaim(terminalId);
  }
});

function mountedAdapter(terminalId: string): XtermTerminalAdapter {
  const host = document.createElement("div");
  document.body.append(host);
  liveHosts.push(host);
  const adapter = new XtermTerminalAdapter({ terminalId, pool: new TerminalRendererPool() });
  liveAdapters.push(adapter);
  adapter.attach(host);
  return adapter;
}

/** The renderer the newest adapter built for itself. */
function newestRenderer(): InstanceType<typeof FakeWebglRenderer> {
  const renderer = FakeWebglRenderer.live.at(-1);
  if (renderer === undefined) {
    throw new Error("no renderer was built, so no context can be lost");
  }
  return renderer;
}

/**
 * Render a host and wait until its emulator has attached.
 *
 * The wait is on the ATTRIBUTE rather than on the surface element, and the two are
 * different commits: the surface appears when the chunk lands, and the adapter is
 * built by the effect that runs after that commit. Waiting on the element alone
 * would read the box in between and see the mount-pending value.
 */
async function mountHost(element: React.JSX.Element): Promise<RenderResult> {
  const view = render(element);
  await waitFor(() => {
    expect(hostBoxOf(view.container).getAttribute("data-renderer")).not.toBe("pending");
  });
  return view;
}

function hostBoxOf(container: HTMLElement): HTMLElement {
  const box = container.querySelector(".meridian-terminal-host");
  if (!(box instanceof HTMLElement)) {
    throw new Error("XtermHost rendered no box");
  }
  return box;
}

describe("the adapter, when the context it was drawing on goes away", () => {
  it("takes the renderer this environment normally cannot give it", () => {
    // The premise every case below rests on. Without it they would all be
    // asserting a fallback from `dom` to `dom`.
    expect(mountedAdapter("adapter-took-one").rendererMode).toBe("webgl");
  });

  it("tells a subscriber that it fell back, once, with the mode it fell back to", () => {
    const adapter = mountedAdapter("adapter-fell-back");
    const observed: TerminalRendererMode[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));

    newestRenderer().loseContext();

    // The current mode on subscribe, then the change. A consumer that had copied
    // the first would still be reporting `webgl` at this point.
    expect(observed).toStrictEqual(["webgl", "dom"]);
    expect(adapter.rendererMode).toBe("dom");
  });

  it("says nothing a second time, because the mode did not move a second time", () => {
    const adapter = mountedAdapter("adapter-lost-twice");
    const observed: TerminalRendererMode[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));
    const renderer = newestRenderer();

    renderer.loseContext();
    renderer.loseContext();

    expect(observed).toStrictEqual(["webgl", "dom"]);
  });

  it("stops delivering to a subscriber that unsubscribed", () => {
    const adapter = mountedAdapter("adapter-unsubscribed");
    const observed: TerminalRendererMode[] = [];
    const unsubscribe = adapter.subscribeToRendererMode((mode) => observed.push(mode));

    unsubscribe();
    newestRenderer().loseContext();

    expect(observed).toStrictEqual(["webgl"]);
  });

  it("drops every sink on disposal rather than reporting its own teardown", () => {
    const adapter = mountedAdapter("adapter-disposed");
    const observed: TerminalRendererMode[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));

    adapter.dispose();

    // The teardown resets the mode, and a subscriber told about that would read it
    // as a fallback. It is also what keeps a throwing sink from aborting a
    // disposal between the pool release and the emulator's own.
    expect(observed).toStrictEqual(["webgl"]);
  });

  it("gives the page's allowance back, because the host destroyed the context", () => {
    const pool = new TerminalRendererPool();
    const host = document.createElement("div");
    document.body.append(host);
    liveHosts.push(host);
    const adapter = new XtermTerminalAdapter({ terminalId: "adapter-reclaimed", pool });
    liveAdapters.push(adapter);
    adapter.attach(host);
    expect(pool.holds("adapter-reclaimed")).toBe(true);

    newestRenderer().loseContext();

    expect(pool.holds("adapter-reclaimed")).toBe(false);
  });
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

describe("the loader is still the real one", () => {
  it("resolves the real adapter class, so the cases above drive the shipped code", async () => {
    const { XtermTerminalAdapter: loaded } = await terminalEmulatorLoader.load();
    expect(loaded).toBe(XtermTerminalAdapter);
  });
});
