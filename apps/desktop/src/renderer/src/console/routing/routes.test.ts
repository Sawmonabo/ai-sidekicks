// Routes as values: parsed, rendered back, compared, and classified.
//
// `FAILURE-MATRIX.test.ts` already drives the malformed-input arms — an unknown
// window route, too many segments, a bare auxiliary route, an escaped session id,
// an empty hash. This file covers what that one does not: the round trip for the
// main-window grammar, and the four readers a surface asks about a route it
// already holds.
//
// The round trip is the load-bearing case. `parseRoute` and `formatRoute` are two
// hand-written grammars over one shape, and nothing in the compiler makes them
// agree; a route that renders to a hash the parser reads differently is a window
// that reopens somewhere else, which is the failure a person meets after a restart
// rather than at the moment it was caused.
//
// SCOPE: the auxiliary-route VOCABULARY — the route-name tuple, the `#/window/`
// fragment and its parse/format pair — is moving to a shared module and is
// deliberately untouched here. Auxiliary routes appear below only as VALUES of the
// route union, which is what `isAuxiliaryRoute`, `needsContextPicker`,
// `railDestinationFor`, and `routesAreEqual` are predicates over.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTE,
  RAIL_DESTINATIONS,
  formatRoute,
  isAuxiliaryRoute,
  needsContextPicker,
  parseRoute,
  railDestinationFor,
  routesAreEqual,
  type ConsoleRoute,
} from "./routes.js";

/** Main-window routes, including the arms that carry an optional segment. */
const MAIN_WINDOW_ROUTES: readonly ConsoleRoute[] = [
  { kind: "sessions" },
  { kind: "workspace", sessionId: "session-1" },
  { kind: "settings", page: undefined },
  { kind: "settings", page: "providers" },
  { kind: "not-found", attempted: "#/nowhere" },
];

/** Auxiliary routes as values, for the predicates. Never parsed from a hash here. */
const AUXILIARY_ROUTES: readonly ConsoleRoute[] = [
  { kind: "auxiliary", route: "timeline", sessionId: undefined, agentId: undefined },
  { kind: "auxiliary", route: "timeline", sessionId: "session-1", agentId: undefined },
  { kind: "auxiliary", route: "agent-console", sessionId: "session-1", agentId: "agent-1" },
];

const EVERY_KIND: readonly ConsoleRoute[] = [...MAIN_WINDOW_ROUTES, ...AUXILIARY_ROUTES];

describe("routes — every main-window route renders to a hash that parses back to it", () => {
  for (const route of MAIN_WINDOW_ROUTES) {
    it(`${route.kind}: ${formatRoute(route)}`, () => {
      expect(parseRoute(formatRoute(route))).toStrictEqual(route);
    });
  }

  it("round-trips a session id that needs escaping", () => {
    const route: ConsoleRoute = { kind: "workspace", sessionId: "session/with#awkward chars" };
    expect(parseRoute(formatRoute(route))).toStrictEqual(route);
  });

  it("negative control: two different routes do not render to one hash", () => {
    // Without this, a `formatRoute` returning a constant would round-trip nothing
    // and still satisfy a parser that returned the default route for everything.
    const rendered = MAIN_WINDOW_ROUTES.map((route) => formatRoute(route));
    expect(new Set(rendered).size).toBe(rendered.length);
  });
});

describe("routes — the default", () => {
  it("is where a window with no hash lands", () => {
    expect(parseRoute("")).toStrictEqual(DEFAULT_ROUTE);
  });

  it("normalises to an explicit hash rather than rendering back to nothing", () => {
    // A window that reopened on "" would depend on the default staying what it is
    // today; the explicit hash survives a change of default.
    expect(formatRoute(DEFAULT_ROUTE)).toBe("#/sessions");
  });
});

describe("routes — malformed main-window hashes resolve to not-found", () => {
  it("refuses trailing segments the grammar does not have", () => {
    expect(parseRoute("#/sessions/extra")).toStrictEqual({
      kind: "not-found",
      attempted: "#/sessions/extra",
    });
    expect(parseRoute("#/session/one/two").kind).toBe("not-found");
    expect(parseRoute("#/settings/one/two").kind).toBe("not-found");
  });

  it("refuses a session route with no session id", () => {
    expect(parseRoute("#/session").kind).toBe("not-found");
  });

  it("carries the attempted hash, so the surface says what it could not open", () => {
    // A blank not-found is the state the console's five kinds of nothing exist to
    // prevent: it renders as "something is wrong" and names nothing.
    expect(parseRoute("#/nowhere")).toStrictEqual({ kind: "not-found", attempted: "#/nowhere" });
  });

  it("negative control: a well-formed hash of each main-window kind is NOT not-found", () => {
    expect(parseRoute("#/sessions").kind).toBe("sessions");
    expect(parseRoute("#/session/session-1").kind).toBe("workspace");
    expect(parseRoute("#/settings").kind).toBe("settings");
  });
});

describe("railDestinationFor — which rail icon is current", () => {
  it("names a destination for each main-window route", () => {
    expect(railDestinationFor({ kind: "sessions" })).toBe("sessions");
    expect(railDestinationFor({ kind: "workspace", sessionId: "session-1" })).toBe("workspace");
    expect(railDestinationFor({ kind: "settings", page: undefined })).toBe("settings");
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
    expect(
      needsContextPicker({
        kind: "auxiliary",
        route: "timeline",
        sessionId: undefined,
        agentId: undefined,
      }),
    ).toBe(true);
  });

  it("is false once the route names a session", () => {
    expect(
      needsContextPicker({
        kind: "auxiliary",
        route: "timeline",
        sessionId: "session-1",
        agentId: undefined,
      }),
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
    expect(
      routesAreEqual(
        { kind: "auxiliary", route: "timeline", sessionId: "session-1", agentId: undefined },
        { kind: "auxiliary", route: "timeline", sessionId: "session-1", agentId: "agent-1" },
      ),
    ).toBe(false);
    expect(
      routesAreEqual(
        { kind: "auxiliary", route: "timeline", sessionId: "session-1", agentId: undefined },
        { kind: "auxiliary", route: "agent-console", sessionId: "session-1", agentId: undefined },
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
