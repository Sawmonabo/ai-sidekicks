// The browser family's registration terms: the deck holds the pane on the terms the
// descriptor states.

import { describe, expect, it } from "vitest";

import { ConsolePaneRegistry } from "../seats/index.js";
import { registerBrowserPanes } from "./index.js";

describe("browser family — claiming the deck's browser pane", () => {
  it("claims the browser kind on terms the deck can hold it by", () => {
    const registry = new ConsolePaneRegistry();
    registerBrowserPanes(registry);
    const descriptor = registry.descriptorFor("browser");
    expect(descriptor?.kind).toBe("browser");
    expect(descriptor?.owner).toBe("browser");
    // Kind and owner are the whole registration: whether the kind may be torn off
    // is the window model's answer, and `seats/pane/pane-kinds.test.ts` holds it.
  });

  it("composes into the registry it is handed, never a module-scope one", () => {
    const claimed = new ConsolePaneRegistry();
    const untouched = new ConsolePaneRegistry();
    registerBrowserPanes(claimed);
    expect(claimed.registeredPaneKinds()).toStrictEqual(["browser"]);
    expect(untouched.registeredPaneKinds()).toStrictEqual([]);
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = new ConsolePaneRegistry();
    expect(() => {
      registerBrowserPanes(registry);
      registerBrowserPanes(registry);
    }).not.toThrow();
  });

  it("negative control: a second owner claiming the kind is refused, not swapped", () => {
    // Without this, every case above would pass over a registry whose duplicate
    // policy was "last writer wins" — and which body mounted would then depend on
    // module evaluation order rather than on anyone's decision.
    const registry = new ConsolePaneRegistry();
    registerBrowserPanes(registry);
    expect(() => {
      registry.register({
        kind: "browser",
        owner: "some-other-family",
        render: () => null,
      });
    }).toThrow();
  });
});
