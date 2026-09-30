// The questions a view asks of a route it already holds. Every predicate is asked about every
// kind, walked from the shared route list, so a kind nobody asked about (an unreachable icon)
// fails here.

import { describe, expect, it } from "vitest";

import {
  RAIL_DESTINATIONS,
  railDestinationFor,
  routeWorkflowPhase,
  routesAreEqual,
  settingsRoute,
  settingsSelection,
} from "./route-readers.js";
import { MAIN_WINDOW_ROUTES } from "./route-samples.test-support.js";

describe("railDestinationFor — which rail icon is current", () => {
  it("names a destination for each main-window route", () => {
    expect(railDestinationFor({ kind: "sessions" })).toBe("sessions");
    expect(railDestinationFor({ kind: "workflows" })).toBe("workflows");
    expect(railDestinationFor({ kind: "settings", page: undefined })).toBe("settings");
  });

  it("keeps a session screen under the sessions destination", () => {
    // A `session` destination of its own would name an icon the rail does not render.
    expect(railDestinationFor({ kind: "session", sessionId: "session-1" })).toBe("sessions");
  });

  it("negative control: the session screen is not itself a rail destination", () => {
    // Without it, the case above passes over a `RAIL_DESTINATIONS` that still carried `session`.
    expect([...RAIL_DESTINATIONS]).not.toContain("session");
    expect([...RAIL_DESTINATIONS]).toStrictEqual(["sessions", "workflows", "settings"]);
  });

  it("reaches every destination the rail declares, so no icon is unreachable", () => {
    // A destination the rail renders and no route resolves to is an icon that opens nothing.
    const reachable = new Set(
      MAIN_WINDOW_ROUTES.map((route) => railDestinationFor(route)).filter(
        (destination) => destination !== undefined,
      ),
    );
    expect([...reachable].sort()).toStrictEqual([...RAIL_DESTINATIONS].sort());
  });

  it("names none for a route that lights no icon", () => {
    expect(railDestinationFor({ kind: "not-found", attempted: "#/nowhere" })).toBeUndefined();
  });
});

describe("routesAreEqual — an unchanged hash costs no transition", () => {
  it("holds for a route compared with itself", () => {
    for (const route of MAIN_WINDOW_ROUTES) {
      expect(routesAreEqual(route, route)).toBe(true);
    }
  });

  it("distinguishes routes that differ only in one field", () => {
    expect(
      routesAreEqual(
        { kind: "session", sessionId: "session-1" },
        { kind: "session", sessionId: "session-2" },
      ),
    ).toBe(false);
    expect(
      routesAreEqual(
        { kind: "settings", page: undefined },
        { kind: "settings", page: "providers" },
      ),
    ).toBe(false);
    // The optional focus: a bare address and a focused one differ, as do two different phases.
    expect(
      routesAreEqual(
        { kind: "session", sessionId: "session-1" },
        {
          kind: "session",
          sessionId: "session-1",
          workflowPhase: { workflowRunId: "run-1", phaseId: "review" },
        },
      ),
    ).toBe(false);
    expect(
      routesAreEqual(
        {
          kind: "session",
          sessionId: "session-1",
          workflowPhase: { workflowRunId: "run-1", phaseId: "review" },
        },
        {
          kind: "session",
          sessionId: "session-1",
          workflowPhase: { workflowRunId: "run-1", phaseId: "approve" },
        },
      ),
    ).toBe(false);
    expect(
      routesAreEqual(
        {
          kind: "session",
          sessionId: "session-1",
          workflowPhase: { workflowRunId: "run-1", phaseId: "review" },
        },
        {
          kind: "session",
          sessionId: "session-1",
          workflowPhase: { workflowRunId: "run-2", phaseId: "review" },
        },
      ),
    ).toBe(false);
    expect(
      routesAreEqual(
        { kind: "not-found", attempted: "#/one" },
        { kind: "not-found", attempted: "#/two" },
      ),
    ).toBe(false);
  });

  it("distinguishes routes of different kinds", () => {
    expect(routesAreEqual({ kind: "sessions" }, { kind: "settings", page: undefined })).toBe(false);
  });
});

describe("the settings arm's page-scoped selection", () => {
  it("is what a producer asked for, and absent where it asked for none", () => {
    expect(settingsSelection(settingsRoute("providers", "codex"))).toBe("codex");
    expect(settingsSelection(settingsRoute("providers", undefined))).toBeUndefined();
  });

  it("names nothing for a pageless settings address, which has nowhere to carry one", () => {
    expect(settingsSelection({ kind: "settings", page: undefined })).toBeUndefined();
  });

  it("negative control: it names nothing for a route of another kind", () => {
    // Without it, an accessor that read a member off any route passes every case above.
    for (const route of MAIN_WINDOW_ROUTES.filter((each) => each.kind !== "settings")) {
      expect(settingsSelection(route), route.kind).toBeUndefined();
    }
  });

  it("distinguishes two addresses that differ only in the selection", () => {
    // Following a row for another provider must reach a route the frame store sees as
    // different, or the page never re-renders.
    expect(
      routesAreEqual(settingsRoute("providers", "codex"), settingsRoute("providers", "claude")),
    ).toBe(false);
    expect(
      routesAreEqual(settingsRoute("providers", "codex"), settingsRoute("providers", undefined)),
    ).toBe(false);
    expect(
      routesAreEqual(settingsRoute("providers", "codex"), settingsRoute("providers", "codex")),
    ).toBe(true);
  });
});

describe("routeWorkflowPhase — the phase a deep link named", () => {
  it("hands back the focus a phase address carries", () => {
    // The whole value, so a caller never pairs this route's phase with another route's run.
    expect(
      routeWorkflowPhase({
        kind: "session",
        sessionId: "session-1",
        workflowPhase: { workflowRunId: "run-1", phaseId: "phase-1" },
      }),
    ).toStrictEqual({ workflowRunId: "run-1", phaseId: "phase-1" });
  });

  it("names nothing for a bare session screen address, which carries no focus", () => {
    expect(routeWorkflowPhase({ kind: "session", sessionId: "session-1" })).toBeUndefined();
  });

  it("negative control: it names nothing for a route of another kind", () => {
    // Without it, an accessor that read a member off any route passes both cases above.
    for (const route of MAIN_WINDOW_ROUTES.filter((each) => each.kind !== "session")) {
      expect(routeWorkflowPhase(route), route.kind).toBeUndefined();
    }
  });
});
