// The auxiliary-window route grammar — Plan-023 Phase 1B (T-023p-1B-2).
//
// SHARED, and the location is the whole point. An auxiliary window is two
// halves in two processes: the main process constructs the window, builds the
// menu entry that opens it, and PRODUCES the hash fragment; the renderer bundle
// carries the route body and PARSES that fragment back. Written twice, the two
// halves drift — the producer that does not encode against the consumer that
// decodes, a label map in the menu against a second one in a picker, a closed
// set declared in each process with a comment in one saying it mirrors the
// other. This module is the single declaration all of them derive from, and
// `src/shared/` exists so the renderer can reach it: the renderer is
// lint-forbidden from importing `src/main/**`, so there is no other home.
//
// Implementation status is a BUILD-TIME fact about the renderer bundle, not
// runtime state. A main-process registry that renderer route modules were meant
// to fill has no reachable registrant — a renderer module cannot call into main,
// and no bridge namespace for it exists (Plan-023 Phase 1B defers one) — so it
// is a gate nothing ever opens and every entry behind it stays hidden forever.
// `IMPLEMENTED_AUXILIARY_ROUTES` replaces it: a constant both the menu and the
// console's route table read, grown in the same commit as each route body
// (T-023p-1C-2 `timeline`, T-023p-1C-4 `agent-console`).
//
// This module may import nothing but `@ai-sidekicks/contracts` — it is compiled
// into the RENDERER bundle, so `electron`, `node:*`, and the main/preload
// subtrees are all forbidden here, enforced by `apps/desktop/eslint.config.mjs`.
// It holds data and pure functions: no state, no I/O.

/**
 * The auxiliary windows `Spec-023 §Main Process Responsibilities` names — the
 * full-screen timeline and the detached agent console. A CLOSED set: the
 * console's pane-kind set is closed, and only these two panes may be moved into
 * a window of their own (`Spec-023 §Console Design (Meridian)` §The surface set).
 *
 * Declared as the array; the union is DERIVED from it rather than written
 * beside it, so the two cannot disagree.
 */
export const AUXILIARY_ROUTE_NAMES = ["timeline", "agent-console"] as const;

/** One auxiliary route name. Derived from the array above — never restated. */
export type AuxiliaryRouteName = (typeof AUXILIARY_ROUTE_NAMES)[number];

/**
 * The human label for each route, in one place.
 *
 * A total `Record`, so adding a route to the closed set is a compile error here
 * until its label is decided — the label cannot silently default to the id, and
 * no consumer needs a ternary that quietly mis-routes the day a third route
 * lands.
 */
export const AUXILIARY_ROUTE_LABELS: Record<AuxiliaryRouteName, string> = {
  timeline: "Timeline",
  "agent-console": "Agent console",
};

/**
 * The routes this build actually implements, in presentation order.
 *
 * EMPTY at Phase 1B: that phase ships the main-process half only, and an entry
 * that opened `#/window/timeline` before Phase 1C's route body existed would
 * open a hardened window onto a hash route with nothing behind it — a blank
 * frame the user has to close, offered by a menu that claimed it did something.
 * That is the capability-claimed-but-not-implemented shape
 * `Spec-023 §Console Design (Meridian)` §Copy forbids, and the same
 * absent-not-disabled rule that keeps Plan-026's `Session` entries out of the
 * menu until its walkthrough host exists.
 *
 * Order here IS the menu's order. An array rather than a `Set` because a `Set`'s
 * iteration order is its insertion order, which would make the menu's order an
 * accident.
 */
export const IMPLEMENTED_AUXILIARY_ROUTES: readonly AuxiliaryRouteName[] = [];

/**
 * Whether `value` names a route in the closed set.
 *
 * Takes `unknown`, deliberately: the compile-time union binds this package's own
 * call sites, and the renderer-initiated detach on
 * `Plan-023 §Console growth slate` will arrive over IPC, where a type is a claim
 * and not a guarantee.
 */
export function isAuxiliaryRouteName(value: unknown): value is AuxiliaryRouteName {
  return typeof value === "string" && (AUXILIARY_ROUTE_NAMES as readonly string[]).includes(value);
}

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
 * the auxiliary renderer's own context picker chooses (Phase 1C).
 *
 * The type is the first line of defence and deliberately not the only one.
 * TypeScript's excess-property check fires on a fresh object literal, but a
 * value that reaches this module through a variable of a wider type is checked
 * structurally, and structurally `{ route: "timeline", sessionId, agentId }` is
 * assignable to the timeline arm. {@link formatAuxiliaryFragment} therefore
 * re-checks the same grammar at runtime — which is also what makes it safe on
 * the IPC path `Plan-023 §Console growth slate` will bring, where a type is a
 * claim and not a guarantee.
 */
export type AuxiliaryRouteTarget =
  | { readonly route: "timeline" }
  | { readonly route: "timeline"; readonly sessionId: string }
  | { readonly route: "agent-console" }
  | { readonly route: "agent-console"; readonly sessionId: string; readonly agentId: string };

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

/** The fragment prefix every auxiliary route lives under. */
const AUXILIARY_FRAGMENT_PREFIX = "#/window/";

/**
 * Renders `target` as the hash fragment an auxiliary window loads.
 *
 * Throws {@link InvalidAuxiliaryRouteTargetError} on a target that does not
 * match its route's grammar — an unknown route, a partial context, a context
 * key the route does not take, or an empty context value. Refusing rather than
 * dropping the offending member is what keeps this an exact inverse of
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

  const segments: string[] = [target.route, ...supplied];
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
  if (rawSegments.length > 1 + AUXILIARY_CONTEXT_KEYS.length) {
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

  const [route, ...context] = segments;
  if (!isAuxiliaryRouteName(route)) {
    return null;
  }
  if (context.length !== 0 && context.length !== AUXILIARY_ROUTE_CONTEXT_KEYS[route].length) {
    return null;
  }

  // Per-arm construction, and deliberately a switch rather than a spread over
  // the key table: building a member of a discriminated union is the one step
  // that genuinely needs per-route code, and the `never` fallthrough makes a
  // third route a compile error here too rather than a silently unhandled arm.
  switch (route) {
    case "timeline": {
      const [sessionId] = context;
      return sessionId === undefined ? { route } : { route, sessionId };
    }
    case "agent-console": {
      const [sessionId, agentId] = context;
      return sessionId === undefined || agentId === undefined
        ? { route }
        : { route, sessionId, agentId };
    }
    default: {
      const unhandled: never = route;
      return unhandled;
    }
  }
}
