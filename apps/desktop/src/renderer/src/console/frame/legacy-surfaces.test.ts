// The one slot this registrar still claims, and what it mounts there.
//
// Three of the four shipped families reach the screen through a console-authored
// surface now, and `seats/absorbed-surfaces.test.ts` covers those mounts and the
// guard they carry. What is left here is the TABLE: which slot, which owner, which
// component, and which session id the slot's context resolves to.
//
// The elements are inspected rather than rendered, and that is the point rather than
// a shortcut. The component this slot mounts reads `window.sidekicks` on mount, so
// MOUNTING it here would assert something about happy-dom's missing preload instead
// of about the wiring — and the wiring is the whole claim. A React element carries
// all of it before anything renders it.

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridgeSource } from "../bridge/console-bridge.js";
import { SurfaceAbsence } from "../primitives/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import { ParticipantRoster } from "../../session-members/participant-roster.js";
import { registerLegacySurfaces } from "./legacy-surfaces.js";
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
 * Every arm here fills the entire pane, and a `Nothing` left in flow renders as
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
    //
    // `workflows` is here for a second reason: the rail's middle destination is
    // reachable now and the family that fills it (T-023p-1C-6) ships on its own
    // branch, so the slot has to be declared and unclaimed rather than declared
    // and quietly held by whoever registered nearest to it.
    const registry = registeredLegacySurfaces();
    expect(registry.descriptorFor("sessions")).toBeUndefined();
    expect(registry.descriptorFor("workflows")).toBeUndefined();
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
