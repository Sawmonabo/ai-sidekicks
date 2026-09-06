// The ledger claims its two slots, and mounts through the deck's one door.
//
// The elements are inspected rather than rendered, on `legacy-surfaces.test.ts`'
// reasoning: the claim is about WIRING — which slot, which owner, and what the
// surface hands the pane — and a React element carries all of that before anything
// renders it. What the pane itself draws is that component's own test.
//
// The pane board read here is this suite's OWN, because that is what the surface
// resolves through: the board arrives on the surface context, so a case composes one,
// registers into it, and reads back what the surface mounted from it. A pane is still
// mounted through a single door — a surface that imported the body instead would be a
// second one — and a per-case board is what keeps one case's claim out of the next.

import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ConsolePaneRegistry,
  ConsoleSurfaceRegistry,
  type ConsolePaneContext,
  type ConsoleSurfaceContext,
} from "../seats/index.js";
import { registerLedger } from "./index.js";

const PANE_TEST_OWNER = "ledger-test";

/**
 * The board a case composes, replaced before each one so no claim outlives its case.
 *
 * A board of this suite's own rather than the process-wide singleton: the surface
 * resolves the pane through whatever board its context carries, so a case that
 * registered into the singleton would be asserting over a board production also
 * fills — and would have to unregister afterwards to keep the next case honest.
 */
let composedPaneRegistry = new ConsolePaneRegistry();

beforeEach(() => {
  composedPaneRegistry = new ConsolePaneRegistry();
});

/**
 * The members the surface passes through, and nothing else.
 *
 * Cast rather than constructed, for the reason the legacy suite gives: a real
 * context carries three stores, one of which opens a database on construction, and
 * building all of that to hand a handful of fields to a function that copies them
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
    paneRegistry: composedPaneRegistry,
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

/**
 * The workspace body, picked out of the surface's children.
 *
 * The surface mounts TWO things — the resume absence above the room and the workspace
 * itself — so `children` is a list and the body is the last of it. Read by position
 * from the end rather than by index from the start, because the absence renders `null`
 * on every arm but the refused one and a fixed index would read that `null` as the
 * body on exactly the ordinary case.
 */
function workspaceBodyIn(shell: { props: Record<string, unknown> }): {
  type: unknown;
  key: string | null;
  props: Record<string, unknown>;
} {
  const children = shell.props["children"];
  const mounted = Array.isArray(children) ? children : [children];
  return renderedElement(mounted[mounted.length - 1] as ReactNode);
}

/** The pane context the surface built, read off the element it produced. */
function paneContextHandedTo(node: ReactNode): ConsolePaneContext {
  const shell = renderedElement(node);
  expect(shell.type).toBe("div");
  expect(shell.props["className"]).toBe("meridian-ledger-surface");
  return shell.props["children"] as ConsolePaneContext;
}

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
    composedPaneRegistry.register({
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
    const workspace = workspaceBodyIn(shell);
    expect(workspace.type).toBe(TestWorkspaceBody);
    expect(workspace.props["route"]).toStrictEqual({ kind: "workspace", sessionId: "session-7" });
  });

  it("hands the pane a session-scoped address and no actor to attribute it to", () => {
    // Fail-closed, per the seat's own rule: the ring takes an actor's hue only where
    // the pane's entity is a run or an agent, and this timeline is scoped to the
    // session rather than to one of its entities.
    composedPaneRegistry.register({
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
    expect(workspaceBodyIn(shell).key).toBe("session-7");
  });

  it("keys the pane subtree on the route's session, the same way and for the same reason", () => {
    composedPaneRegistry.register({
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
    composedPaneRegistry.register({
      kind: "timeline",
      owner: PANE_TEST_OWNER,
      render: (context) => context as unknown as ReactNode,
    });
    const registry = registeredLedger();
    const descriptor = registry.descriptorFor("timeline");
    const first = renderedElement(descriptor?.render(surfaceContext())).key;
    expect(renderedElement(descriptor?.render(surfaceContext())).key).toBe(first);
    const workspace = registry.descriptorFor("workspace");
    const firstWorkspaceKey = workspaceBodyIn(
      renderedElement(workspace?.render(surfaceContext())),
    ).key;
    expect(workspaceBodyIn(renderedElement(workspace?.render(surfaceContext()))).key).toBe(
      firstWorkspaceKey,
    );
  });

  it("falls back to a named key rather than an absent one when the route names no session", () => {
    const registry = registeredLedger();
    const shell = renderedElement(
      registry.descriptorFor("workspace")?.render({
        ...surfaceContext(),
        route: { kind: "settings" },
      } as unknown as ConsoleSurfaceContext),
    );
    expect(workspaceBodyIn(shell).key).toBe("no-session");
  });
});
