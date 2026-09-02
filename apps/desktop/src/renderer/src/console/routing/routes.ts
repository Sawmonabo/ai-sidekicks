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
//     workspace. The workspace is a route and NOT a rail destination: a session is
//     reached from the sessions destination, which is why `railDestinationFor`
//     answers `sessions` for it.
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
//
// THE AUXILIARY GRAMMAR IS NOT DECLARED HERE. `src/shared/auxiliary-routes.ts`
// owns the route names, their labels, and the `#/window/…` producer/consumer pair,
// because the main process PRODUCES those fragments (the Window menu, the
// auxiliary-window factory) and this module CONSUMES them — two halves in two
// processes, which is exactly the pair that drifts when each writes its own. This
// module keeps the console-wide grammar (`#/sessions`, `#/session/<id>`,
// `#/workflows`, `#/settings`) and delegates the one arm it shares with main, so
// the console cannot accept a fragment the menu cannot produce or the reverse.

import {
  formatAuxiliaryFragment,
  parseAuxiliaryFragment,
  type AuxiliaryRouteTarget,
} from "../../../../shared/auxiliary-routes.js";

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

/** Where the console currently is. A closed union — every arm renders something. */
export type ConsoleRoute =
  | { readonly kind: "sessions" }
  | { readonly kind: "workspace"; readonly sessionId: string }
  // Bare, and deliberately so. `Spec-023 §Console Design (Meridian)` §The surface
  // set opens the `workflow-builder` pane from this destination, and a pane
  // carries its own context — a definition id written into the address here would
  // be a second, unowned locator for something the builder has not defined yet.
  | { readonly kind: "workflows" }
  | { readonly kind: "settings"; readonly page: string | undefined }
  // The shared target with a kind tag, INTERSECTED rather than restated. That
  // target is route-discriminated — an agent console carries its agent with its
  // session or not at all, a timeline carries no agent — and writing the arm out
  // here as two independent optionals would reintroduce the half-supplied context
  // the shared grammar exists to make unrepresentable, in the one module that
  // delegates both directions of that grammar precisely so it cannot drift.
  //
  // Distributing over the union gives four auxiliary arms rather than one, so
  // `route.sessionId` reads only where a session is actually carried and the
  // `"agentId" in route` test narrows instead of merely testing for `undefined`.
  | ({ readonly kind: "auxiliary" } & AuxiliaryRouteTarget)
  | { readonly kind: "not-found"; readonly attempted: string };

/** The route a window with no hash lands on. */
export const DEFAULT_ROUTE: ConsoleRoute = { kind: "sessions" };

/**
 * Decode one path segment, or `undefined` when its percent-escapes are malformed.
 *
 * ONE helper rather than a `try` at each decode site. `decodeURIComponent` raises
 * `URIError` on an escape like `%zz`, and {@link parseRoute}'s contract is that
 * every input produces a route — a promise that holds only while EVERY decode in
 * this module answers a malformed escape the same way. A guard pasted per site is
 * how the next arm to grow a segment ships without one. The auxiliary arm reaches
 * the same discipline through the shared grammar, which decodes its own segments
 * and answers `null`, so it needs no third call here.
 *
 * `undefined` rather than a raised refusal, because the caller has an answer for
 * this: a hash anyone can type into the address bar is a probe, not an incident,
 * and the not-found route says what it could not open.
 */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Parse a location hash into a route.
 *
 * Total: every input produces a route, because a renderer that throws while
 * deciding what to render has no way to tell anyone why. Totality is a property
 * of this function and not a hope about its input — the two ways a hash breaks a
 * parser are both closed below. Every percent-escape goes through
 * {@link decodeSegment}, and every empty segment is refused before an arm reads
 * one, so neither a `URIError` nor a silently normalised path leaves here.
 */
export function parseRoute(hash: string): ConsoleRoute {
  const afterHash = hash.startsWith("#") ? hash.slice(1) : hash;
  // The LEADING slash is the one optional separator; every other one is grammar.
  // The filter that used to drop empty segments deleted the evidence the arms
  // below validate on, so `#/session//foo` resolved to session `foo` — a different
  // session than the link names — and `#/window/timeline/` opened a bare timeline.
  const path = afterHash.startsWith("/") ? afterHash.slice(1) : afterHash;

  if (path === "") {
    return DEFAULT_ROUTE;
  }

  const segments = path.split("/");
  const [head, ...rest] = segments;
  // One refusal covering both grammars: the main-window arms below and the
  // auxiliary fragment re-composed for the shared parser read the same segments,
  // so an empty one cannot be malformed for one and invisible to the other.
  // `String.prototype.split` never answers an empty array, so `head` is present —
  // the `undefined` arm is the compiler's obligation, answered the same way.
  if (head === undefined || segments.includes("")) {
    return notFound(hash);
  }

  if (head === "sessions") {
    return rest.length === 0 ? { kind: "sessions" } : notFound(hash);
  }

  if (head === "session") {
    const sessionId = rest[0];
    if (sessionId === undefined || rest.length > 1) {
      return notFound(hash);
    }
    const decoded = decodeSegment(sessionId);
    return decoded === undefined ? notFound(hash) : { kind: "workspace", sessionId: decoded };
  }

  if (head === "workflows") {
    return rest.length === 0 ? { kind: "workflows" } : notFound(hash);
  }

  if (head === "settings") {
    if (rest.length > 1) {
      return notFound(hash);
    }
    const page = rest[0];
    if (page === undefined) {
      return { kind: "settings", page: undefined };
    }
    const decoded = decodeSegment(page);
    return decoded === undefined ? notFound(hash) : { kind: "settings", page: decoded };
  }

  if (head === "window") {
    // Re-composed from the already-split segments rather than passed through as
    // `hash`, so this module keeps its own tolerance for a leading `#` or `#/`
    // while the SEGMENTS are read by the shared grammar: segment-count bounds,
    // the closed route-name check, and the per-segment decode. That decode is the
    // reason to delegate rather than to re-derive — the arm this replaced called
    // `decodeURIComponent` directly, and a malformed escape
    // (`#/window/timeline/%zz`) throws `URIError` out of a function whose own
    // contract is that every input produces a route. The empty-segment refusal is
    // enforced once above for both grammars, and again by the shared parser, which
    // also serves the main process and cannot rely on this caller.
    const target = parseAuxiliaryFragment(`#/window/${rest.join("/")}`);
    if (target === null) {
      return notFound(hash);
    }
    // A bare auxiliary route is legitimate and gets the context picker; only an
    // unparseable one is not-found. The target is spread whole rather than
    // destructured field by field, which is what keeps this arm honest as the
    // shared grammar grows a route: a third route's context keys arrive here with
    // no edit, where a field list would have silently dropped them.
    return { kind: "auxiliary", ...target };
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
    case "workflows":
      return "#/workflows";
    case "settings":
      return route.page === undefined
        ? "#/settings"
        : `#/settings/${encodeURIComponent(route.page)}`;
    case "auxiliary": {
      // Encoded by the shared producer, which keeps this the exact inverse of the
      // parse above — both sides of one grammar, written once. Only the kind tag
      // is dropped; the rest of the route IS the target, so there is no arm-by-arm
      // reconstruction here to disagree with the grammar it is reconstructing.
      const { kind: _consoleRouteKind, ...target } = route;
      return formatAuxiliaryFragment(target);
    }
    case "not-found":
      return route.attempted;
  }
}

/**
 * Which rail destination is current, or `undefined` in an auxiliary window.
 *
 * The map is NOT one-to-one, and `workspace` is the arm that makes it so: a
 * session is reached FROM the sessions destination, so a window sitting in a
 * workspace is still under that destination and the rail highlights it there.
 * Answering with a destination of its own would name an icon the rail does not
 * render, and the current-destination highlight would simply go out.
 */
export function railDestinationFor(route: ConsoleRoute): RailDestination | undefined {
  switch (route.kind) {
    case "sessions":
    case "workspace":
      return "sessions";
    case "workflows":
      return "workflows";
    case "settings":
      return "settings";
    case "auxiliary":
    case "not-found":
      return undefined;
  }
}

/** The auxiliary arm of the route union, named so predicates can narrow to it. */
export type AuxiliaryConsoleRoute = Extract<ConsoleRoute, { kind: "auxiliary" }>;

/**
 * True when this window is an auxiliary one, which changes what chrome renders.
 *
 * A type PREDICATE rather than a `boolean`, because the call sites that would
 * otherwise keep writing `route.kind === "auxiliary"` are not all asking a
 * yes/no question — several go on to read `route.sessionId`, which only the
 * discriminant narrows. Returning `boolean` here is what left four hand-written
 * copies of this comparison in the tree: adopting the helper would have cost
 * those callers their narrowing, so they kept the comparison instead.
 */
export function isAuxiliaryRoute(route: ConsoleRoute): route is AuxiliaryConsoleRoute {
  return route.kind === "auxiliary";
}

/**
 * The session a route is scoped to, or `undefined` where it names none.
 *
 * One accessor rather than a presence test at each call site. The auxiliary arm
 * is route-discriminated, so `sessionId` is on the type of some arms and off the
 * type of others; without this, every reader narrows for itself, and the two that
 * already did — the frame store's active session and the legacy mounts' subject —
 * had written two different walks over one union before the arm was discriminated
 * at all.
 */
export function routeSessionId(route: ConsoleRoute): string | undefined {
  switch (route.kind) {
    case "workspace":
      return route.sessionId;
    case "auxiliary":
      return "sessionId" in route ? route.sessionId : undefined;
    case "sessions":
    case "workflows":
    case "settings":
    case "not-found":
      return undefined;
  }
}

/** The agent a route is scoped to. Module-private: only the comparison below asks. */
function routeAgentId(route: ConsoleRoute): string | undefined {
  return route.kind === "auxiliary" && "agentId" in route ? route.agentId : undefined;
}

/**
 * True when an auxiliary route needs the context picker: it named a window but not
 * what to show in it.
 */
export function needsContextPicker(route: ConsoleRoute): boolean {
  return route.kind === "auxiliary" && routeSessionId(route) === undefined;
}

/** Structural route comparison, so an unchanged hash costs no transition. */
export function routesAreEqual(left: ConsoleRoute, right: ConsoleRoute): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "sessions":
    case "workflows":
      return true;
    case "workspace":
      return right.kind === "workspace" && left.sessionId === right.sessionId;
    case "settings":
      return right.kind === "settings" && left.page === right.page;
    case "auxiliary":
      return (
        right.kind === "auxiliary" &&
        left.route === right.route &&
        routeSessionId(left) === routeSessionId(right) &&
        routeAgentId(left) === routeAgentId(right)
      );
    case "not-found":
      return right.kind === "not-found" && left.attempted === right.attempted;
  }
}

function notFound(attempted: string): ConsoleRoute {
  return { kind: "not-found", attempted };
}
