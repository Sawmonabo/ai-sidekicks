// Routes as values: parsed and rendered back. `parseRoute` and `formatRoute` are two hand-written
// grammars over one shape, so the round trip is the case that catches a route that reopens
// somewhere else after a reload. A hash from an older build must land somewhere legible: the
// empty hash is not an error, and a malformed escape must not throw.

import { describe, expect, it } from "vitest";

import { formatRoute, parseRoute, type AppRoute } from "./routes.js";

/** Main-window routes, including the arms that carry an optional segment. */
const MAIN_WINDOW_ROUTES: readonly AppRoute[] = [
  { kind: "sessions" },
  { kind: "session", sessionId: "session-1" },
  // The same arm carrying its optional focus, listed beside the bare session address.
  {
    kind: "session",
    sessionId: "session-1",
    workflowPhase: { workflowRunId: "run-1", phaseId: "review" },
  },
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
});
