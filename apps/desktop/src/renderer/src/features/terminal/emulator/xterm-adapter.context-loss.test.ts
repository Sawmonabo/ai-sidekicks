// The GPU takes the context away, and the adapter finds out: the renderer path this environment
// cannot reach alone (`webgl-fallback.test-support.ts` says what is stood in). Two halves: the
// fallback (the mode moves once, subscribers hear it once, the allowance goes back even when a
// subscriber throws) and its permanence for the life of the instance across a re-attach.

import { afterEach, describe, expect, it, vi } from "vitest";

import { terminalEmulatorLoader } from "./emulator-loader.js";
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
  it("takes the renderer this environment normally cannot give it", () => {
    // The premise: without it every case below would assert a fallback from `dom` to `dom`.
    expect(mountedAdapter({ terminalId: "adapter-took-one" }).adapter.rendererMode).toBe("webgl");
  });

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

  it("says nothing a second time, because the mode did not move a second time", () => {
    const adapter = mountedAdapter({ terminalId: "adapter-lost-twice" }).adapter;
    const observed: TerminalRendererMode[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));
    const renderer = newestRenderer();

    renderer.loseContext();
    renderer.loseContext();

    expect(observed).toStrictEqual(["webgl", "dom"]);
  });

  it("stops delivering to a subscriber that unsubscribed", () => {
    const adapter = mountedAdapter({ terminalId: "adapter-unsubscribed" }).adapter;
    const observed: TerminalRendererMode[] = [];
    const unsubscribe = adapter.subscribeToRendererMode((mode) => observed.push(mode));

    unsubscribe();
    newestRenderer().loseContext();

    expect(observed).toStrictEqual(["webgl"]);
  });

  it("drops every sink on disposal rather than reporting its own teardown", () => {
    const adapter = mountedAdapter({ terminalId: "adapter-disposed" }).adapter;
    const observed: TerminalRendererMode[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));

    adapter.dispose();

    // The teardown resets the mode, which a subscriber would read as a fallback; it also keeps
    // a throwing sink from aborting the disposal.
    expect(observed).toStrictEqual(["webgl"]);
  });

  it("gives the page's allowance back, because the host destroyed the context", () => {
    const pool = new TerminalRendererPool();
    const mountElement = attachedMountElement();
    const adapter = trackAdapter(
      new XtermTerminalAdapter({ terminalId: "adapter-reclaimed", pool }),
    );
    adapter.attach(mountElement);
    expect(pool.holds("adapter-reclaimed")).toBe(true);

    newestRenderer().loseContext();

    expect(pool.holds("adapter-reclaimed")).toBe(false);
  });

  it("gives it back even when a renderer-mode subscriber throws on the way out", () => {
    // `Emitter` re-raises what a sink threw, so a failing consumer ends the fallback wherever
    // the emission sits. The reclaim must precede it, or the ledger keeps counting a context
    // the host destroyed until reload.
    const pool = new TerminalRendererPool();
    const adapter = trackAdapter(
      new XtermTerminalAdapter({ terminalId: "adapter-throwing-sink", pool }),
    );
    adapter.attach(attachedMountElement());
    // The premise: without a context taken, the reclaim below would hold vacuously.
    expect(pool.holds("adapter-throwing-sink")).toBe(true);
    adapter.subscribeToRendererMode((mode) => {
      if (mode === "dom") {
        throw new Error("a renderer-mode consumer failed");
      }
    });

    // Still raised: the ledger is right before the notification, and the consumer's defect is
    // reported, not swallowed.
    expect(() => {
      newestRenderer().loseContext();
    }).toThrow("a renderer-mode consumer failed");

    expect(pool.holds("adapter-throwing-sink")).toBe(false);
    expect(adapter.rendererMode).toBe("dom");
  });

  it("negative control: a subscriber that returns normally raises nothing", () => {
    // Without it the case above would pass against a fallback that raised on every loss.
    const pool = new TerminalRendererPool();
    const adapter = trackAdapter(
      new XtermTerminalAdapter({ terminalId: "adapter-quiet-sink", pool }),
    );
    adapter.attach(attachedMountElement());
    adapter.subscribeToRendererMode(() => undefined);

    expect(() => {
      newestRenderer().loseContext();
    }).not.toThrow();
    expect(pool.holds("adapter-quiet-sink")).toBe(false);
  });
});

// A lost context is permanent for the life of the instance, and a remount is not a new
// instance. The fallback clears the addon and returns the allowance, which undoes every
// condition the selection tests, so a re-attach would otherwise churn a context per remount.
describe("the adapter, after the context it lost", () => {
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

  it("announces nothing on that attach, because nothing moved", () => {
    const adapter = trackAdapter(
      new XtermTerminalAdapter({
        terminalId: "lost-then-silent",
        pool: new TerminalRendererPool(),
      }),
    );
    adapter.attach(attachedMountElement());
    newestRenderer().loseContext();

    const observed: TerminalRendererMode[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));
    adapter.detach();
    adapter.attach(attachedMountElement());

    // The current mode on subscribe and nothing after it: a second announcement would report a
    // renderer change that did not happen.
    expect(observed).toStrictEqual(["dom"]);
  });

  it("premise: a second attach really does re-enter the renderer selection", () => {
    // Without this the two cases above would hold vacuously against an adapter that never
    // reconsidered its renderer. Refused once, granted after, so the second attach starts with
    // no addon and no loss.
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

describe("the loader is still the real one", () => {
  it("resolves the real adapter class, so the cases above drive the shipped code", async () => {
    const { XtermTerminalAdapter: loaded } = await terminalEmulatorLoader.load();
    expect(loaded).toBe(XtermTerminalAdapter);
  });
});
