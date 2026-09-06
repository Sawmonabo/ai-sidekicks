// The GPU takes the context away, and the adapter finds out.
//
// The one renderer path this environment cannot reach on its own — see
// `webgl-fallback.test-support.ts` for what is stood in and why these cases are not a
// block inside `xterm-adapter.test.ts`.
//
// Two halves. The fallback itself: the mode moves once, the subscribers hear it once,
// the page's allowance goes back because the host destroyed the context, and it goes
// back even when a subscriber throws on the way out — the ledger is right BEFORE the
// notification rather than instead of it. And the fallback's permanence: a lost context
// is permanent for the LIFE OF THE INSTANCE, so an adapter a pane detaches and
// re-attaches somewhere else does not walk back onto the renderer it was just told it
// cannot have.

import { afterEach, describe, expect, it, vi } from "vitest";

import { terminalEmulatorLoader } from "./emulator-loader.js";
import { TerminalRendererPool } from "./renderer-pool.js";
import { XtermTerminalAdapter, type TerminalRendererMode } from "./xterm-adapter.js";
import {
  attachedHost,
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
    // The premise every case below rests on. Without it they would all be
    // asserting a fallback from `dom` to `dom`.
    expect(mountedAdapter({ terminalId: "adapter-took-one" }).adapter.rendererMode).toBe("webgl");
  });

  it("tells a subscriber that it fell back, once, with the mode it fell back to", () => {
    const adapter = mountedAdapter({ terminalId: "adapter-fell-back" }).adapter;
    const observed: TerminalRendererMode[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));

    newestRenderer().loseContext();

    // The current mode on subscribe, then the change. A consumer that had copied
    // the first would still be reporting `webgl` at this point.
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

    // The teardown resets the mode, and a subscriber told about that would read it
    // as a fallback. It is also what keeps a throwing sink from aborting a
    // disposal between the pool release and the emulator's own.
    expect(observed).toStrictEqual(["webgl"]);
  });

  it("gives the page's allowance back, because the host destroyed the context", () => {
    const pool = new TerminalRendererPool();
    const host = attachedHost();
    const adapter = trackAdapter(
      new XtermTerminalAdapter({ terminalId: "adapter-reclaimed", pool }),
    );
    adapter.attach(host);
    expect(pool.holds("adapter-reclaimed")).toBe(true);

    newestRenderer().loseContext();

    expect(pool.holds("adapter-reclaimed")).toBe(false);
  });

  it("gives it back even when a renderer-mode subscriber throws on the way out", () => {
    // The finding. `Emitter` re-raises what a sink threw, so a consumer that fails
    // ends the fallback wherever the emission sits — and with the reclaim after it,
    // the addon was already disposed and the instance already permanently on the DOM
    // renderer while the page-wide ledger went on counting a context the host had
    // destroyed. Nothing gives that allowance back before a reload.
    const pool = new TerminalRendererPool();
    const adapter = trackAdapter(
      new XtermTerminalAdapter({ terminalId: "adapter-throwing-sink", pool }),
    );
    adapter.attach(attachedHost());
    // The premise: without a context taken, the reclaim below would hold vacuously.
    expect(pool.holds("adapter-throwing-sink")).toBe(true);
    adapter.subscribeToRendererMode((mode) => {
      if (mode === "dom") {
        throw new Error("a renderer-mode consumer failed");
      }
    });

    // Still raised, because the ledger is right before the notification rather than
    // instead of it: this path reports the consumer's defect, it does not swallow it.
    expect(() => {
      newestRenderer().loseContext();
    }).toThrow("a renderer-mode consumer failed");

    expect(pool.holds("adapter-throwing-sink")).toBe(false);
    expect(adapter.rendererMode).toBe("dom");
  });

  it("negative control: a subscriber that returns normally raises nothing", () => {
    // Without it the case above would pass against a fallback that raised on every
    // context loss, which would make the assertion about the emitter rather than
    // about the sink.
    const pool = new TerminalRendererPool();
    const adapter = trackAdapter(
      new XtermTerminalAdapter({ terminalId: "adapter-quiet-sink", pool }),
    );
    adapter.attach(attachedHost());
    adapter.subscribeToRendererMode(() => undefined);

    expect(() => {
      newestRenderer().loseContext();
    }).not.toThrow();
    expect(pool.holds("adapter-quiet-sink")).toBe(false);
  });
});

// A lost context is permanent for the LIFE OF THE INSTANCE, and a remount is not a
// new instance.
//
// The fallback clears the addon and hands the page's allowance back — both correct,
// and between them they undo every condition the renderer selection tests. So an
// adapter that a pane detaches and re-attaches to a different host would have walked
// straight back onto the renderer it had just been told it cannot have, and churned a
// context per remount for as long as the pane was moved around.
describe("the adapter, after the context it lost", () => {
  it("does not take a second one when it is attached somewhere else", () => {
    const pool = new TerminalRendererPool();
    const adapter = trackAdapter(new XtermTerminalAdapter({ terminalId: "lost-then-moved", pool }));
    adapter.attach(attachedHost());
    expect(adapter.rendererMode).toBe("webgl");

    newestRenderer().loseContext();
    adapter.detach();
    adapter.attach(attachedHost());

    expect(adapter.rendererMode).toBe("dom");
    // One renderer for the whole life of this adapter — the one it lost.
    expect(FakeWebglRenderer.live).toHaveLength(1);
    // And the page's allowance stays where the fallback put it: the reclaim is
    // right, and re-spending it on the same terminal is what this stops.
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
    adapter.attach(attachedHost());
    newestRenderer().loseContext();

    const observed: TerminalRendererMode[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));
    adapter.detach();
    adapter.attach(attachedHost());

    // The current mode on subscribe and nothing after it. A surface that heard a
    // second announcement here would be hearing a renderer change that did not
    // happen — and against the old adapter it was `webgl`, which did.
    expect(observed).toStrictEqual(["dom"]);
  });

  it("premise: a second attach really does re-enter the renderer selection", () => {
    // Without this the two cases above would hold vacuously against an adapter that
    // never reconsidered its renderer at all. Refused once and granted after, so the
    // instance reaches the second attach with no addon and no loss — the one state
    // in which taking a context is correct.
    const adapter = trackAdapter(
      new XtermTerminalAdapter({
        terminalId: "refused-then-granted",
        pool: new LateGrantingRendererPool(1),
      }),
    );
    adapter.attach(attachedHost());
    expect(adapter.rendererMode).toBe("dom");
    expect(FakeWebglRenderer.live).toHaveLength(0);

    adapter.detach();
    adapter.attach(attachedHost());

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
