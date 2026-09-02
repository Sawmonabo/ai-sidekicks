// The rail's order is the tuple's, and its availability rule is the retained
// session's.
//
// Two separable claims, and the reason they are separable is the point of the entry
// table's shape: the SET of destinations is the table's (total over the union, held
// by the compiler), and the SEQUENCE is `RAIL_DESTINATIONS`'. A record's key order
// would have been a third, accidental source of truth for the second one, so the
// control below shows the two orders are genuinely different things rather than the
// same thing observed twice.
//
// The third claim is newer and is the one this module got wrong: availability and
// destination are ONE decision. The rule used to read the current route, so the
// Workspace entry disappeared the moment a person left a workspace for Settings —
// while `SessionStoreRegistry` still held that session open, so the destination was
// live and simply unreachable. Both functions now read the same retained id, and the
// last case here is what holds them to it: an entry the rail offers is an entry the
// router can route.

import { describe, expect, it } from "vitest";

import { RAIL_DESTINATIONS, type RailDestination } from "../routing/index.js";
import { RAIL_ENTRY_TEMPLATES, type RailEntryTemplate } from "./IconRail.js";
import { buildRailEntries, routeForDestination } from "./rail-navigation.js";

/** A window that has opened a session, whatever route it is on now. */
const RETAINED_SESSION_ID = "session-1";

/** A window that has not opened one yet. */
const NO_RETAINED_SESSION = undefined;

/** The same entries, written in a different key order. The control's subject. */
const REORDERED_TABLE: Readonly<Record<RailDestination, RailEntryTemplate>> = {
  settings: RAIL_ENTRY_TEMPLATES.settings,
  sessions: RAIL_ENTRY_TEMPLATES.sessions,
  workspace: RAIL_ENTRY_TEMPLATES.workspace,
};

function availabilityOf(
  lastOpenedSessionId: string | undefined,
  destination: RailDestination,
): boolean {
  const entry = buildRailEntries(lastOpenedSessionId).find(
    (candidate) => candidate.destination === destination,
  );
  if (entry === undefined) {
    throw new Error(`no rail entry for ${destination}`);
  }
  return entry.isAvailable;
}

describe("buildRailEntries — order comes from the tuple", () => {
  it("emits one entry per destination, in rail order", () => {
    expect(buildRailEntries(NO_RETAINED_SESSION).map((entry) => entry.destination)).toStrictEqual([
      ...RAIL_DESTINATIONS,
    ]);
  });

  it("negative control: a table's key order is not the tuple's order", () => {
    // If the entries were built by walking the table, this is the order they would
    // come out in — which is why they are not built that way.
    expect(Object.keys(REORDERED_TABLE)).not.toStrictEqual([...RAIL_DESTINATIONS]);
  });

  it("carries each destination's label and glyph from the table", () => {
    for (const entry of buildRailEntries(NO_RETAINED_SESSION)) {
      expect(entry.label, entry.destination).toBe(RAIL_ENTRY_TEMPLATES[entry.destination].label);
      expect(entry.glyph, entry.destination).toBe(RAIL_ENTRY_TEMPLATES[entry.destination].glyph);
    }
  });
});

describe("buildRailEntries — workspace is absent until a session has been opened", () => {
  it("hides workspace in a window that has opened none", () => {
    expect(availabilityOf(NO_RETAINED_SESSION, "workspace")).toBe(false);
  });

  it("shows workspace once one has been opened", () => {
    expect(availabilityOf(RETAINED_SESSION_ID, "workspace")).toBe(true);
  });

  it("never hides the two destinations that are always reachable", () => {
    for (const retained of [NO_RETAINED_SESSION, RETAINED_SESSION_ID]) {
      expect(availabilityOf(retained, "sessions"), String(retained)).toBe(true);
      expect(availabilityOf(retained, "settings"), String(retained)).toBe(true);
    }
  });
});

describe("routeForDestination — where a rail click goes", () => {
  it("routes sessions and settings without needing a session", () => {
    expect(routeForDestination("sessions", NO_RETAINED_SESSION)).toStrictEqual({
      kind: "sessions",
    });
    expect(routeForDestination("settings", NO_RETAINED_SESSION)).toStrictEqual({
      kind: "settings",
      page: undefined,
    });
  });

  it("routes workspace to the retained session", () => {
    expect(routeForDestination("workspace", RETAINED_SESSION_ID)).toStrictEqual({
      kind: "workspace",
      sessionId: RETAINED_SESSION_ID,
    });
  });

  it("routes workspace with no session to the sessions list rather than nowhere", () => {
    expect(routeForDestination("workspace", NO_RETAINED_SESSION)).toStrictEqual({
      kind: "sessions",
    });
  });
});

describe("the rail and the router answer from one value", () => {
  it("offers workspace exactly when the router can route to a workspace", () => {
    // The defect this pins is a rail that shows a destination the router answers
    // with the sessions list — a control that looks like a way back and is not.
    for (const retained of [NO_RETAINED_SESSION, RETAINED_SESSION_ID]) {
      expect(availabilityOf(retained, "workspace"), String(retained)).toBe(
        routeForDestination("workspace", retained).kind === "workspace",
      );
    }
  });
});
