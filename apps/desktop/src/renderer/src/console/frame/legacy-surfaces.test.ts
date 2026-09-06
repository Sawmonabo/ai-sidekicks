// The three shipped families reach the screen, and reach it honestly.
//
// The elements are inspected rather than rendered, and that is the point rather
// than a shortcut. All three components read `window.sidekicks` on mount, so
// MOUNTING them here would assert something about happy-dom's missing preload
// instead of about the wiring — and the wiring is the whole claim: which slot,
// which owner, which component, and which session id it is handed. A React
// element carries all four before anything renders it.

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridgeSource } from "../bridge/console-bridge.js";
import { SurfaceAbsence } from "../primitives/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import { NodeRoster } from "../../runtime-node-attach/index.js";
import { SessionBootstrap } from "../../session-bootstrap/index.js";
import { ParticipantRoster } from "../../session-members/participant-roster.js";
import { registerLegacySurfaces } from "./legacy-surfaces.js";
import { SessionsSurface } from "./SessionsSurface.js";
import { ConsoleSurfaceRegistry, type ConsoleSurfaceContext } from "../seats/index.js";

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
  it("claims one slot per shipped family, each under its own owner", () => {
    const registry = registeredLegacySurfaces();
    const claims = registry
      .registeredSlots()
      .map((slot) => [slot, registry.descriptorFor(slot)?.owner]);
    expect(claims).toStrictEqual([
      ["sessions", "session-bootstrap"],
      ["workspace", "session-members"],
      ["agent-console", "runtime-node-attach"],
    ]);
  });

  it("negative control: the slots nobody claimed stay reserved", () => {
    // "Reserved, not stubbed" is the frame's rule for an unclaimed slot, and the
    // case above would read the same over a registrar that claimed all six.
    //
    // `workflows` is here for a second reason: the rail's middle destination is
    // reachable now, and this is not the registrar that fills it — the family claims
    // its slot through its own `registerWorkflowSurfaces`, so the slot has to be
    // declared and left unclaimed by THIS registrar rather than declared and quietly
    // held by whoever registered nearest to it.
    const registry = registeredLegacySurfaces();
    expect(registry.descriptorFor("workflows")).toBeUndefined();
    expect(registry.descriptorFor("settings")).toBeUndefined();
    expect(registry.descriptorFor("timeline")).toBeUndefined();
  });
});

describe("legacy surfaces — under a live bridge, the family mounts", () => {
  it("holds the sessions slot with a surface, not with the probe itself", () => {
    // The probe creates a session from its mount effect, and a route lifecycle
    // remounts a slot on every visit. Mounting it here would make navigating back
    // to the sessions list create a session — see `SessionsSurface.test.tsx`,
    // which drives this same descriptor and counts the bridge calls.
    const registry = registeredLegacySurfaces();
    const element = renderedElement(
      registry.descriptorFor("sessions")?.render(contextFor({ kind: "sessions" }, "live")),
    );
    expect(element.type).toBe(SessionsSurface);
    expect(element.type).not.toBe(SessionBootstrap);
  });

  it("hands that surface the probe to build on the participant's act", () => {
    // The bridge-source guard stays here rather than moving into the surface, so
    // what a start request builds is decided once, beside the other two mounts.
    const registry = registeredLegacySurfaces();
    const element = renderedElement(
      registry.descriptorFor("sessions")?.render(contextFor({ kind: "sessions" }, "live")),
    );
    const startSession = element.props["startSession"] as () => ReactNode;
    expect(renderedElement(startSession()).type).toBe(SessionBootstrap);
  });

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

  it("hands the node roster the session the auxiliary address names", () => {
    const registry = registeredLegacySurfaces();
    const element = renderedElement(
      registry.descriptorFor("agent-console")?.render(
        contextFor(
          {
            kind: "auxiliary",
            route: "agent-console",
            sessionId: "session-9",
            agentId: undefined,
          },
          "live",
        ),
      ),
    );
    expect(element.type).toBe(NodeRoster);
    expect(element.props["sessionId"]).toBe("session-9");
  });
});

describe("legacy surfaces — under the fixture, the console says it did not ask", () => {
  it("renders the not-checked absence instead of the component", () => {
    // These components read the installed bridge directly, so the fixture cannot
    // stand in for it. Mounting them anyway would either throw into the surface
    // boundary or answer from the live daemon beside fixture data in one window.
    // Read through the sessions surface's own start-request builder, which is
    // where that slot's probe is now built.
    const registry = registeredLegacySurfaces();
    const sessionsSurface = renderedElement(
      registry.descriptorFor("sessions")?.render(contextFor({ kind: "sessions" }, "fixture")),
    );
    const startSession = sessionsSurface.props["startSession"] as () => ReactNode;
    const element = centredAbsence(startSession());
    expect(element.type).not.toBe(SessionBootstrap);
    expect(element.props["kind"]).toBe("not-checked");
  });

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
    // Unreachable through the frame, which resolves a bare auxiliary route through
    // its context picker before any surface renders. Asserted anyway: the
    // descriptor is callable by anything holding the registry, and the arm that
    // exists only for that case is the arm nobody would notice going wrong.
    const registry = registeredLegacySurfaces();
    const element = centredAbsence(
      registry
        .descriptorFor("agent-console")
        ?.render(
          contextFor(
            { kind: "auxiliary", route: "agent-console", sessionId: undefined, agentId: undefined },
            "live",
          ),
        ),
    );
    expect(element.type).not.toBe(NodeRoster);
    expect(element.props["kind"]).toBe("empty");
  });

  it("negative control: the same slot with a session mounts the component", () => {
    const registry = registeredLegacySurfaces();
    const element = renderedElement(
      registry.descriptorFor("agent-console")?.render(
        contextFor(
          {
            kind: "auxiliary",
            route: "agent-console",
            sessionId: "session-9",
            agentId: undefined,
          },
          "live",
        ),
      ),
    );
    expect(element.type).toBe(NodeRoster);
  });
});
