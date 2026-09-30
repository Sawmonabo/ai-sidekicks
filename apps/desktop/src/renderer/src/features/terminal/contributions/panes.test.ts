// The terminal feature's registration terms.

import { describe, expect, it } from "vitest";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { registerTerminalPane } from "./panes.js";

describe("terminal feature — claiming the pane layout's terminal pane", () => {
  it("claims the terminal kind on terms the pane layout can hold it by", () => {
    const registry = new PaneRegistry();
    registerTerminalPane(registry);
    const descriptor = registry.descriptorFor("terminal");
    expect(descriptor?.kind).toBe("terminal");
    expect(descriptor?.owner).toBe("terminal");
    // Kind and owner are the whole registration: whether the kind may be torn off
    // is the window model's answer, and `routing/panes/pane-kinds.test.ts` holds it.
  });

  it("claims the terminal kind and no other", () => {
    const registry = new PaneRegistry();
    registerTerminalPane(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual(["terminal"]);
  });

  it("negative control: a second owner claiming the kind is refused, not swapped", () => {
    const registry = new PaneRegistry();
    registerTerminalPane(registry);
    expect(() => {
      registry.register({
        kind: "terminal",
        owner: "another-owner",
        render: () => null,
      });
    }).toThrow();
  });
});
