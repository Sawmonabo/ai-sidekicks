// The three shipped families reach the screen, and reach it honestly.
//
// Two of them now reach it through a console-authored surface rather than through
// a slot of their own, so this file covers two things: the one slot this registrar
// still claims, and the two absorption helpers the console surfaces mount the other
// two through. Both halves share one guard, and the guard is the claim — a helper
// that mounted its component past the fixture check would look identical from the
// outside until it answered from the live daemon in a window showing fixture data.
//
// The elements are inspected rather than rendered, and that is the point rather
// than a shortcut. All three components read `window.sidekicks` on mount, so
// MOUNTING them here would assert something about happy-dom's missing preload
// instead of about the wiring — and the wiring is the whole claim: which slot,
// which owner, which component, and which session id it is handed. A React
// element carries all four before anything renders it.

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridgeSource } from "../bridge/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import { NodeRoster } from "../../runtime-node-attach/index.js";
import { SessionBootstrap } from "../../session-bootstrap/index.js";
import { ParticipantRoster } from "../../session-members/participant-roster.js";
import {
  registerLegacySurfaces,
  renderAbsorbedNodeRoster,
  renderAbsorbedSessionProbe,
} from "./legacy-surfaces.js";
import { SurfaceAbsence } from "./RouteSurface.js";
import { ConsoleSurfaceRegistry, type ConsoleSurfaceContext } from "./surface-registry.js";

/**
 * The two fields the descriptors read, and nothing else.
 *
 * Cast rather than constructed: a real context carries three stores, one of which
 * opens a database on construction, and building all of that to hand two fields
 * to a function that reads two fields would make the setup the subject.
 */
function contextFor(route: ConsoleRoute, source: ConsoleBridgeSource): ConsoleSurfaceContext {
  return { route, bridge: { source } } as unknown as ConsoleSurfaceContext;
}

/** The element a descriptor produced, or a failure that names the slot. */
function renderedElement(node: ReactNode): { type: unknown; props: Record<string, unknown> } {
  if (!isValidElement<Record<string, unknown>>(node)) {
    throw new Error(`expected a React element, got ${String(node)}`);
  }
  return { type: node.type, props: node.props };
}

/**
 * The `Nothing` inside a whole-surface absence, having first asserted that it IS
 * one.
 *
 * These three arms fill the entire pane, and a `Nothing` left in flow renders as
 * a strip in its top-left corner — a page that reads as having failed to finish
 * painting. That shipped once precisely because the assertions here reached
 * straight for `kind`: the kind was right and the placement was wrong, and no
 * test named the placement. Unwrapping through this helper pins both, and only
 * the screenshot tier could see the difference otherwise.
 */
function centredAbsence(node: ReactNode): { type: unknown; props: Record<string, unknown> } {
  const wrapper = renderedElement(node);
  expect(wrapper.type).toBe(SurfaceAbsence);
  return renderedElement(wrapper.props["children"] as ReactNode);
}

function registeredLegacySurfaces(): ConsoleSurfaceRegistry {
  const registry = new ConsoleSurfaceRegistry();
  registerLegacySurfaces(registry);
  return registry;
}

describe("legacy surfaces — which family holds which slot", () => {
  it("claims the one slot no console surface has taken over", () => {
    const registry = registeredLegacySurfaces();
    const claims = registry
      .registeredSlots()
      .map((slot) => [slot, registry.descriptorFor(slot)?.owner]);
    expect(claims).toStrictEqual([["workspace", "session-members"]]);
  });

  it("negative control: the slots nobody claimed here stay reserved", () => {
    // "Reserved, not stubbed" is the frame's rule for an unclaimed slot, and the
    // case above would read the same over a registrar that claimed all five. The
    // `sessions` and `agent-console` slots are claimed by the console surfaces
    // that absorbed these families — by THAT registrar, not this one.
    const registry = registeredLegacySurfaces();
    expect(registry.descriptorFor("sessions")).toBeUndefined();
    expect(registry.descriptorFor("agent-console")).toBeUndefined();
    expect(registry.descriptorFor("settings")).toBeUndefined();
    expect(registry.descriptorFor("timeline")).toBeUndefined();
  });
});

describe("legacy surfaces — under a live bridge, the family mounts", () => {
  it("hands the roster the session the workspace address names", () => {
    const registry = registeredLegacySurfaces();
    const element = renderedElement(
      registry
        .descriptorFor("workspace")
        ?.render(contextFor({ kind: "workspace", sessionId: "session-7" }, "live")),
    );
    expect(element.type).toBe(ParticipantRoster);
    expect(element.props["sessionId"]).toBe("session-7");
  });
});

describe("legacy surfaces — under the fixture, the console says it did not ask", () => {
  it("does not reach the session lookup at all", () => {
    // A bridge check placed after the session lookup would report "no session"
    // for a workspace address under the fixture, which is a different and false
    // statement about a route that names one perfectly well.
    const registry = registeredLegacySurfaces();
    const element = centredAbsence(
      registry
        .descriptorFor("workspace")
        ?.render(contextFor({ kind: "workspace", sessionId: "session-7" }, "fixture")),
    );
    expect(element.props["kind"]).toBe("not-checked");
  });
});

describe("legacy surfaces — an address that names no session", () => {
  it("says the surface needs one rather than mounting it without", () => {
    const registry = registeredLegacySurfaces();
    const element = centredAbsence(
      registry.descriptorFor("workspace")?.render(contextFor({ kind: "sessions" }, "live")),
    );
    expect(element.type).not.toBe(ParticipantRoster);
    expect(element.props["kind"]).toBe("empty");
  });

  it("negative control: the same slot with a session mounts the component", () => {
    const registry = registeredLegacySurfaces();
    const element = renderedElement(
      registry
        .descriptorFor("workspace")
        ?.render(contextFor({ kind: "workspace", sessionId: "session-7" }, "live")),
    );
    expect(element.type).toBe(ParticipantRoster);
  });
});

describe("legacy surfaces — the two families a console surface absorbed", () => {
  it("mounts the session probe with no props to give it", () => {
    expect(renderedElement(renderAbsorbedSessionProbe("live")).type).toBe(SessionBootstrap);
  });

  it("hands the node roster the session its caller resolved", () => {
    const element = renderedElement(renderAbsorbedNodeRoster("live", "session-9"));
    expect(element.type).toBe(NodeRoster);
    expect(element.props["sessionId"]).toBe("session-9");
  });

  it("keeps the fixture guard on both, because the guard is not the caller's", () => {
    // The whole reason these are helpers rather than exported components. A console
    // surface that imported `SessionBootstrap` directly would mount a component
    // reading the installed bridge into a window showing fixture data.
    expect(centredAbsence(renderAbsorbedSessionProbe("fixture")).props["kind"]).toBe("not-checked");
    expect(centredAbsence(renderAbsorbedNodeRoster("fixture", "session-9")).props["kind"]).toBe(
      "not-checked",
    );
  });

  it("says the console needs a session rather than mounting the roster without one", () => {
    // Reachable: the frame's context picker resolves a bare auxiliary address by
    // choosing a SESSION, and the agent-console grammar carries its agent with its
    // session — so a picked session arrives at the pane with no agent, and a pane
    // opened session-scoped in the deck carries none either.
    const element = centredAbsence(renderAbsorbedNodeRoster("live", undefined));
    expect(element.type).not.toBe(NodeRoster);
    expect(element.props["kind"]).toBe("empty");
  });
});
