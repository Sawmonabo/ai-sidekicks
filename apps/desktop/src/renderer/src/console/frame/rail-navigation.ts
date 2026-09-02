// What the rail shows, and where each of its destinations goes.
//
// Both halves are the FRAME's decisions rather than the rail's. `IconRail` renders
// the entries it is handed and knows nothing about sessions; the routing family
// knows nothing about a rail. This module is the one place the two meet, which is
// why the availability rule ("workspace is absent until this window has a session
// to go back to") lives here and not in either of them.
//
// AVAILABILITY IS NOT READ OFF THE ROUTE. It used to be, and that made the
// Workspace entry vanish the moment a person opened a session and then went to
// Settings — the new route named no session, so the rule read false while the
// session was still open and still the one Workspace meant. Both functions take the
// window's retained session id instead, and they take the SAME one: an entry that is
// shown is an entry `routeForDestination` can route, because one value answers both.
//
// RENDER ORDER COMES FROM THE TUPLE. `RAIL_DESTINATIONS` declares the destinations
// in rail order and `RAIL_ENTRY_TEMPLATES` says what each one shows; walking the
// tuple to build the entries keeps the two claims separate — the set is the table's
// (total, compiler-checked), the sequence is the tuple's — and means a destination
// can never be shown in an order nobody declared.

import { RAIL_DESTINATIONS, type ConsoleRoute, type RailDestination } from "../routing/index.js";
import { RAIL_ENTRY_TEMPLATES, type RailEntry } from "./IconRail.js";

/**
 * The rail's contents.
 *
 * `lastOpenedSessionId` is the session this window has in hand — `FrameStore` keeps
 * it across a route that names none — and Workspace is absent until there is one.
 */
export function buildRailEntries(lastOpenedSessionId: string | undefined): readonly RailEntry[] {
  return RAIL_DESTINATIONS.map((destination) => ({
    destination,
    ...RAIL_ENTRY_TEMPLATES[destination],
    isAvailable: destination === "workspace" ? lastOpenedSessionId !== undefined : true,
  }));
}

/**
 * Where a rail click goes.
 *
 * Workspace with no session at all resolves to the sessions list rather than to a
 * workspace route with no session to name. The rail hides that destination in
 * exactly that case, so the arm is unreachable through the rail — and it is written
 * anyway, because the alternative is a total function that cannot be made total: a
 * `workspace` route requires a session id, and inventing one would be worse than
 * landing somewhere real.
 */
export function routeForDestination(
  destination: RailDestination,
  lastOpenedSessionId: string | undefined,
): ConsoleRoute {
  switch (destination) {
    case "sessions":
      return { kind: "sessions" };
    case "settings":
      return { kind: "settings", page: undefined };
    case "workspace":
      return lastOpenedSessionId === undefined
        ? { kind: "sessions" }
        : { kind: "workspace", sessionId: lastOpenedSessionId };
  }
}
