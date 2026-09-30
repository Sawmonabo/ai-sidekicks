// The rail's order comes from the `RAIL_DESTINATIONS` tuple, not from the entry table's key order,
// and every destination round-trips through the router: a click lands on a route the rail reports
// as that same destination.

import { describe, expect, it } from "vitest";

import {
  RAIL_DESTINATIONS,
  railDestinationFor,
  type RailDestination,
} from "@renderer/routing/route-readers.js";
import { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { RAIL_ENTRY_TEMPLATES, type RailEntryTemplate } from "./NavigationRail.js";
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
    // Entries built by walking the table would come out in this order, which is why they are not.
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
    // Without this, a router answering the sessions list for everything would leave two icons dead.
    const addresses = RAIL_DESTINATIONS.map((destination) =>
      JSON.stringify(routeForDestination(destination)),
    );
    expect(new Set(addresses).size).toBe(RAIL_DESTINATIONS.length);
  });
});

describe("the rail and the router answer from one set", () => {
  it("lands every entry on a route the rail reports as that same entry", () => {
    // Pins a click that leaves the pressed icon unhighlighted; walking the tuple stops a fourth
    // destination being added on one side alone.
    for (const destination of RAIL_DESTINATIONS) {
      expect(railDestinationFor(routeForDestination(destination)), destination).toBe(destination);
    }
  });

  it("offers exactly the destinations the routing module declares", () => {
    expect(RAIL_ENTRIES.map((entry) => entry.destination)).toStrictEqual([
      "sessions",
      "workflows",
      "settings",
    ]);
  });
});

describe("warmDestination — the screen a press is about to mount", () => {
  /** A board of loader-backed screens, and a record of which chunks were asked for. */
  function boardOverDestinations(): {
    readonly screenRegistry: ScreenRegistry;
    readonly loaded: string[];
  } {
    const loaded: string[] = [];
    const screenRegistry = new ScreenRegistry();
    for (const destination of RAIL_DESTINATIONS) {
      screenRegistry.register({
        name: destination,
        owner: destination,
        body: () => {
          loaded.push(destination);
          return Promise.resolve<{ Body: (context: ScreenContext) => React.ReactNode }>({
            Body: () => null,
          });
        },
      });
    }
    return { screenRegistry, loaded };
  }

  it("resolves each destination through the route table to its own screen", async () => {
    // Holds every destination to the screen its own route resolves to.
    for (const destination of RAIL_DESTINATIONS) {
      const { screenRegistry, loaded } = boardOverDestinations();
      warmDestination(screenRegistry, destination);
      await Promise.resolve();
      expect(loaded, destination).toStrictEqual([destination]);
    }
  });

  it("warms one destination and not the board", async () => {
    const { screenRegistry, loaded } = boardOverDestinations();
    warmDestination(screenRegistry, "workflows");
    await Promise.resolve();
    expect(loaded).toStrictEqual(["workflows"]);
    expect(screenRegistry.unloadedKeys()).toStrictEqual(["sessions", "settings"]);
  });

  it("costs one fetch however often a person passes over the same entry", async () => {
    // The highlight moves with every arrow key, so this runs far more often than a navigation.
    const { screenRegistry, loaded } = boardOverDestinations();
    warmDestination(screenRegistry, "settings");
    warmDestination(screenRegistry, "settings");
    warmDestination(screenRegistry, "settings");
    await Promise.resolve();
    expect(loaded).toStrictEqual(["settings"]);
  });

  it("does nothing for a destination whose screen is component-form", () => {
    // A caller need not ask first whether the screen is loader-backed.
    const screenRegistry = new ScreenRegistry();
    screenRegistry.register({ name: "sessions", owner: "sessions", render: () => null });
    expect(() => {
      warmDestination(screenRegistry, "sessions");
    }).not.toThrow();
    expect(screenRegistry.unloadedKeys()).toStrictEqual([]);
  });

  it("swallows a chunk that will not load rather than raising it here", async () => {
    // A failed speculative fetch belongs to the mount's error boundary; an unhandled rejection from
    // a hover would report a crash for a destination nobody entered.
    const screenRegistry = new ScreenRegistry();
    screenRegistry.register({
      name: "workflows",
      owner: "workflows",
      body: () => Promise.reject(new Error("chunk unavailable")),
    });
    expect(() => {
      warmDestination(screenRegistry, "workflows");
    }).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("negative control: an empty board is warmed without complaint and stays empty", () => {
    // Without this, the cases above would pass over a `warmDestination` that registered something.
    const screenRegistry = new ScreenRegistry();
    for (const destination of RAIL_DESTINATIONS) {
      warmDestination(screenRegistry, destination);
    }
    expect(screenRegistry.registeredScreenNames()).toStrictEqual([]);
  });
});
