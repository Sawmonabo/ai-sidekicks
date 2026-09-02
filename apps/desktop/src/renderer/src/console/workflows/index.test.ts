// The family claims exactly the two pane kinds the spec reserves for it.
//
// The registry answers in declaration order rather than registration order, so the
// expected value is a fixed pair and not a set — and it is the whole claim: a family
// that claimed a third kind would be widening a set `Spec-023 §Console Design
// (Meridian)` closes, and one that claimed neither would leave the deck with two
// kinds nothing mounts.

import { describe, expect, it } from "vitest";

import { ConsolePaneRegistry } from "../workspace/index.js";
import { registerWorkflowPanes } from "./index.js";

function registeredWorkflowPanes(): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  registerWorkflowPanes(registry);
  return registry;
}

describe("workflows family — the pane kinds it claims", () => {
  it("claims both workflow kinds and nothing else", () => {
    expect(registeredWorkflowPanes().registeredPaneKinds()).toStrictEqual([
      "workflow-run",
      "workflow-builder",
    ]);
  });

  it("claims both under one owner, so a hot reload replaces rather than conflicts", () => {
    const registry = registeredWorkflowPanes();
    const owners = registry
      .registeredPaneKinds()
      .map((kind) => registry.descriptorFor(kind)?.owner);
    expect(new Set(owners).size).toBe(1);
    expect(() => {
      registerWorkflowPanes(registry);
    }).not.toThrow();
  });

  it("opens neither kind in an auxiliary window", () => {
    // The spec ships exactly two auxiliary windows and neither is a workflow pane,
    // so a `true` here would be a detach into a window that does not exist.
    const registry = registeredWorkflowPanes();
    expect(
      registry.registeredPaneKinds().map((kind) => registry.descriptorFor(kind)?.openInWindow),
    ).toStrictEqual([false, false]);
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    // Every case above reads the registry back, and all of them would pass over a
    // registry that reported kinds nobody registered.
    expect(new ConsolePaneRegistry().registeredPaneKinds()).toStrictEqual([]);
  });
});
