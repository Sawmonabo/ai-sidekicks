// The loader form on the FRAME's board: the same mechanism, keyed by screen name.
//
// Split from `pane-registry.lazy-body.test.tsx` on the boundary the two boards already are. That
// file makes the pane layout's claims — registration shape, reserved chrome, one fetch per
// registration, and survival of the duplicate policy — over `PaneRegistry`; these three make the
// same claims over `ScreenRegistry`, whose key is a screen name rather than a pane kind. Reading
// either half no longer means holding the other's registry.
//
// The loader itself is shared and is therefore not written twice: `countingLoader` lives
// in this directory's fixture module, beside the synthetic contexts both halves take.

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import { countingLoader, createSyntheticScreenContext } from "@test/helpers/lazy-body-contexts.js";
import { listPendingBodyNames } from "@renderer/components/LazyBody/pending-body-marker.js";
import { type ScreenContext } from "./screen-context.js";
import { ScreenRegistry } from "./screen-registry.js";

describe("the frame's board — the same mechanism, keyed by screen name", () => {
  it("registers, mounts an absence frame, then the screen", async () => {
    const registry = new ScreenRegistry();
    registry.register({
      name: "settings",
      owner: "settings",
      body: countingLoader<ScreenContext>(() => createElement("p", null, "the settings screen"))
        .load,
    });
    expect(registry.registeredScreenNames()).toStrictEqual(["settings"]);

    const { container } = render(
      <>{registry.descriptorFor("settings")?.render(createSyntheticScreenContext())}</>,
    );
    expect(container.textContent).not.toContain("the settings screen");
    await settle();
    expect(container.textContent).toContain("the settings screen");
  });

  it("mounts a preloaded screen without ever committing its reserved frame", async () => {
    // The other half of what a preload is FOR. Warming a destination before the route
    // commits only helps if the mount that follows is synchronous, and it was not:
    // `lazy` calls its initializer on the first render and learns the value a microtask
    // later however warm the promise is, so the reserved frame committed for one frame
    // on exactly the path that had done the work to avoid it.
    const registry = new ScreenRegistry();
    registry.register({
      name: "workflows",
      owner: "workflows",
      body: countingLoader<ScreenContext>(() =>
        createElement("p", null, "the workflows destination"),
      ).load,
    });
    await registry.preload("workflows");

    const { container } = render(
      <>{registry.descriptorFor("workflows")?.render(createSyntheticScreenContext())}</>,
    );

    // Read at the FIRST commit, with no settle in between: that is the frame a person
    // would have seen the reserved region in.
    expect(listPendingBodyNames(container)).toStrictEqual([]);
    expect(container.textContent).toContain("the workflows destination");
  });

  it("loads once however many callers ask, and offers the walk only what is unloaded", async () => {
    const registry = new ScreenRegistry();
    const loader = countingLoader<ScreenContext>(() => null);
    registry.register({ name: "settings", owner: "settings", body: loader.load });
    registry.register({ name: "sessions", owner: "sessions", render: () => null });
    expect(registry.unloadedKeys()).toStrictEqual(["settings"]);
    await Promise.all([registry.preload("settings"), registry.preload("settings")]);
    expect(loader.callCount()).toBe(1);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });
});
