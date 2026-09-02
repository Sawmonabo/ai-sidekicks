// The ledger claims its two slots, and mounts through the deck's one door.
//
// The elements are inspected rather than rendered, on `legacy-surfaces.test.ts`'
// reasoning: the claim is about WIRING — which slot, which owner, and what the
// surface hands the pane — and a React element carries all of that before anything
// renders it. What the pane itself draws is that component's own test.
//
// The pane registry read here is the process-wide one, because the surface resolves
// through it deliberately: a pane is mounted through a single door, and a surface
// that imported the body instead would be a second one.

import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ConsoleSurfaceRegistry, type ConsoleSurfaceContext } from "../frame/surface-registry.js";
import { consolePaneRegistry, type ConsolePaneContext } from "../workspace/index.js";
import { registerLedger } from "./index.js";

const PANE_TEST_OWNER = "ledger-test";

/**
 * The four members the surface passes through, and nothing else.
 *
 * Cast rather than constructed, for the reason the legacy suite gives: a real
 * context carries three stores, one of which opens a database on construction, and
 * building all of that to hand four fields to a function that copies four fields
 * would make the setup the subject.
 */
function surfaceContext(): ConsoleSurfaceContext {
  return {
    route: { kind: "workspace", sessionId: "session-7" },
    bridge: { source: "fixture" },
    frameStore: {},
    sessionStore: undefined,
    uiStateStore: {},
    draftStore: {},
  } as unknown as ConsoleSurfaceContext;
}

function registeredLedger(): ConsoleSurfaceRegistry {
  const registry = new ConsoleSurfaceRegistry();
  registerLedger(registry);
  return registry;
}

function renderedElement(node: ReactNode): { type: unknown; props: Record<string, unknown> } {
  if (!isValidElement<Record<string, unknown>>(node)) {
    throw new Error(`expected a React element, got ${String(node)}`);
  }
  return { type: node.type, props: node.props };
}

/** The pane context the surface built, read off the element it produced. */
function paneContextHandedTo(node: ReactNode): ConsolePaneContext {
  const shell = renderedElement(node);
  expect(shell.type).toBe("div");
  expect(shell.props["className"]).toBe("meridian-ledger-surface");
  return shell.props["children"] as ConsolePaneContext;
}

afterEach(() => {
  // The process-wide registry outlives a case, so a claim made here would decide
  // what the next case resolves.
  consolePaneRegistry.unregister("timeline");
});

describe("the ledger — which slots it holds", () => {
  it("claims the workspace surface and the full-screen timeline window, under one owner", () => {
    const registry = registeredLedger();
    const claims = registry
      .registeredSlots()
      .map((slot) => [slot, registry.descriptorFor(slot)?.owner]);
    expect(claims).toStrictEqual([
      ["workspace", "ledger"],
      ["timeline", "ledger"],
    ]);
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    // The case above reads `registeredSlots`, and would pass over a registry that
    // reported slots nobody registered.
    expect(new ConsoleSurfaceRegistry().registeredSlots()).toStrictEqual([]);
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = registeredLedger();
    const afterFirst = registry.registeredSlots();
    registerLedger(registry);
    expect(registry.registeredSlots()).toStrictEqual(afterFirst);
  });
});

describe("the ledger — what it mounts", () => {
  it("mounts the registered timeline pane, at full width", () => {
    // `Spec-023 §Console Design (Meridian)` §4.2's empty-deck state: with no panes
    // open, "the workspace shows the ledger alone, full width".
    consolePaneRegistry.register({
      kind: "timeline",
      owner: PANE_TEST_OWNER,
      render: (context) => context as unknown as ReactNode,
      openInWindow: true,
    });
    const registry = registeredLedger();
    const paneContext = paneContextHandedTo(
      registry.descriptorFor("workspace")?.render(surfaceContext()),
    );
    expect(paneContext.kind).toBe("timeline");
  });

  it("hands the pane a session-scoped address and no actor to attribute it to", () => {
    // Fail-closed, per the seat's own rule: the ring takes an actor's hue only where
    // the pane's entity is a run or an agent, and this timeline is scoped to the
    // session rather than to one of its entities.
    consolePaneRegistry.register({
      kind: "timeline",
      owner: PANE_TEST_OWNER,
      render: (context) => context as unknown as ReactNode,
      openInWindow: true,
    });
    const registry = registeredLedger();
    const paneContext = paneContextHandedTo(
      registry.descriptorFor("timeline")?.render(surfaceContext()),
    );
    expect(paneContext.entity).toBeUndefined();
    expect(paneContext.focusHue).toBeUndefined();
    expect(paneContext.paneId.length).toBeGreaterThan(0);
  });

  it("says the ledger has no body rather than rendering an empty pane", () => {
    // Reserved, not stubbed. Unreachable while the pane seat board composes this
    // family, and asserted anyway: the descriptor is resolved from a registry
    // anything holding it can compose differently.
    const registry = registeredLedger();
    const absence = renderedElement(registry.descriptorFor("workspace")?.render(surfaceContext()));
    const nothing = renderedElement(absence.props["children"] as ReactNode);
    expect(nothing.props["kind"]).toBe("empty");
    expect(nothing.props["placement"]).toBe("surface");
  });
});
