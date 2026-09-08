// Which auxiliary-window routes exist, what they are called, and which of them
// this build offers — Plan-023 Phase 1B (T-023p-1B-2).
//
// SHARED, and the location is the whole point. An auxiliary window is two
// halves in two processes: the main process constructs the window and builds
// the menu entry that opens it, and the renderer bundle carries the route body.
// Written twice, the two halves drift — a label map in the menu against a
// second one in a picker, a closed set declared in each process with a comment
// in one saying it mirrors the other. This module is the single declaration all
// of them derive from, and `src/shared/` exists so the renderer can reach it:
// the renderer is lint-forbidden from importing `src/main/**`, so there is no
// other home.
//
// HOW A ROUTE BECOMES AN ADDRESS IS THE SIBLING'S, `./auxiliary-route-fragment.ts`.
// That module holds the hash grammar — the target shape, the producer, the
// consumer, and the segment table both read — and this one holds the route
// vocabulary those are written over. The cut is along that seam and not at a
// line count: the menu bar and the pane-kind table ask what routes exist and
// encode no address at all, while nothing in the grammar decides which routes a
// build offers.
//
// Implementation status is a BUILD-TIME fact about the renderer bundle, not
// runtime state. A main-process registry that renderer route modules were meant
// to fill has no reachable registrant — a renderer module cannot call into main,
// and no bridge namespace for it exists (Plan-023 Phase 1B defers one) — so it
// is a gate nothing ever opens and every entry behind it stays hidden forever.
// `IMPLEMENTED_AUXILIARY_ROUTES` replaces it: a constant the console's route
// table, the detach handoff, and the window factory all read, grown in the same
// commit as each route body (T-023p-1C-2 `timeline`, T-023p-1C-4
// `agent-console`). `BARE_LAUNCHABLE_AUXILIARY_ROUTES` is the narrower subset
// the menu bar reads, and its own header says why the two are separate claims.
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
 * It was EMPTY at Phase 1B: that phase shipped the main-process half only, and an
 * entry that opened `#/window/timeline` before Phase 1C's route body existed
 * would have opened a hardened window onto a hash route with nothing behind it —
 * a blank frame the user has to close, offered by a menu that claimed it did
 * something. That is the capability-claimed-but-not-implemented shape
 * `Spec-023 §Console Design (Meridian)` §Copy forbids, and the same
 * absent-not-disabled rule that keeps Plan-026's `Session` entries out of the
 * menu until its walkthrough host exists.
 *
 * Each joins it in the same commit as its route body. `timeline` is the console's
 * ledger family claiming the `timeline` surface slot, so `#/window/timeline`
 * resolves to a rendered pane rather than to nothing; `agent-console` is the agents
 * family's console claiming its own, from T-023p-1C-4.
 *
 * Membership here admits a launch that SUPPLIES context — the deck's detach
 * control, and a hand-typed hash route. It does not by itself admit a BARE
 * launch: that is {@link BARE_LAUNCHABLE_AUXILIARY_ROUTES}, a strict subset.
 *
 * An array rather than a `Set` because a `Set`'s iteration order is its
 * insertion order, which would make every consumer's order an accident.
 */
export const IMPLEMENTED_AUXILIARY_ROUTES: readonly AuxiliaryRouteName[] = [
  "timeline",
  "agent-console",
];

/**
 * The subset of the implemented routes whose BARE launch can reach a subject in
 * this build, in presentation order.
 *
 * Implemented and bare-launchable are two different claims, and collapsing them
 * is what put an unusable command on the menu bar. A route is implemented when
 * its renderer body exists — which is what the detach path needs, because a
 * detach SUPPLIES the session id it opens on. A route is bare-launchable only
 * when a window opened with no context at all can still be given one, and that
 * is a claim about the READS available to the auxiliary renderer, not about the
 * route body.
 *
 * EMPTY today, and the reason is a wire and not an omission. An auxiliary
 * renderer starts with no open session stores, so `SessionStoreRegistry` — one
 * of the context picker's two candidate sources — is empty by construction. The
 * other is the node's session directory, which is a `Plan-023 §Console growth
 * slate` row that the live bridge refuses by name (`sessionList`, alongside
 * `sessionRead`): no daemon method for it is registered in
 * `packages/contracts`, so there is nothing for the live port to call. Both
 * candidate sources therefore settle at nothing, and a bare window stops at the
 * picker's honest not-checked absence with no way forward. A menu entry that
 * always ends there is the capability-claimed-but-not-implemented shape
 * `Spec-023 §Console Design (Meridian)` §Copy forbids.
 *
 * A route joins this list in the same commit as the read that makes its bare
 * launch answerable — the directory row landing is what makes `timeline` a
 * member — exactly as a route joins {@link IMPLEMENTED_AUXILIARY_ROUTES} in the
 * same commit as its body.
 *
 * Kept as a SEPARATE array rather than a flag on the implemented list because
 * the two are read by different consumers for different questions: the menu asks
 * "can a bare launch get anywhere", while the detach path and the window factory
 * ask "does this route have a body". Deriving one from the other would make a
 * future route join both by writing it once, which is the coupling that produced
 * this defect.
 */
export const BARE_LAUNCHABLE_AUXILIARY_ROUTES: readonly AuxiliaryRouteName[] = [];

/**
 * Whether `value` names a route in the closed set.
 *
 * Takes `unknown`, deliberately: the compile-time union binds this package's own
 * call sites, and the renderer-initiated detach arrives over IPC, where a type is
 * a claim and not a guarantee.
 */
export function isAuxiliaryRouteName(value: unknown): value is AuxiliaryRouteName {
  return typeof value === "string" && (AUXILIARY_ROUTE_NAMES as readonly string[]).includes(value);
}
