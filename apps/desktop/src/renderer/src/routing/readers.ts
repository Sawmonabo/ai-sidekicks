// What a caller asks of a route once it has one. `routes.ts` owns the grammar; this module owns
// the questions, so a caller never narrows the union's arms by hand and two callers cannot
// disagree about the same route.

import type { AppRoute } from "./routes.js";

/**
 * Destinations on the icon rail, in rail order. Closed; the rail renders exactly these.
 * A tuple rather than a union so the rail's entry table can be checked against it at runtime.
 */
export const RAIL_DESTINATIONS = [
  "sessions",
  "sidekicks",
  "skills",
  "workflows",
  "settings",
] as const;

/** One icon-rail destination, derived from the tuple above. */
export type RailDestination = (typeof RAIL_DESTINATIONS)[number];

/**
 * Which rail destination is current, or `undefined` where the route lights none.
 *
 * Not one-to-one: a session is reached from the sessions destination, so the session screen
 * lights `sessions`, and `Browse plugins` lights `sidekicks`. The rail has no icon for either.
 */
export function railDestinationFor(route: AppRoute): RailDestination | undefined {
  switch (route.kind) {
    case "sessions":
    case "session":
      return "sessions";
    case "sidekicks":
    case "sidekicks-plugins":
      return "sidekicks";
    case "skills":
      return "skills";
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
 * The run a workflows address opens, or `undefined` where it names none. `runId` exists on only
 * the Runs tab's arm, so callers read it here instead of narrowing.
 */
export function workflowsRunId(route: AppRoute): string | undefined {
  return route.kind === "workflows" && route.tab === "runs" ? route.runId : undefined;
}

/**
 * The Runs tab's address, on one run's page where the caller names one. Omits the `runId` key
 * when there is none, which the parse round trip depends on.
 */
export function workflowRunsRoute(runId: string | undefined): AppRoute {
  return runId === undefined
    ? { kind: "workflows", tab: "runs" }
    : { kind: "workflows", tab: "runs", runId };
}

/**
 * The saved agent definition a sidekicks address opens, or `undefined` where it names none.
 * `definitionId` exists on only one sidekicks arm, so callers read it here instead of narrowing.
 */
export function routeAgentDefinitionId(route: AppRoute): string | undefined {
  return route.kind === "sidekicks" && route.definition === "saved"
    ? route.definitionId
    : undefined;
}

/**
 * The skill folder a skills address opens, or `undefined` where it names none. `skillId` exists
 * on only one skills arm, so callers read it here instead of narrowing.
 */
export function routeSkillId(route: AppRoute): string | undefined {
  return route.kind === "skills" && route.folder === "existing" ? route.skillId : undefined;
}

/**
 * The address of one skill folder, opened at the file the caller names, relative to the folder,
 * or at its entry file without one. Omits the `filePath` key when there is none, which the parse
 * round trip depends on.
 */
export function skillRoute(skillId: string, filePath: string | undefined): AppRoute {
  return filePath === undefined
    ? { kind: "skills", folder: "existing", skillId }
    : { kind: "skills", folder: "existing", skillId, filePath };
}

/**
 * The message a session address opens at, as its event cursor, or `undefined` where it names
 * none. `messageAnchorCursor` exists on only the session arm, so callers read it here.
 */
export function sessionMessageAnchorCursor(route: AppRoute): string | undefined {
  return route.kind === "session" ? route.messageAnchorCursor : undefined;
}

/**
 * The address of one session, opened at the message whose event cursor the caller names, such
 * as the one a workflow run's `startedBy` carries. Without a cursor it opens the session as
 * usual; a cursor the session's log does not hold opens it the same way. Omits the
 * `messageAnchorCursor` key when there is none, which the parse round trip depends on.
 */
export function sessionRoute(sessionId: string, messageAnchorCursor: string | undefined): AppRoute {
  return messageAnchorCursor === undefined
    ? { kind: "session", sessionId }
    : { kind: "session", sessionId, messageAnchorCursor };
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
    case "sidekicks":
    case "sidekicks-plugins":
    case "skills":
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
    case "sidekicks-plugins":
      return true;
    case "sidekicks":
      return (
        right.kind === "sidekicks" &&
        left.definition === right.definition &&
        routeAgentDefinitionId(left) === routeAgentDefinitionId(right)
      );
    case "skills":
      return (
        right.kind === "skills" &&
        left.folder === right.folder &&
        routeSkillId(left) === routeSkillId(right) &&
        routeSkillFilePath(left) === routeSkillFilePath(right)
      );
    case "workflows":
      return (
        right.kind === "workflows" &&
        left.tab === right.tab &&
        workflowsRunId(left) === workflowsRunId(right)
      );
    case "session":
      return (
        right.kind === "session" &&
        left.sessionId === right.sessionId &&
        left.messageAnchorCursor === right.messageAnchorCursor
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

// The file a skill folder's address opens, relative to the folder, or `undefined` where the
// folder opens at its entry file or the address names no folder.
function routeSkillFilePath(route: AppRoute): string | undefined {
  return route.kind === "skills" && route.folder === "existing" ? route.filePath : undefined;
}
