// The renderer's hold on a GPU context. It is taken only when the page pool grants one and
// given back by the pane that took it; when the GPU takes it away the adapter falls back to the
// DOM renderer for good, or the grid goes blank. This environment has no WebGL2, so
// `webgl-fallback.test-support.ts` stands one in.

import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRendererPool } from "./renderer-pool.js";
import { XtermTerminalAdapter, type TerminalRendererMode } from "./xterm-adapter.js";
import {
  attachedMountElement,
  disposeLiveEmulators,
  mountedAdapter,
  trackAdapter,
} from "./xterm-adapter.test-support.js";
import {
  FakeWebglRenderer,
  LateGrantingRendererPool,
  newestRenderer,
  resetWebglFallback,
} from "./webgl-fallback.test-support.js";

vi.mock("@xterm/addon-webgl", async () => ({
  WebglAddon: (await import("./webgl-fallback.test-support.js")).FakeWebglRenderer,
}));

afterEach(() => {
  disposeLiveEmulators();
  resetWebglFallback();
});

describe("the adapter, when the context it was drawing on goes away", () => {
  it("tells a subscriber that it fell back, once, with the mode it fell back to", () => {
    const adapter = mountedAdapter({ terminalId: "adapter-fell-back" }).adapter;
    const observed: TerminalRendererMode[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));

    newestRenderer().loseContext();

    // The current mode on subscribe, then the change; a consumer that copied the first would
    // still report `webgl`.
    expect(observed).toStrictEqual(["webgl", "dom"]);
    expect(adapter.rendererMode).toBe("dom");
  });

  it("does not take a second one when it is attached somewhere else", () => {
    const pool = new TerminalRendererPool();
    const adapter = trackAdapter(new XtermTerminalAdapter({ terminalId: "lost-then-moved", pool }));
    adapter.attach(attachedMountElement());
    expect(adapter.rendererMode).toBe("webgl");

    newestRenderer().loseContext();
    adapter.detach();
    adapter.attach(attachedMountElement());

    expect(adapter.rendererMode).toBe("dom");
    // One renderer for the whole life of this adapter — the one it lost.
    expect(FakeWebglRenderer.live).toHaveLength(1);
    // The allowance stays where the fallback put it; re-spending it is what this stops.
    expect(pool.holds("lost-then-moved")).toBe(false);
    expect(pool.createdContextCount).toBe(0);
  });
});

describe("the page pool's grant", () => {
  it("falls back to the DOM renderer while the pool refuses, and takes WebGL once it grants", () => {
    // Refused once, granted after, so the second attach starts with no addon and no loss.
    const adapter = trackAdapter(
      new XtermTerminalAdapter({
        terminalId: "refused-then-granted",
        pool: new LateGrantingRendererPool(1),
      }),
    );
    adapter.attach(attachedMountElement());
    expect(adapter.rendererMode).toBe("dom");
    expect(FakeWebglRenderer.live).toHaveLength(0);

    adapter.detach();
    adapter.attach(attachedMountElement());

    expect(adapter.rendererMode).toBe("webgl");
    expect(FakeWebglRenderer.live).toHaveLength(1);
  });
});

describe("two panes on one session", () => {
  it("spend two contexts, and one pane's teardown leaves the other drawing", () => {
    const pool = new TerminalRendererPool();
    const sessionTerminalId = "shared-session";
    const firstPane = trackAdapter(
      new XtermTerminalAdapter({ terminalId: sessionTerminalId, pool }),
    );
    firstPane.attach(attachedMountElement());
    const secondPane = trackAdapter(
      new XtermTerminalAdapter({ terminalId: sessionTerminalId, pool }),
    );
    secondPane.attach(attachedMountElement());

    expect(FakeWebglRenderer.live).toHaveLength(2);
    expect(pool.createdContextCount).toBe(2);
    expect(pool.heldContextCountFor(sessionTerminalId)).toBe(2);

    firstPane.dispose();

    // A teardown releases its own lease and does not reclaim it (the context outlives its
    // addon), so the pane still on screen keeps its context.
    expect(pool.heldContextCountFor(sessionTerminalId)).toBe(1);
    expect(pool.holds(sessionTerminalId)).toBe(true);
    expect(pool.createdContextCount).toBe(2);
    expect(secondPane.rendererMode).toBe("webgl");
  });
});
