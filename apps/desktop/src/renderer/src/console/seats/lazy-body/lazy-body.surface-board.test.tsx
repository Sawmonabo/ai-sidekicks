// The loader form on the FRAME's board: the same mechanism, keyed by slot.
//
// Split from `lazy-body.test.tsx` on the boundary the two boards already are. That file
// makes the deck's claims — registration shape, reserved chrome, one fetch per
// registration, and survival of the duplicate policy — over `ConsolePaneRegistry`; these
// three make the same claims over `ConsoleSurfaceRegistry`, whose key is a slot rather
// than a pane kind. Reading either half no longer means holding the other's registry.
//
// The loader itself is shared and is therefore not written twice: `countingLoader` lives
// in this directory's fixture module, beside the synthetic contexts both halves take.

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { settle } from "../../core/settle.test-support.js";
import { countingLoader, syntheticSurfaceContext } from "./lazy-body.test-support.js";
import { pendingPaneKindsIn } from "../pane/pending-pane-body.js";
import { type ConsoleSurfaceContext } from "../surface/surface-context.js";
import { ConsoleSurfaceRegistry } from "../surface/surface-registry.js";

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
