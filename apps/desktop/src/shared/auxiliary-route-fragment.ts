// The auxiliary-window fragment grammar: how a route target is written into a
// hash and read back out of one.
//
// BOTH HALVES IN ONE MODULE, and that is the whole reason this file exists.
// An auxiliary window is two halves in two processes: the main process
// PRODUCES the hash fragment a window is opened on, and the renderer bundle
// PARSES it back. Written in two files the two drift, and the drift is
// invisible — the gate goes green while `parseAuxiliaryFragment` answers "not
// found" for a route `createAuxiliaryWindow` just opened. So the producer, the
// consumer, the segment table they both read, and the refusals they both raise
// are here together, and `src/shared/` is what lets the renderer reach them:
// the renderer is lint-forbidden from importing `src/main/**`, so there is no
// other home.
//
// SPLIT FROM `./auxiliary-routes.ts`, WHICH OWNS WHICH ROUTES EXIST. That
// module answers what the closed set is, what each route is called, and which
// of them this build offers — questions with no fragment in them, asked by the
// menu bar and the pane-kind table, which never encode an address at all. This
// module answers how one route becomes an address and back. The cut is along
// that seam and not at a line count: the two halves of the GRAMMAR stay
// together, which is the rule this file is written to keep.
//
// This module may import nothing but `@ai-sidekicks/contracts` and its sibling
// leaf — it is compiled into the RENDERER bundle, so `electron`, `node:*`, and
// the main/preload subtrees are all forbidden here, enforced by
// `apps/desktop/eslint.config.mjs`. It holds data and pure functions: no state,
// no I/O.

import { isAuxiliaryRouteName, type AuxiliaryRouteName } from "./auxiliary-routes.js";

/**
 * What an auxiliary window is opened on: the route, plus the pane context that
 * route is scoped to.
 *
 * ROUTE-DISCRIMINATED, so the impossible combinations are unrepresentable
 * rather than merely refused: a detached agent console is meaningless without
 * the agent it is a console FOR, so on that route the agent id arrives WITH its
 * session or not at all; and a timeline has no agent to scope to, so an agent id
 * on that route is not a partial descriptor, it is an incoherent one.
 *
 * The bare-route arm is the menu-bar shape — no pane to read context from, so
 * the auxiliary renderer's own context picker chooses.
 *
 * `windowId` IS THE SHELL'S HANDLE FOR THIS WINDOW, AND A DIFFERENT AXIS FROM
 * THE CONTEXT. The context says what the window is a view OF; the handle says
 * which window the shell opened, and it is present exactly when a deck asked
 * for the window and is keeping a slot for the pane it took. A window opened
 * from the menu bar has no deck slot behind it, so it carries none — which is
 * why the member is optional rather than a fifth required segment, and why a
 * window that carries one can offer to put its pane back while a bare one
 * cannot. Without it a detached window knows every fact about itself except
 * which window it is, so it can address none of the shell's window operations
 * and its only way out is to close itself, leaving the deck holding a
 * placeholder for a window that no longer exists.
 *
 * It rides the CONTEXT-BEARING arms only, and the segment grammar is what
 * forces that: the handle is the last segment, so a bare route carrying one
 * would be one segment long and indistinguishable from a route carrying a
 * session. That is a real constraint rather than an encoding artefact — a
 * window a deck asked for is a window opened on one of that deck's panes, and a
 * pane belongs to a session — so a handle with no context is refused by both
 * halves rather than silently dropped by one.
 *
 * The type is the first line of defence and deliberately not the only one.
 * TypeScript's excess-property check fires on a fresh object literal, but a
 * value that reaches this module through a variable of a wider type is checked
 * structurally, and structurally `{ route: "timeline", sessionId, agentId }` is
 * assignable to the timeline arm. {@link formatAuxiliaryFragment} therefore
 * re-checks the same grammar at runtime — which is also what makes it safe on
 * the IPC path the renderer-initiated detach takes, where a type is a claim and
 * not a guarantee.
 */
export type AuxiliaryRouteTarget =
  | { readonly route: "timeline" }
  | { readonly route: "timeline"; readonly sessionId: string; readonly windowId?: string }
  | { readonly route: "agent-console" }
  | {
      readonly route: "agent-console";
      readonly sessionId: string;
      readonly agentId: string;
      readonly windowId?: string;
    };

/**
 * Refusal raised when a target does not match its route's context grammar.
 *
 * A named class rather than a bare `Error` so a caller can tell a malformed
 * target from a genuine encoding failure, and so the renderer half can catch it
 * without string-matching a message. It carries the route and the rule it
 * broke, never the offending VALUE — an id that failed a shape check is
 * untrusted input, and echoing it into a log is how untrusted input reaches a
 * log reader.
 */
export class InvalidAuxiliaryRouteTargetError extends Error {
  public constructor(reason: string) {
    super(`invalid auxiliary route target: ${reason}`);
    this.name = "InvalidAuxiliaryRouteTargetError";
  }
}

/** Every context key any route may carry, in the order it is encoded. */
const AUXILIARY_CONTEXT_KEYS = ["sessionId", "agentId"] as const;

/** One context key. Derived from the array above — never restated. */
type AuxiliaryContextKey = (typeof AUXILIARY_CONTEXT_KEYS)[number];

/**
 * The context each route carries, in segment order after the route name.
 *
 * A TOTAL `Record`, so a third route is a compile error here until its context
 * shape is decided — the same totality the label map, the main-process geometry
 * record, and the menu's accelerator record already impose, at the fourth site
 * a route needs a decision.
 *
 * Read as ALL-OR-NOTHING: a route carries either no context at all or every key
 * listed for it. There is deliberately no partial-prefix arm — a half-supplied
 * context is the shape that lets a producer and a consumer agree by luck.
 */
const AUXILIARY_ROUTE_CONTEXT_KEYS: Record<AuxiliaryRouteName, readonly AuxiliaryContextKey[]> = {
  timeline: ["sessionId"],
  "agent-console": ["sessionId", "agentId"],
};

/**
 * Reads one context key off a target without narrowing it first.
 *
 * The cast is the point: this function exists to inspect keys the STATIC type
 * says are absent, because the runtime check above it is what catches the
 * structurally-assignable value the static type cannot. A non-string is read as
 * absent rather than coerced.
 */
function readContextValue(
  target: AuxiliaryRouteTarget,
  key: AuxiliaryContextKey,
): string | undefined {
  const candidate = (target as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * The member the shell's window handle travels on, spelled once.
 *
 * A constant rather than a literal at each of the three sites that read it —
 * the producer's runtime check, the reader below, and the consumer's arm
 * construction — because the member name is the seam between two processes and
 * a second spelling of it is the drift this module exists to prevent.
 */
const AUXILIARY_WINDOW_HANDLE_KEY = "windowId";

/**
 * Reads the shell's window handle off a target, on {@link readContextValue}'s
 * own terms.
 *
 * Separate from that reader rather than a third context key, because the handle
 * is not context: it is not per-route, no route "takes" it or does not, and it
 * is never part of the all-or-nothing rule the context keys obey. A non-string
 * is read as absent rather than coerced.
 */
function readWindowHandle(target: AuxiliaryRouteTarget): string | undefined {
  const candidate = (target as Record<string, unknown>)[AUXILIARY_WINDOW_HANDLE_KEY];
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * The shell handle a target carries, or `undefined` where it carries none.
 *
 * PUBLISHED RATHER THAN LEFT TO EACH READER, because the member is optional on
 * two of four arms and absent from the other two, so every consumer that wanted
 * it would write its own `"windowId" in target` walk — and a walk written four
 * times is four places to be wrong about which arms can carry one. It answers
 * `undefined` for a bare route rather than narrowing, which is what a caller
 * asking "may this window offer to put its pane back" actually needs.
 */
export function auxiliaryWindowIdOf(target: AuxiliaryRouteTarget): string | undefined {
  return readWindowHandle(target);
}

/** The fragment prefix every auxiliary route lives under. */
const AUXILIARY_FRAGMENT_PREFIX = "#/window/";

/**
 * Renders `target` as the hash fragment an auxiliary window loads.
 *
 * Throws {@link InvalidAuxiliaryRouteTargetError} on a target that does not
 * match its route's grammar — an unknown route, a partial context, a context
 * key the route does not take, an empty context value, or a window handle on a
 * route carrying no context at all. Refusing rather than dropping the offending
 * member is what keeps this an exact inverse of
 * {@link parseAuxiliaryFragment}: silently encoding a timeline target's stray
 * `agentId` as nothing would make a round trip lossy in the one direction a
 * caller cannot see.
 *
 * Every segment is `encodeURIComponent`-encoded. The consumer decodes each
 * segment, so without this the halves are asymmetric and only upstream id
 * validation keeps a `/` or a `#` in a context value from silently re-shaping
 * the route. The route name needs no encoding by inspection of the closed set,
 * and is encoded anyway so the rule is "every segment", with no exception for a
 * reader to have to verify.
 */
export function formatAuxiliaryFragment(target: AuxiliaryRouteTarget): string {
  if (!isAuxiliaryRouteName(target.route)) {
    throw new InvalidAuxiliaryRouteTargetError("unknown route");
  }

  const contextKeys = AUXILIARY_ROUTE_CONTEXT_KEYS[target.route];

  for (const key of AUXILIARY_CONTEXT_KEYS) {
    if (!contextKeys.includes(key) && readContextValue(target, key) !== undefined) {
      throw new InvalidAuxiliaryRouteTargetError(`route "${target.route}" takes no ${key}`);
    }
  }

  const values = contextKeys.map((key) => readContextValue(target, key));
  const supplied = values.filter((value) => value !== undefined);
  if (supplied.length !== 0 && supplied.length !== contextKeys.length) {
    throw new InvalidAuxiliaryRouteTargetError(
      `route "${target.route}" takes either no context or all of ${contextKeys.join(", ")}`,
    );
  }
  if (supplied.some((value) => value === "")) {
    throw new InvalidAuxiliaryRouteTargetError(
      `route "${target.route}" takes no empty context value`,
    );
  }

  const windowHandle = readWindowHandle(target);
  if (windowHandle === "") {
    throw new InvalidAuxiliaryRouteTargetError(
      `route "${target.route}" takes no empty window handle`,
    );
  }
  if (windowHandle !== undefined && supplied.length === 0) {
    // The rule the type states and the segment grammar enforces: a handle rides
    // a route that names its full context, because a window the shell opened
    // for a deck is a window opened on one of that deck's panes.
    throw new InvalidAuxiliaryRouteTargetError(
      `route "${target.route}" carries a window handle only with its full context`,
    );
  }

  const segments: string[] = [target.route, ...supplied];
  if (windowHandle !== undefined) {
    segments.push(windowHandle);
  }
  return AUXILIARY_FRAGMENT_PREFIX + segments.map(encodeURIComponent).join("/");
}

/**
 * The exact inverse of {@link formatAuxiliaryFragment}, or `null` when
 * `fragment` is not an auxiliary route at all.
 *
 * Refuses rather than guesses: an unknown route name, a segment count the
 * route's grammar does not admit, an empty segment, or a malformed
 * percent-escape all answer `null`, so a caller cannot receive a half-parsed
 * target. The count check reads the same all-or-nothing table the producer
 * does, so `#/window/agent-console/<session>` — a session with no agent — is
 * refused here exactly as it is unrepresentable there.
 *
 * Three counts per route rather than two, and they stay unambiguous BY ROUTE
 * rather than by luck: the window handle is the last segment, so a route admits
 * no context, its full context, or its full context plus the handle. On
 * `timeline` that is 0, 1 and 2 segments and on `agent-console` 0, 2 and 3, and
 * within one route no count means two things — which is the whole reason the
 * producer refuses a handle with no context rather than encoding one.
 *
 * Written in this module beside its producer because two sides of one grammar
 * in two files drift, and the drift is invisible: the gate goes green while
 * `parseAuxiliaryFragment` answers "not found" for a route
 * `createAuxiliaryWindow` just opened.
 */
export function parseAuxiliaryFragment(fragment: string): AuxiliaryRouteTarget | null {
  if (!fragment.startsWith(AUXILIARY_FRAGMENT_PREFIX)) {
    return null;
  }

  const rawSegments = fragment.slice(AUXILIARY_FRAGMENT_PREFIX.length).split("/");
  // The route name, every context key the widest route takes, and the handle.
  if (rawSegments.length > 2 + AUXILIARY_CONTEXT_KEYS.length) {
    return null;
  }

  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    if (rawSegment === "") {
      return null;
    }
    try {
      segments.push(decodeURIComponent(rawSegment));
    } catch {
      // A malformed escape (`%zz`) is not a route; it is a probe.
      return null;
    }
  }

  const [route, ...trailing] = segments;
  if (!isAuxiliaryRouteName(route)) {
    return null;
  }
  const contextLength = AUXILIARY_ROUTE_CONTEXT_KEYS[route].length;
  const admittedLengths = [0, contextLength, contextLength + 1];
  if (!admittedLengths.includes(trailing.length)) {
    return null;
  }
  // Split before the arms rather than inside each one, so the two per-route
  // constructions below stay about the union they build and the segment
  // arithmetic is done once.
  const windowId = trailing.length === contextLength + 1 ? trailing[contextLength] : undefined;
  const context = windowId === undefined ? trailing : trailing.slice(0, contextLength);

  // Per-arm construction, and deliberately a switch rather than a spread over
  // the key table: building a member of a discriminated union is the one step
  // that genuinely needs per-route code, and the `never` fallthrough makes a
  // third route a compile error here too rather than a silently unhandled arm.
  switch (route) {
    case "timeline": {
      const [sessionId] = context;
      if (sessionId === undefined) {
        return { route };
      }
      return windowId === undefined ? { route, sessionId } : { route, sessionId, windowId };
    }
    case "agent-console": {
      const [sessionId, agentId] = context;
      if (sessionId === undefined || agentId === undefined) {
        return { route };
      }
      return windowId === undefined
        ? { route, sessionId, agentId }
        : { route, sessionId, agentId, windowId };
    }
    default: {
      const unhandled: never = route;
      return unhandled;
    }
  }
}

/**
 * The context a surface has collected so far, on its way to a target.
 *
 * Every key optional and none of them meaning "this route does not take one":
 * a caller collects what it can and asks {@link auxiliaryRouteTargetFor} whether
 * that is yet enough, rather than deciding for itself which route wants what.
 */
export interface PartialAuxiliaryContext {
  readonly sessionId?: string;
  readonly agentId?: string;
}

/**
 * The target for `route` given the context collected so far, or `null` when that
 * route's grammar still wants a key the caller has not supplied.
 *
 * The PRODUCER counterpart of {@link parseAuxiliaryFragment}, beside it for the
 * reason that function gives: two sides of one grammar in two files drift, and
 * the drift is invisible. Same per-arm construction and the same `never`
 * fallthrough, because building a member of a discriminated union is the one step
 * that genuinely needs per-route code — and because `null` for "not yet complete"
 * is what lets a surface that collects context in steps stay on itself instead of
 * navigating to something {@link formatAuxiliaryFragment} will refuse by throwing.
 *
 * `null` is not a refusal. A target that is complete but malformed — an empty id,
 * a key the route does not take — is still the producer's business, and it is
 * still refused there, loudly.
 */
export function auxiliaryRouteTargetFor(
  route: AuxiliaryRouteName,
  context: PartialAuxiliaryContext,
): AuxiliaryRouteTarget | null {
  switch (route) {
    case "timeline": {
      const { sessionId } = context;
      return sessionId === undefined ? null : { route, sessionId };
    }
    case "agent-console": {
      const { sessionId, agentId } = context;
      return sessionId === undefined || agentId === undefined
        ? null
        : { route, sessionId, agentId };
    }
    default: {
      const unhandled: never = route;
      return unhandled;
    }
  }
}
