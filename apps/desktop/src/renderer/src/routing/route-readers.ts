// What a caller asks of a route once it has one. `routes.ts` owns the grammar; this module owns
// the questions, so a caller never narrows the union's arms by hand and two callers cannot
// disagree about the same route.

import type { AppRoute } from "./routes.js";

/**
 * Destinations on the icon rail, in rail order. Closed; the rail renders exactly these.
 * A tuple rather than a union so the rail's entry table can be checked against it at runtime.
 */
export const RAIL_DESTINATIONS = ["sessions", "workflows", "settings"] as const;

/** One icon-rail destination, derived from the tuple above. */
export type RailDestination = (typeof RAIL_DESTINATIONS)[number];

/** One phase of one run, as a session screen address names it; derived from the route arm. */
export type WorkflowPhaseFocus = NonNullable<
  Extract<AppRoute, { kind: "session" }>["workflowPhase"]
>;

/**
 * Which rail destination is current, or `undefined` where the route lights none.
 *
 * Not one-to-one: a session is reached from the sessions destination, so the session screen
 * lights `sessions`. The rail has no icon of its own for it.
 */
export function railDestinationFor(route: AppRoute): RailDestination | undefined {
  switch (route.kind) {
    case "sessions":
    case "session":
      return "sessions";
    case "workflows":
      return "workflows";
    case "settings":
      return "settings";
    case "pane-harness":
    case "not-found":
      return undefined;
  }
}

/**
 * The page-scoped selection a settings address carries, or `undefined` where none is.
 * `selection` exists on only one settings arm, so callers read it here instead of narrowing.
 */
export function settingsSelection(route: AppRoute): string | undefined {
  return route.kind === "settings" && route.page !== undefined ? route.selection : undefined;
}

/**
 * The settings address for one page, scoped to a selection where the caller has one.
 * Omits the `selection` key when there is none, which the parse round trip depends on.
 */
export function settingsRoute(page: string, selection: string | undefined): AppRoute {
  return selection === undefined
    ? { kind: "settings", page }
    : { kind: "settings", page, selection };
}

/**
 * The session a route is scoped to, or `undefined` where it names none.
 * `sessionId` exists on only some arms, so callers read it here instead of narrowing.
 */
export function routeSessionId(route: AppRoute): string | undefined {
  switch (route.kind) {
    case "session":
    case "pane-harness":
      return route.sessionId;
    case "sessions":
    case "workflows":
    case "settings":
    case "not-found":
      return undefined;
  }
}

/** Structural route comparison, so an unchanged hash costs no transition. */
export function routesAreEqual(left: AppRoute, right: AppRoute): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "sessions":
    case "workflows":
      return true;
    case "session":
      return (
        right.kind === "session" &&
        left.sessionId === right.sessionId &&
        workflowPhaseFocusesAreEqual(left.workflowPhase, right.workflowPhase)
      );
    case "pane-harness":
      return (
        right.kind === "pane-harness" &&
        left.paneKind === right.paneKind &&
        left.sessionId === right.sessionId
      );
    case "settings":
      return (
        right.kind === "settings" &&
        left.page === right.page &&
        settingsSelection(left) === settingsSelection(right)
      );
    case "not-found":
      return right.kind === "not-found" && left.attempted === right.attempted;
  }
}

/**
 * The session screen arm's focus, compared field by field. Both absent is equal; one absent is
 * not, because a bare session address and a focused one are different places.
 */
function workflowPhaseFocusesAreEqual(
  left: WorkflowPhaseFocus | undefined,
  right: WorkflowPhaseFocus | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.workflowRunId === right.workflowRunId && left.phaseId === right.phaseId;
}
