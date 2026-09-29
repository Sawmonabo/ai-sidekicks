// The transcript claims the workspace screen and keys it on the route's session.
//
// The elements are inspected rather than rendered, because the claim is about WIRING
// — which slot, which owner, and what the screen hands its body — and a React element
// carries all of that before anything renders it.

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { PaneRegistry, ScreenRegistry, type ScreenContext } from "@renderer/console/seats/index.js";
import { TranscriptSurface } from "../TranscriptSurface.js";
import { registerTranscriptScreens } from "./screens.js";

/**
 * The members the surface passes through, and nothing else.
 *
 * Cast rather than constructed, for the reason the legacy suite gives: a real
 * context carries three stores, one of which opens a database on construction, and
 * building all of that to hand a handful of fields to a function that copies them
 * would make the setup the subject.
 */
function surfaceContext(sessionId = "session-7"): ScreenContext {
  return {
    route: { kind: "workspace", sessionId },
    bridge: { source: "fixture" },
    frameStore: {},
    sessionStore: undefined,
    uiStateStore: {},
    draftStore: {},
    paneRegistry: new PaneRegistry(),
  } as unknown as ScreenContext;
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

function registeredLedger(): ScreenRegistry {
  const registry = new ScreenRegistry();
  registerTranscriptScreens(registry, { workspace: TestWorkspaceBody });
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

describe("the ledger — which slots it holds", () => {
  it("claims the workspace screen under its owner", () => {
    const registry = registeredLedger();
    const claims = registry
      .registeredSlots()
      .map((slot) => [slot, registry.descriptorFor(slot)?.owner]);
    expect(claims).toStrictEqual([["workspace", "ledger"]]);
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    // The case above reads `registeredSlots`, and would pass over a registry that
    // reported slots nobody registered.
    expect(new ScreenRegistry().registeredSlots()).toStrictEqual([]);
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = registeredLedger();
    const afterFirst = registry.registeredSlots();
    registerTranscriptScreens(registry, { workspace: TestWorkspaceBody });
    expect(registry.registeredSlots()).toStrictEqual(afterFirst);
  });
});

describe("the ledger — what it mounts", () => {
  it("mounts the session workspace — the session header, the deck, and the composer's seat", () => {
    const registry = registeredLedger();
    const shell = renderedElement(registry.descriptorFor("workspace")?.render(surfaceContext()));
    expect(shell.type).toBe(TranscriptSurface);
    const workspace = workspaceBodyIn(shell);
    expect(workspace.type).toBe(TestWorkspaceBody);
    expect(workspace.props["route"]).toStrictEqual({ kind: "workspace", sessionId: "session-7" });
  });
});

describe("the ledger — what decides the mounted subtree's lifetime", () => {
  // The workspace holds per-session state nothing else resets, and the shell deliberately
  // OPENS session stores without closing them on navigation — so moving between two
  // already-open sessions RE-RENDERS this position rather than unmounting it. A key on
  // the route's session is what makes the subtree's lifetime match the thing it holds
  // state about; without it the second session inherits the first's panes, run-group
  // disclosure, reading anchor and retained rows, and nothing says so.
  //
  // Read off the element rather than through a render, on this file's own reasoning:
  // a key is carried by the element, and asserting it here is asserting the wiring.

  it("keys the workspace subtree on the route's session", () => {
    const registry = registeredLedger();
    const shell = renderedElement(registry.descriptorFor("workspace")?.render(surfaceContext()));
    expect(workspaceBodyIn(shell).key).toBe("session-7");
  });

  it("negative control: a re-render of the SAME session keys identically, so it is not a remount", () => {
    // Without this, the case above would pass over a key that changed on every render,
    // which remounts the workspace on every keystroke and loses the state the key
    // exists to scope.
    const registry = registeredLedger();
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
      } as unknown as ScreenContext),
    );
    expect(workspaceBodyIn(shell).key).toBe("no-session");
  });
});
