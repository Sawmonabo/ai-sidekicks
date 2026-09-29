// The questions a surface asks of a route it already holds.
//
// SPLIT FROM `routes.test.ts` with the module it drives. That file owns the GRAMMAR —
// the round trip and the malformed hashes — and this one owns the readers: which rail
// icon is lit, whether two routes are one address, and which workflow phase — if
// any — the address a person followed was pointing at.
//
// EVERY PREDICATE IS ASKED ABOUT EVERY KIND, walked from the shared lists rather than
// retyped, because the failure each of these guards against is a kind nobody asked the
// predicate about — an icon that cannot be reached.

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
    // The session screen is reached FROM the sessions destination, so the rail
    // highlights that one while a person is inside a session. The alternative —
    // a `session` destination of its own — names an icon the rail does not
    // render, which reads as the highlight going out on the busiest surface in
    // the console.
    expect(railDestinationFor({ kind: "session", sessionId: "session-1" })).toBe("sessions");
  });

  it("negative control: the session screen is not itself a rail destination", () => {
    // Without this, the case above would pass over a `RAIL_DESTINATIONS` that
    // still carried `session` beside the mapping, which is the exact state this
    // pair was in: three destinations declared, and the spec's second one absent.
    expect([...RAIL_DESTINATIONS]).not.toContain("session");
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
    // The session screen arm's optional focus, in both directions: a bare address and a
    // focused one are two places, and two focuses on different phases are two more.
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
    // The whole value rather than its two members separately: what a consumer needs is
    // the run AND the phase together, and an accessor that answered one of them would
    // let a caller pair this route's phase with some other route's run.
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
    // Without this, an accessor that read a member off any route at all would pass both
    // cases above and hand the run pane a focus that came from somewhere else — the
    // same defect `settingsSelection` guards against, and the reason this reader exists
    // rather than every consumer reaching into the arm itself.
    for (const route of MAIN_WINDOW_ROUTES.filter((each) => each.kind !== "session")) {
      expect(routeWorkflowPhase(route), route.kind).toBeUndefined();
    }
  });
});
