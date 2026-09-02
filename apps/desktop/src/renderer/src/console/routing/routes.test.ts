// Routes as values: parsed, rendered back, compared, and classified.
//
// `failure-modes.test.ts` already drives the malformed-input arms — an unknown
// window route, too many segments, a bare auxiliary route, an escaped session id,
// a malformed percent-escape, an empty path segment, an empty hash. This file
// covers what that one does not: the round trip for the main-window grammar, and
// the four readers a surface asks about a route it already holds.
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
  { kind: "workflows" },
  { kind: "settings", page: undefined },
  { kind: "settings", page: "providers" },
  { kind: "not-found", attempted: "#/nowhere" },
];

/** Auxiliary routes as values, for the predicates. Never parsed from a hash here. */
const AUXILIARY_ROUTES: readonly ConsoleRoute[] = [
  { kind: "auxiliary", route: "timeline" },
  { kind: "auxiliary", route: "timeline", sessionId: "session-1" },
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
    expect(parseRoute("#/workflows/extra").kind).toBe("not-found");
    expect(parseRoute("#/settings/one/two").kind).toBe("not-found");
  });

  it("names no address of its own for the session workspace's rail destination", () => {
    // `workspace` is a ROUTE kind reached from the sessions destination, not a
    // rail destination with an address. `#/workspace` therefore names nothing —
    // the session workspace is `#/session/<id>` — and a grammar that answered it
    // would be a second address for a surface that already has one.
    expect(parseRoute("#/workspace")).toStrictEqual({
      kind: "not-found",
      attempted: "#/workspace",
    });
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
    expect(parseRoute("#/workflows").kind).toBe("workflows");
    expect(parseRoute("#/settings").kind).toBe("settings");
  });
});

describe("routes — the auxiliary arm is the shared grammar, not a second copy", () => {
  it("refuses a malformed escape instead of throwing out of a total function", () => {
    // `parseRoute` promises that every input produces a route. Before this arm
    // delegated to `src/shared/auxiliary-routes.ts` it called
    // `decodeURIComponent` on the segment directly, and `%zz` raises `URIError` —
    // a throw from the function the renderer calls to decide what to render, on
    // a string anyone can type into the address bar.
    expect(() => parseRoute("#/window/timeline/%zz")).not.toThrow();
    expect(parseRoute("#/window/timeline/%zz")).toStrictEqual({
      kind: "not-found",
      attempted: "#/window/timeline/%zz",
    });
  });

  it("refuses an unknown route name, too many segments, and a half-supplied context", () => {
    expect(parseRoute("#/window/nowhere").kind).toBe("not-found");
    expect(parseRoute("#/window/timeline/s1/a1/extra").kind).toBe("not-found");
    // An agent console names its session AND its agent or neither: a session with
    // no agent is not a partial descriptor of a window, it is a window that cannot
    // be opened. The shared grammar refuses it, so this arm never sees a target.
    expect(parseRoute("#/window/agent-console/session-1").kind).toBe("not-found");
  });

  it("negative control: the well-formed auxiliary hashes still parse", () => {
    // Without this the refusals above would pass over an arm that refused
    // everything, which is the failure this delegation could plausibly cause.
    expect(parseRoute("#/window/timeline")).toStrictEqual({
      kind: "auxiliary",
      route: "timeline",
    });
    expect(parseRoute("#/window/agent-console/session-1/agent-1")).toStrictEqual({
      kind: "auxiliary",
      route: "agent-console",
      sessionId: "session-1",
      agentId: "agent-1",
    });
  });

  it("round-trips through the shared producer, escapes included", () => {
    // The console parses fragments the MAIN process produces, so the pair has to
    // be an inverse across the process boundary, not merely within this module.
    const hash = "#/window/agent-console/session%2Fone/agent%20two";
    const route = parseRoute(hash);
    expect(route).toStrictEqual({
      kind: "auxiliary",
      route: "agent-console",
      sessionId: "session/one",
      agentId: "agent two",
    });
    expect(formatRoute(route)).toBe(hash);
  });
});

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
