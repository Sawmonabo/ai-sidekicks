// The rail's order is the tuple's, and its availability rule is the route's.
//
// Two separable claims, and the reason they are separable is the point of the entry
// table's shape: the SET of destinations is the table's (total over the union, held
// by the compiler), and the SEQUENCE is `RAIL_DESTINATIONS`'. A record's key order
// would have been a third, accidental source of truth for the second one, so the
// control below shows the two orders are genuinely different things rather than the
// same thing observed twice.

import { describe, expect, it } from "vitest";

import { RAIL_DESTINATIONS, type ConsoleRoute, type RailDestination } from "../routing/index.js";
import { RAIL_ENTRY_TEMPLATES, type RailEntryTemplate } from "./IconRail.js";
import { buildRailEntries, routeForDestination } from "./rail-navigation.js";

const SESSIONS_ROUTE: ConsoleRoute = { kind: "sessions" };
const WORKSPACE_ROUTE: ConsoleRoute = { kind: "workspace", sessionId: "session-1" };
const BARE_TIMELINE_ROUTE: ConsoleRoute = { kind: "auxiliary", route: "timeline" };
const SEATED_TIMELINE_ROUTE: ConsoleRoute = {
  kind: "auxiliary",
  route: "timeline",
  sessionId: "session-1",
};

/** The same entries, written in a different key order. The control's subject. */
const REORDERED_TABLE: Readonly<Record<RailDestination, RailEntryTemplate>> = {
  settings: RAIL_ENTRY_TEMPLATES.settings,
  sessions: RAIL_ENTRY_TEMPLATES.sessions,
  workspace: RAIL_ENTRY_TEMPLATES.workspace,
};

describe("buildRailEntries — order comes from the tuple", () => {
  it("emits one entry per destination, in rail order", () => {
    expect(buildRailEntries(SESSIONS_ROUTE).map((entry) => entry.destination)).toStrictEqual([
      ...RAIL_DESTINATIONS,
    ]);
  });

  it("negative control: a table's key order is not the tuple's order", () => {
    // If the entries were built by walking the table, this is the order they would
    // come out in — which is why they are not built that way.
    expect(Object.keys(REORDERED_TABLE)).not.toStrictEqual([...RAIL_DESTINATIONS]);
  });

  it("carries each destination's label and glyph from the table", () => {
    for (const entry of buildRailEntries(SESSIONS_ROUTE)) {
      expect(entry.label, entry.destination).toBe(RAIL_ENTRY_TEMPLATES[entry.destination].label);
      expect(entry.glyph, entry.destination).toBe(RAIL_ENTRY_TEMPLATES[entry.destination].glyph);
    }
  });
});

describe("buildRailEntries — workspace is absent with no session open", () => {
  function availabilityOf(route: ConsoleRoute, destination: RailDestination): boolean {
    const entry = buildRailEntries(route).find(
      (candidate) => candidate.destination === destination,
    );
    if (entry === undefined) {
      throw new Error(`no rail entry for ${destination}`);
    }
    return entry.isAvailable;
  }

  it("hides workspace on the sessions list", () => {
    expect(availabilityOf(SESSIONS_ROUTE, "workspace")).toBe(false);
  });

  it("shows workspace on a session route", () => {
    expect(availabilityOf(WORKSPACE_ROUTE, "workspace")).toBe(true);
  });

  it("hides workspace in an auxiliary window that has no subject yet", () => {
    expect(availabilityOf(BARE_TIMELINE_ROUTE, "workspace")).toBe(false);
  });

  it("shows workspace in an auxiliary window that has one", () => {
    expect(availabilityOf(SEATED_TIMELINE_ROUTE, "workspace")).toBe(true);
  });

  it("never hides the two destinations that are always reachable", () => {
    for (const route of [SESSIONS_ROUTE, WORKSPACE_ROUTE, BARE_TIMELINE_ROUTE]) {
      expect(availabilityOf(route, "sessions"), route.kind).toBe(true);
      expect(availabilityOf(route, "settings"), route.kind).toBe(true);
    }
  });
});

describe("routeForDestination — where a rail click goes", () => {
  it("routes sessions and settings without needing a session", () => {
    expect(routeForDestination("sessions", undefined)).toStrictEqual({ kind: "sessions" });
    expect(routeForDestination("settings", undefined)).toStrictEqual({
      kind: "settings",
      page: undefined,
    });
  });

  it("routes workspace to the open session", () => {
    expect(routeForDestination("workspace", "session-1")).toStrictEqual({
      kind: "workspace",
      sessionId: "session-1",
    });
  });

  it("routes workspace with no session to the sessions list rather than nowhere", () => {
    expect(routeForDestination("workspace", undefined)).toStrictEqual({ kind: "sessions" });
  });
});
