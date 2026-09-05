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
import { consolePaneRegistry, type ConsolePaneContext } from "../seats/index.js";
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
function surfaceContext(sessionId = "session-7"): ConsoleSurfaceContext {
  return {
    route: { kind: "workspace", sessionId },
    bridge: { source: "fixture" },
    frameStore: {},
    sessionStore: undefined,
    uiStateStore: {},
    draftStore: {},
  } as unknown as ConsoleSurfaceContext;
}

/**
 * The workspace body the composition root names, stood in for by a marker.
 *
 * A component rather than the real `Workspace`: what these cases check is the WIRING
 * — which slot, which owner, and what the surface hands the body — and the real
 * workspace opens stores to render. Its identity is asserted below, so a slot that
 * mounted something else would fail here rather than render a plausible frame.
 */
function TestWorkspaceBody(): null {
  return null;
}

function registeredLedger(): ConsoleSurfaceRegistry {
  const registry = new ConsoleSurfaceRegistry();
  registerLedger(registry, { workspace: TestWorkspaceBody });
  return registry;
}

function renderedElement(node: ReactNode): {
  type: unknown;
  key: string | null;
  props: Record<string, unknown>;
} {
  if (!isValidElement<Record<string, unknown>>(node)) {
    throw new Error(`expected a React element, got ${String(node)}`);
  }
  return { type: node.type, key: node.key, props: node.props };
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
    registerLedger(registry, { workspace: TestWorkspaceBody });
    expect(registry.registeredSlots()).toStrictEqual(afterFirst);
  });
});

describe("the ledger — what it mounts", () => {
  it("mounts the registered timeline pane in the full-screen window, at full width", () => {
    // `Spec-023 §The surface set`: an auxiliary window loads "the same renderer
    // bundle at a window route" for one moved pane, so this slot mounts the pane
    // ALONE — no deck around it and no composer.
    consolePaneRegistry.register({
      kind: "timeline",
      owner: PANE_TEST_OWNER,
      render: (context) => context as unknown as ReactNode,
    });
    const registry = registeredLedger();
    const paneContext = paneContextHandedTo(
      registry.descriptorFor("timeline")?.render(surfaceContext()),
    );
    expect(paneContext.kind).toBe("timeline");
  });

  it("mounts the session workspace — the cast bar, the deck, and the composer's seat", () => {
    // The two slots stopped mounting the same thing when the deck landed: the
    // session surface is the workspace, and the pane alone is the window.
    const registry = registeredLedger();
    const shell = renderedElement(registry.descriptorFor("workspace")?.render(surfaceContext()));
    expect(shell.props["className"]).toBe("meridian-ledger-surface");
    const workspace = renderedElement(shell.props["children"] as ReactNode);
    expect(workspace.type).toBe(TestWorkspaceBody);
    expect(workspace.props["route"]).toStrictEqual({ kind: "workspace", sessionId: "session-7" });
  });

  it("hands the pane a session-scoped address and no actor to attribute it to", () => {
    // Fail-closed, per the seat's own rule: the ring takes an actor's hue only where
    // the pane's entity is a run or an agent, and this timeline is scoped to the
    // session rather than to one of its entities.
    consolePaneRegistry.register({
      kind: "timeline",
      owner: PANE_TEST_OWNER,
      render: (context) => context as unknown as ReactNode,
    });
    const registry = registeredLedger();
    const paneContext = paneContextHandedTo(
      registry.descriptorFor("timeline")?.render(surfaceContext()),
    );
    expect(paneContext).not.toHaveProperty("entity");
    expect(paneContext.focusHue).toBeUndefined();
    expect(paneContext.paneId.length).toBeGreaterThan(0);
  });

  it("says the ledger has no body rather than rendering an empty pane", () => {
    // Reserved, not stubbed. Unreachable while the pane seat board composes this
    // family, and asserted anyway: the descriptor is resolved from a registry
    // anything holding it can compose differently.
    const registry = registeredLedger();
    const absence = renderedElement(registry.descriptorFor("timeline")?.render(surfaceContext()));
    const nothing = renderedElement(absence.props["children"] as ReactNode);
    expect(nothing.props["kind"]).toBe("empty");
    expect(nothing.props["placement"]).toBe("surface");
  });
});

describe("the ledger — what decides the mounted subtree's lifetime", () => {
  // Both slots hold per-session state nothing else resets, and the shell deliberately
  // OPENS session stores without closing them on navigation — so moving between two
  // already-open sessions RE-RENDERS these positions rather than unmounting them. A key
  // on the route's session is what makes each subtree's lifetime match the thing it
  // holds state about; without it the second session inherits the first's panes,
  // windows, chapter disclosure, reading anchor, and row leases, and nothing says so.
  //
  // Read off the element rather than through a render, on this file's own reasoning:
  // a key is carried by the element, and asserting it here is asserting the wiring.

  it("keys the workspace subtree on the route's session", () => {
    const registry = registeredLedger();
    const shell = renderedElement(registry.descriptorFor("workspace")?.render(surfaceContext()));
    expect(renderedElement(shell.props["children"] as ReactNode).key).toBe("session-7");
  });

  it("keys the pane subtree on the route's session, the same way and for the same reason", () => {
    consolePaneRegistry.register({
      kind: "timeline",
      owner: PANE_TEST_OWNER,
      render: (context) => context as unknown as ReactNode,
    });
    const registry = registeredLedger();
    const descriptor = registry.descriptorFor("timeline");
    expect(renderedElement(descriptor?.render(surfaceContext())).key).toBe("session-7");
    expect(renderedElement(descriptor?.render(surfaceContext("session-8"))).key).toBe("session-8");
  });

  it("negative control: a re-render of the SAME session keys identically, so it is not a remount", () => {
    // Without this, both cases above would pass over a key that changed on every
    // render — which remounts the ledger on every keystroke and loses the very state
    // the key exists to scope.
    consolePaneRegistry.register({
      kind: "timeline",
      owner: PANE_TEST_OWNER,
      render: (context) => context as unknown as ReactNode,
    });
    const registry = registeredLedger();
    const descriptor = registry.descriptorFor("timeline");
    const first = renderedElement(descriptor?.render(surfaceContext())).key;
    expect(renderedElement(descriptor?.render(surfaceContext())).key).toBe(first);
    const workspace = registry.descriptorFor("workspace");
    const firstWorkspaceKey = renderedElement(
      renderedElement(workspace?.render(surfaceContext())).props["children"] as ReactNode,
    ).key;
    expect(
      renderedElement(
        renderedElement(workspace?.render(surfaceContext())).props["children"] as ReactNode,
      ).key,
    ).toBe(firstWorkspaceKey);
  });

  it("falls back to a named key rather than an absent one when the route names no session", () => {
    const registry = registeredLedger();
    const shell = renderedElement(
      registry.descriptorFor("workspace")?.render({
        ...surfaceContext(),
        route: { kind: "settings" },
      } as unknown as ConsoleSurfaceContext),
    );
    expect(renderedElement(shell.props["children"] as ReactNode).key).toBe("no-session");
  });
});
