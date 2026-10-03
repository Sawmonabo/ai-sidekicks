// Routes as values: parsed and rendered back. `parseRoute` and `formatRoute` are two hand-written
// grammars over one shape, so the round trip is the case that catches a route that reopens
// somewhere else after a reload. A hash the app did not write (a user, a stale bookmark, an
// older build) must land somewhere legible: the empty hash is not an error, every shape the
// grammar does not have resolves to not-found, a malformed escape must not throw, and an empty
// segment must not be dropped, or `#/session//foo` would open session `foo`.

import { describe, expect, it } from "vitest";

import { formatRoute, parseRoute, type AppRoute } from "./routes.js";

/** Main-window routes, including the arm that carries an optional segment. */
const MAIN_WINDOW_ROUTES: readonly AppRoute[] = [
  { kind: "sessions" },
  { kind: "session", sessionId: "session-1" },
  { kind: "workflows" },
  { kind: "settings", page: undefined },
  { kind: "settings", page: "providers" },
  // The paged arm carrying its page's own selection.
  { kind: "settings", page: "providers", selection: "codex" },
  // The pane harness a fixture launch registers.
  { kind: "pane-harness", paneKind: "terminal", sessionId: "session-1" },
  { kind: "not-found", attempted: "#/nowhere" },
];

describe("routes — every main-window route renders to a hash that parses back to it", () => {
  for (const route of MAIN_WINDOW_ROUTES) {
    it(`${route.kind}: ${formatRoute(route)}`, () => {
      expect(parseRoute(formatRoute(route))).toStrictEqual(route);
    });
  }
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

  it("decodes an escaped settings selection and renders it back escaped", () => {
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

  it("refuses a session route with no session id", () => {
    expect(parseRoute("#/session").kind).toBe("not-found");
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

describe("failure matrix — the router is handed an empty hash", () => {
  it("lands an empty hash on the default route", () => {
    expect(parseRoute("")).toStrictEqual({ kind: "sessions" });
    expect(parseRoute("#")).toStrictEqual({ kind: "sessions" });
    expect(parseRoute("#/")).toStrictEqual({ kind: "sessions" });
  });
});

describe("failure matrix — the router is handed a malformed percent-escape", () => {
  it("resolves a malformed session id to not-found rather than throwing", () => {
    // `decodeURIComponent("%zz")` raises `URIError`; thrown here it would escape
    // `WindowStore.adoptHash` and leave the window rendering nothing.
    expect(() => parseRoute("#/session/%zz")).not.toThrow();
    expect(parseRoute("#/session/%zz")).toStrictEqual({
      kind: "not-found",
      attempted: "#/session/%zz",
    });
  });

  it("resolves a malformed settings page to not-found rather than throwing", () => {
    // A second decode site, which is why the guard is one shared helper.
    expect(() => parseRoute("#/settings/%zz")).not.toThrow();
    expect(parseRoute("#/settings/%zz")).toStrictEqual({
      kind: "not-found",
      attempted: "#/settings/%zz",
    });
  });

  it("negative control: a well-formed escape on each arm still decodes", () => {
    // A parser that refused every escaped segment would otherwise satisfy the two refusals.
    expect(parseRoute("#/session/session%2Fone")).toStrictEqual({
      kind: "session",
      sessionId: "session/one",
    });
    expect(parseRoute("#/settings/provider%20accounts")).toStrictEqual({
      kind: "settings",
      page: "provider accounts",
    });
  });
});

describe("failure matrix — the router is handed an empty path segment", () => {
  it("refuses a doubled slash rather than selecting a different session", () => {
    // Dropping the empty segment would resolve this hash to session `foo`.
    expect(parseRoute("#/session//foo")).toStrictEqual({
      kind: "not-found",
      attempted: "#/session//foo",
    });
  });

  it("refuses a trailing slash on every main-window arm", () => {
    expect(parseRoute("#/sessions/").kind).toBe("not-found");
    expect(parseRoute("#/session/").kind).toBe("not-found");
    expect(parseRoute("#/settings/").kind).toBe("not-found");
  });
});
