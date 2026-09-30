// The preview pane's registration terms: the pane layout holds the pane on the terms the
// descriptor states.

import { describe, expect, it } from "vitest";

import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { registerPreviewPanes } from "./panes.js";

describe("preview — claiming the pane layout's browser pane", () => {
  it("claims the browser kind on terms the pane layout can hold it by", () => {
    const registry = new PaneRegistry();
    registerPreviewPanes(registry);
    const descriptor = registry.descriptorFor("browser");
    expect(descriptor?.kind).toBe("browser");
    expect(descriptor?.owner).toBe("preview");
  });

  it("composes into the registry it is handed, never a module-scope one", () => {
    const claimed = new PaneRegistry();
    const untouched = new PaneRegistry();
    registerPreviewPanes(claimed);
    expect(claimed.registeredPaneKinds()).toStrictEqual(["browser"]);
    expect(untouched.registeredPaneKinds()).toStrictEqual([]);
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = new PaneRegistry();
    expect(() => {
      registerPreviewPanes(registry);
      registerPreviewPanes(registry);
    }).not.toThrow();
  });

  it("negative control: a second owner claiming the kind is refused, not swapped", () => {
    // Without this, every case above would pass over a "last writer wins" registry, and which
    // body mounted would depend on module evaluation order.
    const registry = new PaneRegistry();
    registerPreviewPanes(registry);
    expect(() => {
      registry.register({
        kind: "browser",
        owner: "another-owner",
        render: () => null,
      });
    }).toThrow();
  });
});
