// What the rail shows, and where each of its destinations goes.
//
// Both halves are the FRAME's decisions rather than the rail's. `IconRail` renders
// the entries it is handed and knows nothing about sessions; the routing family
// knows nothing about a rail. This module is the one place the two meet.
//
// THE DESTINATIONS ARE UNCONDITIONAL. `Spec-023 §Console Design (Meridian)` §The
// surface set gives the main window three destinations — sessions, workflows,
// settings — and every one of them is reachable from every main-window route, so
// the entries are a constant rather than a function of window state. They used to
// be neither: a fourth entry, Workspace, was shown or hidden on whether this window
// had a session in hand. The session workspace is reached from the sessions
// destination instead, which is why `railDestinationFor` maps a workspace route
// onto `sessions` and why the palette's "Go to Workspace" — an act, not a
// destination — lives beside these rather than among them.
//
// RENDER ORDER COMES FROM THE TUPLE. `RAIL_DESTINATIONS` declares the destinations
// in rail order and `RAIL_ENTRY_TEMPLATES` says what each one shows; walking the
// tuple to build the entries keeps the two claims separate — the set is the table's
// (total, compiler-checked), the sequence is the tuple's — and means a destination
// can never be shown in an order nobody declared.

import { RAIL_DESTINATIONS, type ConsoleRoute, type RailDestination } from "../routing/index.js";
import { RAIL_ENTRY_TEMPLATES, type RailEntry } from "./IconRail.js";

/**
 * The rail's contents, built once.
 *
 * A module constant rather than a builder called per render: nothing about it
 * varies with the window, so a function would hand `AppFrame` a new array on every
 * pass and re-render the console's most-seen surface for a value that never
 * changed.
 */
export const RAIL_ENTRIES: readonly RailEntry[] = RAIL_DESTINATIONS.map((destination) => ({
  destination,
  ...RAIL_ENTRY_TEMPLATES[destination],
}));

/**
 * Where a rail click goes.
 *
 * Total and argument-free by construction: each destination is a top-level context
 * that needs nothing of the window to be entered. `railDestinationFor` is the
 * inverse on every arm — a click lands on a route the rail reports as that same
 * destination — and `rail-navigation.test.ts` holds the pair to it.
 */
export function routeForDestination(destination: RailDestination): ConsoleRoute {
  switch (destination) {
    case "sessions":
      return { kind: "sessions" };
    case "workflows":
      return { kind: "workflows" };
    case "settings":
      return { kind: "settings", page: undefined };
  }
}
