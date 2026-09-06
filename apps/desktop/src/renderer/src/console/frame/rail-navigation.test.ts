// The rail's order is the tuple's, and its destinations round-trip through the
// router.
//
// Two separable claims, and the reason they are separable is the point of the entry
// table's shape: the SET of destinations is the table's (total over the union, held
// by the compiler), and the SEQUENCE is `RAIL_DESTINATIONS`'. A record's key order
// would have been a third, accidental source of truth for the second one, so the
// control below shows the two orders are genuinely different things rather than the
// same thing observed twice.
//
// The third claim is the one this module got wrong, and it was wrong about WHICH
// destinations exist rather than about when they are shown. `Spec-023 §Console
// Design (Meridian)` §The surface set names sessions, workflows, and settings; the
// rail shipped sessions, workspace, and settings, so the destination that opens the
// workflow builder was unreachable and the session workspace — a route reached from
// the sessions list — was carrying a rail icon that had to be hidden half the time
// to make sense. The last case here is what holds the pair straight now: a click on
// an entry lands on a route the rail reports as that same entry, for every one of
// them.

import { describe, expect, it } from "vitest";

import { RAIL_DESTINATIONS, railDestinationFor, type RailDestination } from "../routing/index.js";
import { ConsoleSurfaceRegistry, type ConsoleSurfaceContext } from "../seats/index.js";
import { RAIL_ENTRY_TEMPLATES, type RailEntryTemplate } from "./IconRail.js";
import { RAIL_ENTRIES, routeForDestination, warmDestination } from "./rail-navigation.js";

/** The same entries, written in a different key order. The control's subject. */
const REORDERED_TABLE: Readonly<Record<RailDestination, RailEntryTemplate>> = {
  settings: RAIL_ENTRY_TEMPLATES.settings,
  sessions: RAIL_ENTRY_TEMPLATES.sessions,
  workflows: RAIL_ENTRY_TEMPLATES.workflows,
};

describe("RAIL_ENTRIES — order comes from the tuple", () => {
  it("emits one entry per destination, in rail order", () => {
    expect(RAIL_ENTRIES.map((entry) => entry.destination)).toStrictEqual([...RAIL_DESTINATIONS]);
  });

  it("negative control: a table's key order is not the tuple's order", () => {
    // If the entries were built by walking the table, this is the order they would
    // come out in — which is why they are not built that way.
    expect(Object.keys(REORDERED_TABLE)).not.toStrictEqual([...RAIL_DESTINATIONS]);
  });

  it("carries each destination's label and glyph from the table", () => {
    for (const entry of RAIL_ENTRIES) {
      expect(entry.label, entry.destination).toBe(RAIL_ENTRY_TEMPLATES[entry.destination].label);
      expect(entry.glyph, entry.destination).toBe(RAIL_ENTRY_TEMPLATES[entry.destination].glyph);
    }
  });
});

describe("routeForDestination — where a rail click goes", () => {
  it("routes each destination to its own top-level address", () => {
    expect(routeForDestination("sessions")).toStrictEqual({ kind: "sessions" });
    expect(routeForDestination("workflows")).toStrictEqual({ kind: "workflows" });
    expect(routeForDestination("settings")).toStrictEqual({ kind: "settings", page: undefined });
  });

  it("negative control: no two destinations land on one route", () => {
    // Without this, a router that answered the sessions list for everything would
    // satisfy the case above's shape while making two of the three icons dead.
    const addresses = RAIL_DESTINATIONS.map((destination) =>
      JSON.stringify(routeForDestination(destination)),
    );
    expect(new Set(addresses).size).toBe(RAIL_DESTINATIONS.length);
  });
});

describe("the rail and the router answer from one set", () => {
  it("lands every entry on a route the rail reports as that same entry", () => {
    // The defect this pins is a rail whose click leaves the pressed icon
    // unhighlighted — a control that navigates somewhere and then denies it. The
    // pair is walked from the tuple rather than case by case, so a fourth
    // destination cannot be added on one side alone.
    for (const destination of RAIL_DESTINATIONS) {
      expect(railDestinationFor(routeForDestination(destination)), destination).toBe(destination);
    }
  });

  it("offers exactly the destinations the routing family declares", () => {
    expect(RAIL_ENTRIES.map((entry) => entry.destination)).toStrictEqual([
      "sessions",
      "workflows",
      "settings",
    ]);
  });
});

describe("warmDestination — the surface a press is about to mount", () => {
  /** A board of loader-backed surfaces, and a record of which chunks were asked for. */
  function boardOverDestinations(): {
    readonly surfaceRegistry: ConsoleSurfaceRegistry;
    readonly loaded: string[];
  } {
    const loaded: string[] = [];
    const surfaceRegistry = new ConsoleSurfaceRegistry();
    for (const destination of RAIL_DESTINATIONS) {
      surfaceRegistry.register({
        slot: destination,
        owner: `${destination}-family`,
        body: () => {
          loaded.push(destination);
          return Promise.resolve<{ Body: (context: ConsoleSurfaceContext) => React.ReactNode }>({
            Body: () => null,
          });
        },
      });
    }
    return { surfaceRegistry, loaded };
  }

  it("resolves each destination through the route table to its own slot", async () => {
    // The step that could go wrong twice: a second open-coded reading of
    // `surfaceSlotFor` would drift the first time a destination changed slots, so the
    // walk holds every destination to the slot its own route resolves to.
    for (const destination of RAIL_DESTINATIONS) {
      const { surfaceRegistry, loaded } = boardOverDestinations();
      warmDestination(surfaceRegistry, destination);
      await Promise.resolve();
      expect(loaded, destination).toStrictEqual([destination]);
    }
  });

  it("warms one destination and not the board", async () => {
    const { surfaceRegistry, loaded } = boardOverDestinations();
    warmDestination(surfaceRegistry, "workflows");
    await Promise.resolve();
    expect(loaded).toStrictEqual(["workflows"]);
    expect(surfaceRegistry.unloadedKeys()).toStrictEqual(["sessions", "settings"]);
  });

  it("costs one fetch however often a person passes over the same entry", async () => {
    // Highlight moves with every arrow key and a press follows a hover, so this runs
    // far more often than a navigation does.
    const { surfaceRegistry, loaded } = boardOverDestinations();
    warmDestination(surfaceRegistry, "settings");
    warmDestination(surfaceRegistry, "settings");
    warmDestination(surfaceRegistry, "settings");
    await Promise.resolve();
    expect(loaded).toStrictEqual(["settings"]);
  });

  it("does nothing for a destination whose surface is component-form", () => {
    // A caller must not have to ask first whether what it is about to open is
    // loader-backed, or every call site carries a copy of that question.
    const surfaceRegistry = new ConsoleSurfaceRegistry();
    surfaceRegistry.register({ slot: "sessions", owner: "sessions-family", render: () => null });
    expect(() => {
      warmDestination(surfaceRegistry, "sessions");
    }).not.toThrow();
    expect(surfaceRegistry.unloadedKeys()).toStrictEqual([]);
  });

  it("swallows a chunk that will not load rather than raising it here", async () => {
    // A speculative fetch has nobody waiting on it; a chunk that cannot be fetched is a
    // damaged install, and the honest surface for that is the mount, where the console's
    // error boundary can say so. An unhandled rejection from a hover would be a crash
    // report for a destination nobody entered.
    const surfaceRegistry = new ConsoleSurfaceRegistry();
    surfaceRegistry.register({
      slot: "workflows",
      owner: "workflows-family",
      body: () => Promise.reject(new Error("chunk unavailable")),
    });
    expect(() => {
      warmDestination(surfaceRegistry, "workflows");
    }).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("negative control: an empty board is warmed without complaint and stays empty", () => {
    // Without this, the cases above would pass over a `warmDestination` that registered
    // something of its own on the way past.
    const surfaceRegistry = new ConsoleSurfaceRegistry();
    for (const destination of RAIL_DESTINATIONS) {
      warmDestination(surfaceRegistry, destination);
    }
    expect(surfaceRegistry.registeredSlots()).toStrictEqual([]);
  });
});
