// The console's routes, as data.
//
// Hash routing, not history routing, and for a concrete reason: the renderer is
// served from a custom `sidekicks-renderer://` scheme through a bundle handler that
// resolves exactly one document (`Plan-023` Phase 1B, `src/main/protocol.ts`). A
// history-API route would ask that handler for a path that is not a file; a hash
// route asks for the same document every time and carries its state after the `#`.
// The auxiliary-window factory already relies on this — `createAuxiliaryWindow`
// loads `…/index.html#/window/<route>`.
//
// Two families of route:
//
//   • **Main-window routes**, one per icon-rail destination plus the session
//     workspace.
//   • **Auxiliary-window routes**, `#/window/<route>[/<sessionId>[/<agentId>]]`.
//     These are the routes a detached pane opens into, and they are the reason the
//     grammar has optional trailing segments at all.
//
// An auxiliary route arriving BARE — no session id — is not an error. A person can
// open the timeline window from the Window menu before choosing anything, and
// `Spec-023 §Console Design (Meridian)` §The surface set gives that case a context
// picker rather than an empty window. A route arriving MALFORMED (an unknown route
// name, too many segments, an empty segment) is different: it resolves to the
// not-found route, which says what it could not open rather than rendering blank.

/**
 * Destinations on the icon rail, in rail order. Closed; the rail renders exactly
 * these.
 *
 * A tuple rather than a bare union because "exactly these" is a claim about a set,
 * and a set nothing can walk at runtime cannot be held to it: the rail's own entry
 * table is an array, so a destination added to the union alone would typecheck and
 * render nowhere.
 */
export const RAIL_DESTINATIONS = ["sessions", "workspace", "settings"] as const;

/** One icon-rail destination, derived from the tuple above. */
export type RailDestination = (typeof RAIL_DESTINATIONS)[number];

/**
 * Auxiliary-window routes.
 *
 * One declaration, with the union derived from it. A hand-repeated array beside a
 * hand-written union is two closed sets that agree until the day someone widens
 * one, and nothing in the compiler notices.
 */
export const AUXILIARY_ROUTE_NAMES = ["timeline", "agent-console"] as const;

export type AuxiliaryRouteName = (typeof AUXILIARY_ROUTE_NAMES)[number];

/** Where the console currently is. A closed union — every arm renders something. */
export type ConsoleRoute =
  | { readonly kind: "sessions" }
  | { readonly kind: "workspace"; readonly sessionId: string }
  | { readonly kind: "settings"; readonly page: string | undefined }
  | {
      readonly kind: "auxiliary";
      readonly route: AuxiliaryRouteName;
      readonly sessionId: string | undefined;
      readonly agentId: string | undefined;
    }
  | { readonly kind: "not-found"; readonly attempted: string };

/** The route a window with no hash lands on. */
export const DEFAULT_ROUTE: ConsoleRoute = { kind: "sessions" };

/**
 * Parse a location hash into a route.
 *
 * Total: every input produces a route, because a renderer that throws while
 * deciding what to render has no way to tell anyone why.
 */
export function parseRoute(hash: string): ConsoleRoute {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  const [head, ...rest] = segments;

  if (head === undefined) {
    return DEFAULT_ROUTE;
  }

  if (head === "sessions") {
    return rest.length === 0 ? { kind: "sessions" } : notFound(hash);
  }

  if (head === "session") {
    const sessionId = rest[0];
    if (sessionId === undefined || rest.length > 1) {
      return notFound(hash);
    }
    return { kind: "workspace", sessionId: decodeURIComponent(sessionId) };
  }

  if (head === "settings") {
    if (rest.length > 1) {
      return notFound(hash);
    }
    const page = rest[0];
    return { kind: "settings", page: page === undefined ? undefined : decodeURIComponent(page) };
  }

  if (head === "window") {
    const [routeName, sessionId, agentId, ...extra] = rest;
    if (routeName === undefined || extra.length > 0) {
      return notFound(hash);
    }
    if (!isAuxiliaryRouteName(routeName)) {
      return notFound(hash);
    }
    return {
      kind: "auxiliary",
      route: routeName,
      // A bare auxiliary route is legitimate and gets the context picker; only an
      // unparseable one is not-found.
      sessionId: sessionId === undefined ? undefined : decodeURIComponent(sessionId),
      agentId: agentId === undefined ? undefined : decodeURIComponent(agentId),
    };
  }

  return notFound(hash);
}

/** Render a route back to a hash. Round-trips with `parseRoute`. */
export function formatRoute(route: ConsoleRoute): string {
  switch (route.kind) {
    case "sessions":
      return "#/sessions";
    case "workspace":
      return `#/session/${encodeURIComponent(route.sessionId)}`;
    case "settings":
      return route.page === undefined
        ? "#/settings"
        : `#/settings/${encodeURIComponent(route.page)}`;
    case "auxiliary": {
      const parts = ["#", "window", route.route];
      if (route.sessionId !== undefined) {
        parts.push(encodeURIComponent(route.sessionId));
        if (route.agentId !== undefined) {
          parts.push(encodeURIComponent(route.agentId));
        }
      }
      return parts.join("/");
    }
    case "not-found":
      return route.attempted;
  }
}

/** Which rail destination is current, or `undefined` in an auxiliary window. */
export function railDestinationFor(route: ConsoleRoute): RailDestination | undefined {
  switch (route.kind) {
    case "sessions":
      return "sessions";
    case "workspace":
      return "workspace";
    case "settings":
      return "settings";
    case "auxiliary":
    case "not-found":
      return undefined;
  }
}

/** True when this window is an auxiliary one, which changes what chrome renders. */
export function isAuxiliaryRoute(route: ConsoleRoute): boolean {
  return route.kind === "auxiliary";
}

/**
 * True when an auxiliary route needs the context picker: it named a window but not
 * what to show in it.
 */
export function needsContextPicker(route: ConsoleRoute): boolean {
  return route.kind === "auxiliary" && route.sessionId === undefined;
}

/** Structural route comparison, so an unchanged hash costs no transition. */
export function routesAreEqual(left: ConsoleRoute, right: ConsoleRoute): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "sessions":
      return true;
    case "workspace":
      return right.kind === "workspace" && left.sessionId === right.sessionId;
    case "settings":
      return right.kind === "settings" && left.page === right.page;
    case "auxiliary":
      return (
        right.kind === "auxiliary" &&
        left.route === right.route &&
        left.sessionId === right.sessionId &&
        left.agentId === right.agentId
      );
    case "not-found":
      return right.kind === "not-found" && left.attempted === right.attempted;
  }
}

function isAuxiliaryRouteName(candidate: string): candidate is AuxiliaryRouteName {
  return (AUXILIARY_ROUTE_NAMES as readonly string[]).includes(candidate);
}

function notFound(attempted: string): ConsoleRoute {
  return { kind: "not-found", attempted };
}
