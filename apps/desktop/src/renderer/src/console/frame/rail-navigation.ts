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
import { surfaceSlotFor, type ConsoleSurfaceRegistry } from "../seats/index.js";
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
 * The rail's contents with this window's attention count on the sessions entry.
 *
 * RETURNS THE CONSTANT UNCHANGED when there is no count, which is the ordinary case
 * and the reason this is a function rather than a mapped value: an array rebuilt
 * every render would re-render the console's most-seen surface for a value that did
 * not move, and the identity check above the rail is what keeps that from happening.
 *
 * Only the sessions destination carries one. The other two have no read behind them
 * that produces a count, and inventing one for them would be the renderer deciding
 * that a destination needs a person.
 */
export function railEntriesWithAttention(attentionCount: number | undefined): readonly RailEntry[] {
  if (attentionCount === undefined) {
    return RAIL_ENTRIES;
  }
  return RAIL_ENTRIES.map((entry) =>
    entry.destination === "sessions" ? { ...entry, attentionCount } : entry,
  );
}

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

/**
 * Start loading the surface a destination would mount, without navigating to it.
 *
 * BEFORE THE ROUTE COMMITS, which is the whole of what this is for. Both of the
 * console's ways into a destination call it at the moment the intent is legible and the
 * act has not happened — the rail's press, just before it navigates, and the palette's
 * highlighted row, while a person is still reading it. By the time the route resolves,
 * the chunk is either in flight or already there, so the reserved frame the surface
 * would otherwise show is one a person never sees.
 *
 * ONE FUNCTION AND NOT TWO CALL SITES' WORTH, because the destination-to-slot step is
 * the thing that could go wrong twice: `surfaceSlotFor` is the map, and a second
 * open-coded reading of it would drift the first time a destination changed slots.
 *
 * A destination whose surface is component-form, or not registered at all, settles
 * immediately with nothing done — so no caller has to ask first whether the thing it is
 * about to open is loader-backed.
 */
export function warmDestination(
  surfaceRegistry: ConsoleSurfaceRegistry,
  destination: RailDestination,
): void {
  // Fire-and-forget, and the rejection is dropped on the idle warm's own reasoning: a
  // speculative fetch has nobody waiting on it, and a chunk that will not load is a
  // damaged install whose honest surface is the mount, where the console's error
  // boundary can say so. A rail press has a painted surface under it already, so waiting
  // here would be a stall where the reserved frame is the honest thing to show.
  void warmRouteSurface(surfaceRegistry, routeForDestination(destination));
}

/**
 * Start loading the surface a ROUTE would mount, and settle when it has landed.
 *
 * THE STEP `warmDestination` IS BUILT ON, hoisted because a second caller reaches a
 * surface by a route the rail has no destination for. The frame's context picker is that
 * caller: a bare auxiliary window resolves its subject there, and what it commits is an
 * `auxiliary` route rather than one of the rail's three. Open-coding the slot lookup
 * beside it would be a second reading of `surfaceSlotFor` to drift from this one.
 *
 * NEVER REJECTS, so a caller may await it without a `catch` of its own and a caller that
 * does not may drop it. What a chunk that will not load means is a damaged install, and
 * the honest place to say so is the mount, inside the console's own surface error
 * boundary — not at a warm nobody is watching.
 *
 * A route whose surface is component-form, or not registered at all, settles immediately
 * with nothing done, so no caller has to ask first whether the thing it is about to open
 * is loader-backed.
 */
export async function warmRouteSurface(
  surfaceRegistry: ConsoleSurfaceRegistry,
  route: ConsoleRoute,
): Promise<void> {
  const slot = surfaceSlotFor(route);
  if (slot === undefined) {
    return;
  }
  await surfaceRegistry.preload(slot).catch(() => undefined);
}
