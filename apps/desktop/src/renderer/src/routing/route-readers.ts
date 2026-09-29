// What a caller asks OF a route, once it has one.
//
// SPLIT FROM `routes.ts`, which owns the GRAMMAR — the union, the parser, and the
// formatter that is its exact inverse. This module owns the questions: which rail
// entry is lit, which session a route names, whether two routes are the same address,
// and the settings arm's page-scoped selection. The two halves fail differently — a
// grammar defect is an address that resolves to the wrong route or to none, a reader
// defect is a correct route read wrongly — and the dependency runs one way, from the
// questions to the grammar.
//
// EVERY ONE OF THESE EXISTS BECAUSE A NARROWING WOULD OTHERWISE BE WRITTEN AT EACH
// CALL SITE, and the union has arms that carry a member and arms that do not. A reader
// per call site is a reader per call site to disagree with, which is what
// `routeSessionId` and `settingsSelection` each record below.

import type { AppRoute } from "./routes.js";

/**
 * Destinations on the icon rail, in rail order. Closed; the rail renders exactly
 * these.
 *
 * A tuple rather than a bare union because "exactly these" is a claim about a set,
 * and a set nothing can walk at runtime cannot be held to it: the rail's own entry
 * table is an array, so a destination added to the union alone would typecheck and
 * render nowhere.
 */
export const RAIL_DESTINATIONS = ["sessions", "workflows", "settings"] as const;

/** One icon-rail destination, derived from the tuple above. */
export type RailDestination = (typeof RAIL_DESTINATIONS)[number];

/**
 * One phase of one run, as a workspace address names it.
 *
 * DERIVED FROM THE ARM RATHER THAN RESTATED BESIDE IT, which is the console's rule for
 * a closed shape with more than one reader: a second declaration here would be a shape
 * that agrees with the grammar until one of them grows a member, and the compiler
 * reports neither.
 */
export type WorkflowPhaseFocus = NonNullable<
  Extract<AppRoute, { kind: "session" }>["workflowPhase"]
>;

/**
 * Which rail destination is current, or `undefined` where the route lights none.
 *
 * The map is NOT one-to-one, and `workspace` is the arm that makes it so: a
 * session is reached FROM the sessions destination, so a window sitting in a
 * workspace is still under that destination and the rail highlights it there.
 * Answering with a destination of its own would name an icon the rail does not
 * render, and the current-destination highlight would simply go out.
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
 *
 * One accessor rather than a narrowing at each call site, on {@link routeSessionId}'s
 * reason: `selection` is on the type of one settings arm and off the type of the other,
 * so every reader would otherwise write the two-step narrowing for itself — and the
 * first one to write `route.page === undefined ? undefined : route.selection` slightly
 * differently is a page opened for a provider it was not opened for.
 */
export function settingsSelection(route: AppRoute): string | undefined {
  return route.kind === "settings" && route.page !== undefined ? route.selection : undefined;
}

/**
 * The settings address for one page, scoped to a selection where the caller has one.
 *
 * The producer's half of the pair above, and the one place the omit-versus-set-to-
 * `undefined` distinction the parse arm depends on is decided. A caller that built the
 * object itself would have to know that rule to round-trip, and a caller with no
 * selection would have to remember not to write the key at all.
 */
export function settingsRoute(page: string, selection: string | undefined): AppRoute {
  return selection === undefined
    ? { kind: "settings", page }
    : { kind: "settings", page, selection };
}

/**
 * The session a route is scoped to, or `undefined` where it names none.
 *
 * One accessor rather than a presence test at each call site. `sessionId` is on the
 * type of some arms and off the type of others; without this, every reader narrows
 * for itself, and the two that already did — the frame store's active session and
 * a mount's subject — had written two different walks over one union.
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

/**
 * The phase a route is focused on, or `undefined` where it names none.
 *
 * PUBLISHED, WHERE THE COMPARISON BELOW USED TO BE THE ONLY READER. The address
 * `#/session/<sid>/workflow/<rid>/phase/<pid>` parsed into a route nothing outside this
 * family consumed, so following the link changed the hash and the route identity and
 * left the window on an unfocused workspace — the phase was addressable and still
 * unreachable. The surface that mounts it asks this question, and asking it through one
 * accessor is what keeps the arm's optionality answered in one place rather than at
 * each consumer.
 *
 * TOTAL OVER THE UNION, like {@link routeSessionId} beside it: every other arm answers
 * `undefined` rather than being narrowed away at the call site, because a caller
 * holding an `AppRoute` is exactly the caller that does not yet know which arm it is.
 */
export function routeWorkflowPhase(route: AppRoute): WorkflowPhaseFocus | undefined {
  return route.kind === "session" ? route.workflowPhase : undefined;
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
 * The workspace arm's focus, compared field by field.
 *
 * Both-absent is EQUAL and one-absent is not, which is the whole content of the
 * comparison: a bare workspace address and one focused on a phase of it are two
 * different places, and treating them as one would make navigating from a run row to
 * its phase cost no transition and render nothing new.
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
