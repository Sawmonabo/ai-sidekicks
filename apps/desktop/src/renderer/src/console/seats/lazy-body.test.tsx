// The loader form, on both boards: what registers, what mounts, and what is fetched once.
//
// The claims here are the ones the whole boundary rests on, and every one of them is a
// claim about a SEAM rather than about a family: a body registered as a loader produces
// the same resolved descriptor a component-form body does, the pane reserves its own
// chrome while the module is in flight, and the module is fetched exactly once however
// many callers ask for it. A family conversion that got any of these wrong would show up
// as a blank pane or a double fetch, both of which are invisible in a screenshot of a
// warm window.
//
// SYNTHETIC BODIES, DELIBERATELY. Loading a real family's body here would make the case
// depend on that family's bridge reads and its scenario, and would say nothing more
// about the registry than a two-line module does. What the loaders below stand in for is
// the `import()` a family writes; what matters is that the board treats the promise the
// same way whatever is behind it.

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { settle } from "../core/settle.test-support.js";
import { DuplicateRegistrationError } from "../core/keyed-registry.js";
import { ConsolePaneChrome } from "./ConsolePaneChrome.js";
import { type LazyBodyModule } from "./lazy-body.js";
import { syntheticPaneContextAt, syntheticSurfaceContext } from "./lazy-body.test-support.js";
import { type ConsolePaneContext } from "./pane-context.js";
import { ConsolePaneRegistry } from "./pane-registry.js";
import { pendingPaneKindsIn } from "./pending-pane-body.js";
import { type ConsoleSurfaceContext } from "./surface-context.js";
import { ConsoleSurfaceRegistry } from "./surface-registry.js";

/**
 * A loader whose module is written here, and a count of how often it was called.
 *
 * The count is the whole instrument for the memo claims: a registry that resolved the
 * module correctly and fetched it once per caller would satisfy every rendering
 * assertion in this file and still pay for the chunk on every arrow-key press.
 */
function countingLoader<TContext extends object>(
  Body: (context: TContext) => React.ReactNode,
): { readonly load: () => Promise<LazyBodyModule<TContext>>; readonly callCount: () => number } {
  let callCount = 0;
  return {
    load: () => {
      callCount += 1;
      return Promise.resolve({ Body });
    },
    callCount: () => callCount,
  };
}

/** A pane body of the shape a converted family ships: its own chrome around its content. */
function chromedBody(
  kind: ConsolePaneContext["kind"],
  text: string,
): (context: ConsolePaneContext) => React.ReactNode {
  return (context: ConsolePaneContext): React.ReactNode =>
    createElement(ConsolePaneChrome, {
      kind,
      sessionId: undefined,
      focusHue: context.focusHue,
      children: createElement("p", null, text),
    });
}

describe("the deck's board — a loader-form registration", () => {
  it("resolves to the same descriptor shape a component form does", () => {
    const registry = new ConsolePaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos-family",
      body: countingLoader(() => null).load,
    });
    registry.register({ kind: "timeline", owner: "workspace-family", render: () => null });
    // Nothing downstream of `descriptorFor` branches on how the body was registered, so
    // the two forms have to be indistinguishable HERE or every mount site learns to ask.
    expect(registry.registeredPaneKinds()).toStrictEqual(["timeline", "diff"]);
    expect(registry.descriptorFor("diff")?.owner).toBe("repos-family");
    expect(typeof registry.descriptorFor("diff")?.render).toBe("function");
  });

  it("mounts the pane's own chrome first, then the body", async () => {
    const registry = new ConsolePaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos-family",
      body: countingLoader(chromedBody("diff", "the diff body")).load,
    });
    const context = syntheticPaneContextAt("diff");
    const { container } = render(<>{registry.descriptorFor("diff")?.render(context)}</>);

    // Before: the chrome is painted and the body is not, and the pane says which body it
    // is waiting for.
    expect(pendingPaneKindsIn(container)).toStrictEqual(["diff"]);
    expect(container.textContent).not.toContain("the diff body");
    expect(container.querySelectorAll(".meridian-pane")).toHaveLength(1);

    await settle();

    // After: the body is there and the marker is gone, so a capture taken now is a
    // picture of the pane rather than of its reserved region.
    expect(container.textContent).toContain("the diff body");
    expect(pendingPaneKindsIn(container)).toStrictEqual([]);
  });

  it("reserves the same box the loaded body draws", async () => {
    const registry = new ConsolePaneRegistry();
    registry.register({
      kind: "artifact",
      owner: "repos-family",
      body: countingLoader(chromedBody("artifact", "the artifact body")).load,
    });
    const { container } = render(
      <>{registry.descriptorFor("artifact")?.render(syntheticPaneContextAt("artifact"))}</>,
    );

    const pendingSection = container.querySelector(".meridian-pane");
    const pendingHeadText = container.querySelector(".meridian-pane__head")?.textContent;
    const pendingBodyText = container.querySelector(".meridian-pane__body")?.textContent;
    expect(pendingSection?.className).toBe("meridian-pane meridian-pane--artifact");
    // The reserved body is EMPTY rather than a spinner or a skeleton: the marker rides a
    // `hidden` element, which contributes no box, so nothing moves when the body lands.
    expect(pendingBodyText).toBe("");

    await settle();

    const loadedSection = container.querySelector(".meridian-pane");
    expect(loadedSection?.className).toBe(pendingSection?.className);
    expect(container.querySelector(".meridian-pane__head")?.textContent).toBe(pendingHeadText);
    expect(container.querySelectorAll(".meridian-pane__body")).toHaveLength(1);
    expect(container.querySelector(".meridian-pane__body")?.textContent).toBe("the artifact body");
  });

  it("negative control: a body that never arrives never replaces the reserved region", async () => {
    // Without this, "renders the fallback then the body" would also be satisfied by a
    // host that rendered the body immediately and the fallback never — and the marker
    // the screenshot tier refuses on would then never appear at all.
    const registry = new ConsolePaneRegistry();
    registry.register({
      kind: "browser",
      owner: "browser-terminal-family",
      body: () => new Promise<LazyBodyModule<ConsolePaneContext>>(() => undefined),
    });
    const { container } = render(
      <>{registry.descriptorFor("browser")?.render(syntheticPaneContextAt("browser"))}</>,
    );
    await settle();
    expect(pendingPaneKindsIn(container)).toStrictEqual(["browser"]);
  });
});

describe("the deck's board — one fetch per registration", () => {
  it("mounts a preloaded body without ever committing the pending marker", async () => {
    // The pane board's half of the same claim, and the one the screenshot tier depends
    // on: a mount that begins after a completed preload must not photograph the marker.
    const registry = new ConsolePaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos-family",
      body: countingLoader(chromedBody("diff", "the diff body")).load,
    });
    await registry.preload("diff");

    const { container } = render(
      <>{registry.descriptorFor("diff")?.render(syntheticPaneContextAt("diff"))}</>,
    );

    expect(pendingPaneKindsIn(container)).toStrictEqual([]);
    expect(container.textContent).toContain("the diff body");
  });

  it("keeps the loader when a different owner's claim is refused", async () => {
    // The refusal path, from the side nothing was watching. `register` used to drop the
    // loader entry BEFORE the keyed registry got a chance to refuse, so a rejected
    // component-form claim by a second owner threw with the first owner's descriptor
    // still admitted and its loader gone: the pane stayed mounted and stopped being
    // warmable, with no error naming why.
    const registry = new ConsolePaneRegistry();
    const loader = countingLoader(chromedBody("diff", "the diff body"));
    registry.register({ kind: "diff", owner: "repos-family", body: loader.load });
    expect(registry.unloadedKeys()).toStrictEqual(["diff"]);

    expect(() => {
      registry.register({ kind: "diff", owner: "a-different-family", render: () => null });
    }).toThrow(DuplicateRegistrationError);

    expect(registry.unloadedKeys()).toStrictEqual(["diff"]);
    await registry.preload("diff");
    expect(loader.callCount()).toBe(1);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("loads once however many callers ask", async () => {
    const registry = new ConsolePaneRegistry();
    const loader = countingLoader<ConsolePaneContext>(() => null);
    registry.register({ kind: "diff", owner: "repos-family", body: loader.load });

    // The palette highlighting an entry, an address about to open, and the idle warm all
    // reach the same registration, and two of them race by construction.
    await Promise.all([
      registry.preload("diff"),
      registry.preload("diff"),
      registry.preload("diff"),
    ]);
    await registry.preload("diff");
    expect(loader.callCount()).toBe(1);
  });

  it("does not re-fetch when the pane then mounts", async () => {
    const registry = new ConsolePaneRegistry();
    const loader = countingLoader(chromedBody("diff", "the diff body"));
    registry.register({ kind: "diff", owner: "repos-family", body: loader.load });

    await registry.preload("diff");
    const { container } = render(
      <>{registry.descriptorFor("diff")?.render(syntheticPaneContextAt("diff"))}</>,
    );
    await settle();
    expect(container.textContent).toContain("the diff body");
    expect(loader.callCount()).toBe(1);
  });

  it("keeps one component identity across renders, so a mounted body is not rebuilt", () => {
    // A `lazy()` minted per render is a new component TYPE, and React unmounts and
    // remounts a body whose type changed — which would throw away the pane's scroll
    // position and every piece of state inside it on any host re-render.
    const registry = new ConsolePaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos-family",
      body: countingLoader<ConsolePaneContext>(() => null).load,
    });
    const descriptor = registry.descriptorFor("diff");
    const first = descriptor?.render(syntheticPaneContextAt("diff")) as React.ReactElement<{
      readonly Body: unknown;
    }>;
    const second = descriptor?.render(syntheticPaneContextAt("diff")) as React.ReactElement<{
      readonly Body: unknown;
    }>;
    expect(second.props.Body).toBe(first.props.Body);
  });

  it("settles with nothing to do for a component form and for an unclaimed kind", async () => {
    // A caller preloading an address it has not opened must not have to ask first
    // whether the kind is loader-backed, or every call site carries that question.
    const registry = new ConsolePaneRegistry();
    registry.register({ kind: "timeline", owner: "workspace-family", render: () => null });
    await expect(registry.preload("timeline")).resolves.toBeUndefined();
    await expect(registry.preload("workflow-builder")).resolves.toBeUndefined();
  });
});

describe("the deck's board — what the warm walk is offered", () => {
  it("reports unloaded loader-backed kinds in declaration order", () => {
    const registry = new ConsolePaneRegistry();
    // Registered back to front, and with a component form among them, so an
    // implementation reporting insertion order or reporting every registered kind would
    // answer differently.
    registry.register({
      kind: "agent-console",
      owner: "agents-family",
      body: countingLoader<ConsolePaneContext>(() => null).load,
    });
    registry.register({ kind: "timeline", owner: "workspace-family", render: () => null });
    registry.register({
      kind: "diff",
      owner: "repos-family",
      body: countingLoader<ConsolePaneContext>(() => null).load,
    });
    expect(registry.unloadedKeys()).toStrictEqual(["diff", "agent-console"]);
  });

  it("drops a kind from the walk once its body is asked for", async () => {
    const registry = new ConsolePaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos-family",
      body: countingLoader<ConsolePaneContext>(() => null).load,
    });
    await registry.preload("diff");
    // Read the memo rather than the settled value: a walk that re-entered a resolved
    // registration would loop over a board it had already warmed.
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("negative control: a board of component-form bodies offers the walk nothing", () => {
    const registry = new ConsolePaneRegistry();
    registry.register({ kind: "timeline", owner: "workspace-family", render: () => null });
    expect(registry.registeredPaneKinds()).toStrictEqual(["timeline"]);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });
});

describe("the deck's board — a loader survives the duplicate policy", () => {
  it("leaves no loader behind when a second owner is refused", async () => {
    const registry = new ConsolePaneRegistry();
    const admitted = countingLoader<ConsolePaneContext>(() => null);
    const refused = countingLoader<ConsolePaneContext>(() => null);
    registry.register({ kind: "diff", owner: "repos-family", body: admitted.load });
    expect(() => {
      registry.register({ kind: "diff", owner: "another-family", body: refused.load });
    }).toThrow(DuplicateRegistrationError);

    // The refusal throws before the loader table is written, so the kind still loads the
    // body whose descriptor is mounted — a stray loader here would fetch one module and
    // render another.
    await registry.preload("diff");
    expect(admitted.callCount()).toBe(1);
    expect(refused.callCount()).toBe(0);
  });

  it("replaces the loader when the same owner re-claims", async () => {
    // A hot reload re-runs a family's module. Keeping the first loader would leave the
    // deck fetching the pre-edit chunk, which reads as an edit that did nothing.
    const registry = new ConsolePaneRegistry();
    const beforeEdit = countingLoader<ConsolePaneContext>(() => null);
    const afterEdit = countingLoader<ConsolePaneContext>(() => null);
    registry.register({ kind: "diff", owner: "repos-family", body: beforeEdit.load });
    registry.register({ kind: "diff", owner: "repos-family", body: afterEdit.load });
    await registry.preload("diff");
    expect(afterEdit.callCount()).toBe(1);
    expect(beforeEdit.callCount()).toBe(0);
  });

  it("mounts the re-claimed body, not the one the host was already rendering", async () => {
    // THE HALF THE REGISTRY CLAIM ABOVE CANNOT MAKE. The board really does replace the
    // loader — and the host went on rendering the first body anyway. `LazyBody` pins its
    // arm in a `useState` initializer, the element type and its position do not change
    // across a re-registration, so React keeps the instance and the initializer never
    // runs again: the pin held a `lazy()` over a loader nothing would call. A hot reload
    // then read as an edit that did nothing, which is exactly the failure the registry's
    // replacement was written to prevent.
    //
    // Driven through ONE host re-rendered, rather than two renders, because rendering
    // twice would mount a fresh `LazyBody` each time and pass over a stale pin.
    const registry = new ConsolePaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos-family",
      body: countingLoader(chromedBody("diff", "the body before the edit")).load,
    });

    function Host(): React.ReactNode {
      return <>{registry.descriptorFor("diff")?.render(syntheticPaneContextAt("diff"))}</>;
    }

    const { container, rerender } = render(<Host />);
    await settle();
    expect(container.textContent).toContain("the body before the edit");

    registry.register({
      kind: "diff",
      owner: "repos-family",
      body: countingLoader(chromedBody("diff", "the body after the edit")).load,
    });
    rerender(<Host />);
    await settle();

    expect(container.textContent).toContain("the body after the edit");
    expect(container.textContent).not.toContain("the body before the edit");
  });

  it("forgets the loader once the kind is released", async () => {
    const registry = new ConsolePaneRegistry();
    const loader = countingLoader<ConsolePaneContext>(() => null);
    registry.register({ kind: "diff", owner: "repos-family", body: loader.load });
    registry.unregister("diff");
    await registry.preload("diff");
    expect(loader.callCount()).toBe(0);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("replaces a component form with a loader form, and back", async () => {
    const registry = new ConsolePaneRegistry();
    const loader = countingLoader<ConsolePaneContext>(() => null);
    registry.register({ kind: "diff", owner: "repos-family", render: () => null });
    registry.register({ kind: "diff", owner: "repos-family", body: loader.load });
    expect(registry.unloadedKeys()).toStrictEqual(["diff"]);
    registry.register({ kind: "diff", owner: "repos-family", render: () => null });
    // The loader is dropped rather than left resolvable beside a descriptor that no
    // longer mounts it: a `preload` answering from a stale table would fetch a chunk
    // nothing renders.
    expect(registry.unloadedKeys()).toStrictEqual([]);
    await registry.preload("diff");
    expect(loader.callCount()).toBe(0);
  });
});

describe("the frame's board — the same mechanism, keyed by slot", () => {
  it("registers, mounts an absence frame, then the surface", async () => {
    const registry = new ConsoleSurfaceRegistry();
    registry.register({
      slot: "settings",
      owner: "settings-family",
      body: countingLoader<ConsoleSurfaceContext>(() =>
        createElement("p", null, "the settings surface"),
      ).load,
    });
    expect(registry.registeredSlots()).toStrictEqual(["settings"]);

    const { container } = render(
      <>{registry.descriptorFor("settings")?.render(syntheticSurfaceContext())}</>,
    );
    expect(container.textContent).not.toContain("the settings surface");
    await settle();
    expect(container.textContent).toContain("the settings surface");
  });

  it("mounts a preloaded surface without ever committing its reserved frame", async () => {
    // The other half of what a preload is FOR. Warming a destination before the route
    // commits only helps if the mount that follows is synchronous, and it was not:
    // `lazy` calls its initializer on the first render and learns the value a microtask
    // later however warm the promise is, so the reserved frame committed for one frame
    // on exactly the path that had done the work to avoid it.
    const registry = new ConsoleSurfaceRegistry();
    registry.register({
      slot: "workflows",
      owner: "workflows-family",
      body: countingLoader<ConsoleSurfaceContext>(() =>
        createElement("p", null, "the workflows destination"),
      ).load,
    });
    await registry.preload("workflows");

    const { container } = render(
      <>{registry.descriptorFor("workflows")?.render(syntheticSurfaceContext())}</>,
    );

    // Read at the FIRST commit, with no settle in between: that is the frame a person
    // would have seen the reserved region in.
    expect(pendingPaneKindsIn(container)).toStrictEqual([]);
    expect(container.textContent).toContain("the workflows destination");
  });

  it("loads once however many callers ask, and offers the walk only what is unloaded", async () => {
    const registry = new ConsoleSurfaceRegistry();
    const loader = countingLoader<ConsoleSurfaceContext>(() => null);
    registry.register({ slot: "settings", owner: "settings-family", body: loader.load });
    registry.register({ slot: "sessions", owner: "sessions-family", render: () => null });
    expect(registry.unloadedKeys()).toStrictEqual(["settings"]);
    await Promise.all([registry.preload("settings"), registry.preload("settings")]);
    expect(loader.callCount()).toBe(1);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });
});
