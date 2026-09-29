// Routes as values: parsed, rendered back, compared, and classified.
//
// `failure-modes.test.ts` already drives the malformed-input arms — an escaped
// session id, a malformed percent-escape, an empty path segment, an empty hash. This
// file covers what that one does not: the round trip for the main-window grammar.
//
// The round trip is the load-bearing case. `parseRoute` and `formatRoute` are two
// hand-written grammars over one shape, and nothing in the compiler makes them
// agree; a route that renders to a hash the parser reads differently is a window
// that reopens somewhere else, which is the failure a person meets after a restart
// rather than at the moment it was caused.

import { describe, expect, it } from "vitest";

import { DEFAULT_ROUTE, formatRoute, parseRoute, type AppRoute } from "./routes.js";
import { MAIN_WINDOW_ROUTES } from "./route-samples.test-support.js";

describe("routes — every main-window route renders to a hash that parses back to it", () => {
  for (const route of MAIN_WINDOW_ROUTES) {
    it(`${route.kind}: ${formatRoute(route)}`, () => {
      expect(parseRoute(formatRoute(route))).toStrictEqual(route);
    });
  }

  it("round-trips a session id that needs escaping", () => {
    const route: AppRoute = { kind: "session", sessionId: "session/with#awkward chars" };
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
    // Three segments and not two: `#/settings/<page>/<selection>` is grammar now, so
    // what over-runs the settings arm is one segment further along.
    expect(parseRoute("#/settings/one/two/three").kind).toBe("not-found");
  });

  it("round-trips a settings address carrying its page's own selection", () => {
    // The pair the grammar exists to keep exact: a row that deep-links to the accounts
    // page for one provider hands the frame store an address, and a parser reading the
    // second segment differently would open that page for another provider or none.
    expect(parseRoute("#/settings/providers/codex")).toStrictEqual({
      kind: "settings",
      page: "providers",
      selection: "codex",
    });
    expect(formatRoute(parseRoute("#/settings/providers/codex"))).toBe(
      "#/settings/providers/codex",
    );
    // The selection is a wire value, so it escapes like every other segment.
    const escaped = "#/settings/providers/one%2Ftwo";
    expect(parseRoute(escaped)).toStrictEqual({
      kind: "settings",
      page: "providers",
      selection: "one/two",
    });
    expect(formatRoute(parseRoute(escaped))).toBe(escaped);
  });

  it("refuses a settings selection whose escapes are malformed", () => {
    expect(parseRoute("#/settings/providers/%zz").kind).toBe("not-found");
  });

  it("names no address of its own for the session screen's rail destination", () => {
    // `workspace` is a ROUTE kind reached from the sessions destination, not a
    // rail destination with an address. `#/workspace` therefore names nothing —
    // the session screen is `#/session/<id>` — and a grammar that answered it
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
    expect(parseRoute("#/session/session-1").kind).toBe("session");
    expect(parseRoute("#/workflows").kind).toBe("workflows");
    expect(parseRoute("#/settings").kind).toBe("settings");
    expect(parseRoute("#/pane-harness/terminal/session-1").kind).toBe("pane-harness");
  });

  it("refuses a pane-harness address missing either of its two required segments", () => {
    // Both segments are grammar rather than convenience: the pane bodies the
    // harness mounts are session-scoped, so an address naming a kind and no
    // session would open a harness whose panes could only render their own
    // not-bound absence.
    expect(parseRoute("#/pane-harness").kind).toBe("not-found");
    expect(parseRoute("#/pane-harness/terminal").kind).toBe("not-found");
    expect(parseRoute("#/pane-harness/terminal/session-1/extra").kind).toBe("not-found");
    expect(parseRoute("#/pane-harness/terminal/%zz").kind).toBe("not-found");
  });
});
