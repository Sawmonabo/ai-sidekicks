// Routes as values: parsed, rendered back, compared, and classified. `parseRoute` and
// `formatRoute` are two hand-written grammars over one shape, so the round trip is the case that
// catches a route that reopens somewhere else after a restart. Malformed-input arms are in
// `routes.failure-modes.test.ts`.

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
    // A `formatRoute` returning a constant would otherwise satisfy a parser that returned the
    // default route for everything.
    const rendered = MAIN_WINDOW_ROUTES.map((route) => formatRoute(route));
    expect(new Set(rendered).size).toBe(rendered.length);
  });
});

describe("routes — the default", () => {
  it("is where a window with no hash lands", () => {
    expect(parseRoute("")).toStrictEqual(DEFAULT_ROUTE);
  });

  it("normalizes to an explicit hash rather than rendering back to nothing", () => {
    // The explicit hash survives a change of default.
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
    // `#/settings/<page>/<selection>` is grammar, so the overrun is a third segment.
    expect(parseRoute("#/settings/one/two/three").kind).toBe("not-found");
  });

  it("round-trips a settings address carrying its page's own selection", () => {
    // A parser reading the second segment differently would open the page for another
    // provider or none.
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
    // The session screen is `#/session/<id>`; `#/workspace` would be a second address for it.
    expect(parseRoute("#/workspace")).toStrictEqual({
      kind: "not-found",
      attempted: "#/workspace",
    });
  });

  it("refuses a session route with no session id", () => {
    expect(parseRoute("#/session").kind).toBe("not-found");
  });

  it("carries the attempted hash, so the not-found screen says what it could not open", () => {
    // A not-found that names nothing renders as an unexplained error.
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
    // The pane bodies the harness mounts are session-scoped, so a kind without a session
    // could only render the pane's own not-bound state.
    expect(parseRoute("#/pane-harness").kind).toBe("not-found");
    expect(parseRoute("#/pane-harness/terminal").kind).toBe("not-found");
    expect(parseRoute("#/pane-harness/terminal/session-1/extra").kind).toBe("not-found");
    expect(parseRoute("#/pane-harness/terminal/%zz").kind).toBe("not-found");
  });
});
