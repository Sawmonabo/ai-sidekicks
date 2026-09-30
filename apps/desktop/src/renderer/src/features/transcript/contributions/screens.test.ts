// The transcript claims the session screen and keys it on the route's session. Elements are
// inspected rather than rendered because the claim is wiring, which an element carries.

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { SessionScreenContainer } from "../SessionScreenContainer.js";
import { registerTranscriptScreens } from "./screens.js";

/**
 * The members the session screen passes through, cast rather than constructed: a real context
 * carries three stores, one of which opens a database on construction.
 */
function screenContext(sessionId = "session-7"): ScreenContext {
  return {
    route: { kind: "session", sessionId },
    bridge: { source: "fixture" },
    frameStore: {},
    sessionStore: undefined,
    uiStateStore: {},
    draftStore: {},
    paneRegistry: new PaneRegistry(),
  } as unknown as ScreenContext;
}

/**
 * The session screen body, stood in for by a marker. Its identity is asserted below, so a
 * screen that mounted something else fails here.
 */
function TestSessionScreenBody(): null {
  return null;
}

function registeredTranscript(): ScreenRegistry {
  const registry = new ScreenRegistry();
  registerTranscriptScreens(registry, { sessionScreen: TestSessionScreenBody });
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
 * The session screen body, picked out of the screen's children. The resume banner renders
 * `null` on every arm but the refused one, so the body is read from the end of the list.
 */
function sessionScreenBodyIn(screenContainer: { props: Record<string, unknown> }): {
  type: unknown;
  key: string | null;
  props: Record<string, unknown>;
} {
  const children = screenContainer.props["children"];
  const mounted = Array.isArray(children) ? children : [children];
  return renderedElement(mounted[mounted.length - 1] as ReactNode);
}

describe("the transcript — which screens it holds", () => {
  it("claims the session screen under its owner", () => {
    const registry = registeredTranscript();
    const claims = registry
      .registeredScreenNames()
      .map((screenName) => [screenName, registry.descriptorFor(screenName)?.owner]);
    expect(claims).toStrictEqual([["session", "transcript"]]);
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    // Guards against a registry that reports screens nobody registered.
    expect(new ScreenRegistry().registeredScreenNames()).toStrictEqual([]);
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = registeredTranscript();
    const afterFirst = registry.registeredScreenNames();
    registerTranscriptScreens(registry, { sessionScreen: TestSessionScreenBody });
    expect(registry.registeredScreenNames()).toStrictEqual(afterFirst);
  });
});

describe("the transcript — what it mounts", () => {
  it("mounts the session screen — the session header, the pane layout, and the composer", () => {
    const registry = registeredTranscript();
    const screenContainer = renderedElement(
      registry.descriptorFor("session")?.render(screenContext()),
    );
    expect(screenContainer.type).toBe(SessionScreenContainer);
    const sessionScreenBody = sessionScreenBodyIn(screenContainer);
    expect(sessionScreenBody.type).toBe(TestSessionScreenBody);
    expect(sessionScreenBody.props["route"]).toStrictEqual({
      kind: "session",
      sessionId: "session-7",
    });
  });
});

describe("the transcript — what decides the mounted subtree's lifetime", () => {
  // A key on the route's session makes the subtree's lifetime match the state it holds. Without
  // it, moving between two already-open sessions re-renders this position and the second
  // inherits the first's panes, run-group disclosure, reading anchor and retained rows.

  it("keys the session screen subtree on the route's session", () => {
    const registry = registeredTranscript();
    const screenContainer = renderedElement(
      registry.descriptorFor("session")?.render(screenContext()),
    );
    expect(sessionScreenBodyIn(screenContainer).key).toBe("session-7");
  });

  it("negative control: a re-render of the SAME session keys identically, so it is not a remount", () => {
    // Without this, the case above would pass over a key that changed on every render,
    // remounting the session screen on every keystroke.
    const registry = registeredTranscript();
    const sessionDescriptor = registry.descriptorFor("session");
    const firstWorkspaceKey = sessionScreenBodyIn(
      renderedElement(sessionDescriptor?.render(screenContext())),
    ).key;
    expect(
      sessionScreenBodyIn(renderedElement(sessionDescriptor?.render(screenContext()))).key,
    ).toBe(firstWorkspaceKey);
  });

  it("falls back to a named key rather than an absent one when the route names no session", () => {
    const registry = registeredTranscript();
    const screenContainer = renderedElement(
      registry.descriptorFor("session")?.render({
        ...screenContext(),
        route: { kind: "settings" },
      } as unknown as ScreenContext),
    );
    expect(sessionScreenBodyIn(screenContainer).key).toBe("no-session");
  });
});
