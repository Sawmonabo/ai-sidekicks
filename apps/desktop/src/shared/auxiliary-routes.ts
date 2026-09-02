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
 * What an auxiliary window is opened on: the route, plus the pane context the
 * route is scoped to.
 *
 * A three-arm union rather than one bag with two optional members, so
 * "an agent id with no session to read it in" is UNREPRESENTABLE rather than
 * merely refused at runtime — which is also what makes
 * `parseAuxiliaryFragment` an exact inverse of `formatAuxiliaryFragment` over
 * the whole type instead of over a subset of it.
 */
export type AuxiliaryRouteTarget =
  | { readonly route: AuxiliaryRouteName }
  | { readonly route: AuxiliaryRouteName; readonly sessionId: string }
  | { readonly route: AuxiliaryRouteName; readonly sessionId: string; readonly agentId: string };

/** The fragment prefix every auxiliary route lives under. */
const AUXILIARY_FRAGMENT_PREFIX = "#/window/";

/**
 * Renders `target` as the hash fragment an auxiliary window loads.
 *
 * Every segment is `encodeURIComponent`-encoded. The consumer decodes each
 * segment, so without this the halves are asymmetric and only upstream id
 * validation keeps a `/` or a `#` in a context value from silently re-shaping
 * the route — a producer/consumer pair that agrees by luck rather than by
 * construction. The route name needs no encoding by inspection of the closed
 * set, and is encoded anyway so the rule is "every segment", with no exception
 * for a reader to have to verify.
 */
export function formatAuxiliaryFragment(target: AuxiliaryRouteTarget): string {
  const segments: string[] = [target.route];
  if ("sessionId" in target) {
    segments.push(target.sessionId);
    if ("agentId" in target) {
      segments.push(target.agentId);
    }
  }
  return AUXILIARY_FRAGMENT_PREFIX + segments.map(encodeURIComponent).join("/");
}

/**
 * The exact inverse of {@link formatAuxiliaryFragment}, or `null` when
 * `fragment` is not an auxiliary route at all.
 *
 * Refuses rather than guesses: an unknown route name, a wrong segment count, an
 * empty segment, or a malformed percent-escape all answer `null`, so a caller
 * cannot receive a half-parsed target. Written in this module beside its
 * producer because two sides of one grammar in two files drift, and the drift is
 * invisible — the gate goes green while `parseAuxiliaryFragment` answers
 * "not found" for a route `createAuxiliaryWindow` just opened.
 */
export function parseAuxiliaryFragment(fragment: string): AuxiliaryRouteTarget | null {
  if (!fragment.startsWith(AUXILIARY_FRAGMENT_PREFIX)) {
    return null;
  }

  const rawSegments = fragment.slice(AUXILIARY_FRAGMENT_PREFIX.length).split("/");
  if (rawSegments.length < 1 || rawSegments.length > 3) {
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

  const [route, sessionId, agentId] = segments;
  if (!isAuxiliaryRouteName(route)) {
    return null;
  }
  if (sessionId === undefined) {
    return { route };
  }
  if (agentId === undefined) {
    return { route, sessionId };
  }
  return { route, sessionId, agentId };
}
