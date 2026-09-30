// The loader form on the screen registry, keyed by screen name: the same claims as
// `pane-registry.lazy-body.test.tsx` made over `ScreenRegistry`. The shared `countingLoader` and
// synthetic contexts live in `tests/helpers/lazy-body-contexts.ts`.

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
    // Warming only helps if the mount is synchronous, but `lazy` learns the value a microtask
    // later however warm the promise is, which would commit the reserved frame for one frame.
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

    // Read at the first commit, with no settle in between.
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
