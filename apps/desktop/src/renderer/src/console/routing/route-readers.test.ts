// The questions a surface asks of a route it already holds.
//
// SPLIT FROM `routes.test.ts` with the module it drives. That file owns the GRAMMAR —
// the round trip, the malformed hashes, the shared auxiliary fragment — and this one
// owns the readers: which rail icon is lit, which chrome a window renders, whether an
// auxiliary window still needs a subject, whether two routes are one address, and which
// workflow phase — if any — the address a person followed was pointing at.
//
// EVERY PREDICATE IS ASKED ABOUT EVERY KIND, walked from the shared lists rather than
// retyped, because the failure each of these guards against is a kind nobody asked the
// predicate about — an icon that cannot be reached, a window that keeps chrome it
// should have dropped, a picker that never appears.

import { describe, expect, it } from "vitest";

import {
  RAIL_DESTINATIONS,
  isAuxiliaryRoute,
  needsContextPicker,
  railDestinationFor,
  routeWorkflowPhase,
  routesAreEqual,
  settingsRoute,
  settingsSelection,
} from "./route-readers.js";
import { AUXILIARY_ROUTES, EVERY_KIND, MAIN_WINDOW_ROUTES } from "./route-samples.test-support.js";

describe("railDestinationFor — which rail icon is current", () => {
  it("names a destination for each main-window route", () => {
    expect(railDestinationFor({ kind: "sessions" })).toBe("sessions");
    expect(railDestinationFor({ kind: "workflows" })).toBe("workflows");
    expect(railDestinationFor({ kind: "settings", page: undefined })).toBe("settings");
  });

  it("keeps a session workspace under the sessions destination", () => {
    // The workspace is reached FROM the sessions destination, so the rail
    // highlights that one while a person is inside a session. The alternative —
    // a `workspace` destination of its own — names an icon the rail does not
    // render, which reads as the highlight going out on the busiest surface in
    // the console.
    expect(railDestinationFor({ kind: "workspace", sessionId: "session-1" })).toBe("sessions");
  });

  it("negative control: the workspace is not itself a rail destination", () => {
    // Without this, the case above would pass over a `RAIL_DESTINATIONS` that
    // still carried `workspace` beside the mapping, which is the exact state this
    // pair was in: three destinations declared, and the spec's second one absent.
    expect([...RAIL_DESTINATIONS]).not.toContain("workspace");
    expect([...RAIL_DESTINATIONS]).toStrictEqual(["sessions", "workflows", "settings"]);
  });

  it("reaches every destination the rail declares, so no icon is unreachable", () => {
    // Walked from the tuple rather than retyped. A destination the rail renders and
    // no route resolves to is an icon a person can press into nothing.
    const reachable = new Set(
      MAIN_WINDOW_ROUTES.map((route) => railDestinationFor(route)).filter(
        (destination) => destination !== undefined,
      ),
    );
    expect([...reachable].sort()).toStrictEqual([...RAIL_DESTINATIONS].sort());
  });

  it("names none in a window that has no rail", () => {
    // Absent, not disabled: an auxiliary window renders no rail at all, so there is
    // no current destination to highlight rather than a highlighted nothing.
    for (const route of AUXILIARY_ROUTES) {
      expect(railDestinationFor(route)).toBeUndefined();
    }
    expect(railDestinationFor({ kind: "not-found", attempted: "#/nowhere" })).toBeUndefined();
  });
});

describe("isAuxiliaryRoute — which chrome the window renders", () => {
  it("is true for every auxiliary route", () => {
    for (const route of AUXILIARY_ROUTES) {
      expect(isAuxiliaryRoute(route)).toBe(true);
    }
  });

  it("negative control: it is false for every main-window route", () => {
    // Without this, a predicate that returned true unconditionally would pass the
    // case above and every window would drop its chrome.
    for (const route of MAIN_WINDOW_ROUTES) {
      expect(isAuxiliaryRoute(route), route.kind).toBe(false);
    }
  });
});

describe("needsContextPicker — an auxiliary window that has no subject yet", () => {
  it("is true for an auxiliary route that names no session", () => {
    // Not an error and not an empty state: the window works, it just does not know
    // what to show, and the picker is what that case renders.
    expect(needsContextPicker({ kind: "auxiliary", route: "timeline" })).toBe(true);
  });

  it("is false once the route names a session", () => {
    expect(
      needsContextPicker({ kind: "auxiliary", route: "timeline", sessionId: "session-1" }),
    ).toBe(false);
  });

  it("negative control: it is false for a main-window route with no session either", () => {
    // The predicate is about an auxiliary window awaiting a subject, not about the
    // absence of a session id — a sessions list has none and needs no picker.
    for (const route of MAIN_WINDOW_ROUTES) {
      expect(needsContextPicker(route), route.kind).toBe(false);
    }
  });
});

describe("routesAreEqual — an unchanged hash costs no transition", () => {
  it("holds for a route compared with itself", () => {
    for (const route of EVERY_KIND) {
      expect(routesAreEqual(route, route)).toBe(true);
    }
  });

  it("distinguishes routes that differ only in one field", () => {
    expect(
      routesAreEqual(
        { kind: "workspace", sessionId: "session-1" },
        { kind: "workspace", sessionId: "session-2" },
      ),
    ).toBe(false);
    expect(
      routesAreEqual(
        { kind: "settings", page: undefined },
        { kind: "settings", page: "providers" },
      ),
    ).toBe(false);
    // The workspace arm's optional focus, in both directions: a bare address and a
    // focused one are two places, and two focuses on different phases are two more.
    expect(
      routesAreEqual(
        { kind: "workspace", sessionId: "session-1" },
        {
          kind: "workspace",
          sessionId: "session-1",
          workflowPhase: { workflowRunId: "run-1", phaseId: "review" },
        },
      ),
    ).toBe(false);
    expect(
      routesAreEqual(
        {
          kind: "workspace",
          sessionId: "session-1",
          workflowPhase: { workflowRunId: "run-1", phaseId: "review" },
        },
        {
          kind: "workspace",
          sessionId: "session-1",
          workflowPhase: { workflowRunId: "run-1", phaseId: "approve" },
        },
      ),
    ).toBe(false);
    expect(
      routesAreEqual(
        {
          kind: "workspace",
          sessionId: "session-1",
          workflowPhase: { workflowRunId: "run-1", phaseId: "review" },
        },
        {
          kind: "workspace",
          sessionId: "session-1",
          workflowPhase: { workflowRunId: "run-2", phaseId: "review" },
        },
      ),
    ).toBe(false);
    expect(
      routesAreEqual(
        { kind: "auxiliary", route: "agent-console", sessionId: "session-1", agentId: "agent-1" },
        { kind: "auxiliary", route: "agent-console", sessionId: "session-1", agentId: "agent-2" },
      ),
    ).toBe(false);
    expect(
      routesAreEqual(
        { kind: "auxiliary", route: "timeline" },
        { kind: "auxiliary", route: "agent-console" },
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
    expect(settingsSelection(settingsRoute("accounts", "codex"))).toBe("codex");
    expect(settingsSelection(settingsRoute("accounts", undefined))).toBeUndefined();
  });

  it("names nothing for a pageless settings address, which has nowhere to carry one", () => {
    expect(settingsSelection({ kind: "settings", page: undefined })).toBeUndefined();
  });

  it("negative control: it names nothing for a route of another kind", () => {
    // Without this, an accessor that read a member off any route at all would pass
    // every case above and hand a page a selection some other address carried.
    for (const route of MAIN_WINDOW_ROUTES.filter((each) => each.kind !== "settings")) {
      expect(settingsSelection(route), route.kind).toBeUndefined();
    }
  });

  it("distinguishes two addresses that differ only in the selection", () => {
    // The transition this pays for: a person on the accounts page opened for one
    // provider, following a row for another, must reach a route the frame store sees
    // as different — or the navigation costs nothing and the page never re-renders.
    expect(
      routesAreEqual(settingsRoute("accounts", "codex"), settingsRoute("accounts", "claude")),
    ).toBe(false);
    expect(
      routesAreEqual(settingsRoute("accounts", "codex"), settingsRoute("accounts", undefined)),
    ).toBe(false);
    expect(
      routesAreEqual(settingsRoute("accounts", "codex"), settingsRoute("accounts", "codex")),
    ).toBe(true);
  });
});

describe("routeWorkflowPhase — the phase a deep link named", () => {
  it("hands back the focus a phase address carries", () => {
    // The whole value rather than its two members separately: what a consumer needs is
    // the run AND the phase together, and an accessor that answered one of them would
    // let a caller pair this route's phase with some other route's run.
    expect(
      routeWorkflowPhase({
        kind: "workspace",
        sessionId: "session-1",
        workflowPhase: { workflowRunId: "run-1", phaseId: "phase-1" },
      }),
    ).toStrictEqual({ workflowRunId: "run-1", phaseId: "phase-1" });
  });

  it("names nothing for a bare workspace address, which carries no focus", () => {
    expect(routeWorkflowPhase({ kind: "workspace", sessionId: "session-1" })).toBeUndefined();
  });

  it("negative control: it names nothing for a route of another kind", () => {
    // Without this, an accessor that read a member off any route at all would pass both
    // cases above and hand the run pane a focus that came from somewhere else — the
    // same defect `settingsSelection` guards against, and the reason this reader exists
    // rather than every consumer reaching into the arm itself.
    for (const route of MAIN_WINDOW_ROUTES.filter((each) => each.kind !== "workspace")) {
      expect(routeWorkflowPhase(route), route.kind).toBeUndefined();
    }
  });
});
