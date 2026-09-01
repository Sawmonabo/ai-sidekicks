// The auxiliary-window route registry — Plan-023 Phase 1B (T-023p-1B-2).
//
// Two things live here, and they live together because the second is a
// statement about the first: the CLOSED auxiliary-route set, and which of those
// routes the renderer has actually implemented.
//
// Why a registry at all. `Spec-023 §Console Design (Meridian)` §The surface set
// names `timeline` and `agent-console` as the two panes that may be moved into
// a window of their own, and Phase 1B ships the main-process half — the locked
// factory, the descriptor, the fragment. The renderer half (the route bodies
// those fragments resolve to) is Phase 1C's T-023p-1C-2 and T-023p-1C-4. In
// between, a menu entry that opened `#/window/timeline` would open a hardened
// window onto a hash route with nothing behind it: a blank frame the user has
// to close, offered by a menu that claimed it did something. That is exactly
// the capability-claimed-but-not-implemented shape `Spec-023 §Console Design
// (Meridian)` §Copy forbids, and the same absent-not-disabled rule that keeps
// Plan-026's `Session` entries out of the menu until its walkthrough host
// exists applies here without amendment.
//
// So the menu is built FROM this registry rather than from the route type: an
// entry appears only for a route someone has registered. Phase 1B registers
// nothing, so Phase 1B ships no auxiliary menu entries. Phase 1C's route
// modules register themselves as they land, and each entry appears with its
// own route rather than the whole submenu appearing at once.
//
// The registry is main-process state and never crosses the preload boundary.
// Registration is a main-process act (the route table is compiled into the
// renderer bundle, and the composition root that mounts it registers here), so
// nothing about it is renderer-supplied input.

/**
 * The auxiliary windows `Spec-023 §Main Process Responsibilities` names — the
 * full-screen timeline and the detached agent console. A CLOSED set: the
 * console's pane-kind set is closed, and only these two panes may be moved into
 * a window of their own (`Spec-023 §Console Design (Meridian)` §The surface set).
 */
export type AuxiliaryWindowRoute = "timeline" | "agent-console";

/**
 * The closed route set in presentation order.
 *
 * A tuple rather than a `Set` because the menu renders these in order and a
 * `Set`'s iteration order is its insertion order, which would silently become
 * the menu's order. Declared once here and consumed both by the window
 * factory's runtime membership test and by the menu builder, so "which routes
 * exist" has exactly one definition.
 */
export const AUXILIARY_WINDOW_ROUTES: readonly AuxiliaryWindowRoute[] = [
  "timeline",
  "agent-console",
];

/**
 * Which auxiliary routes the renderer bundle actually implements.
 *
 * Holds a subset of `AUXILIARY_WINDOW_ROUTES` and notifies listeners when that
 * subset grows. Registration is idempotent and only an actual change notifies,
 * so a module that registers on every hot reload does not rebuild the menu on
 * every reload.
 */
export class AuxiliaryRouteRegistry {
  readonly #registered = new Set<AuxiliaryWindowRoute>();
  readonly #listeners = new Set<() => void>();

  /** Records that `route`'s renderer body exists. Idempotent. */
  public register(route: AuxiliaryWindowRoute): void {
    if (this.#registered.has(route)) {
      return;
    }
    this.#registered.add(route);
    for (const listener of this.#listeners) {
      listener();
    }
  }

  /** Whether `route`'s renderer body exists. */
  public has(route: AuxiliaryWindowRoute): boolean {
    return this.#registered.has(route);
  }

  /**
   * The registered routes in presentation order — never in registration order,
   * so the menu does not reorder itself depending on which route module
   * happened to load first.
   */
  public registered(): readonly AuxiliaryWindowRoute[] {
    return AUXILIARY_WINDOW_ROUTES.filter((route) => this.#registered.has(route));
  }

  /**
   * Subscribes to registrations. Returns the unsubscribe function; the caller
   * owns it, and nothing here holds a timer or a handle that would keep the
   * process alive.
   */
  public onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/**
 * The process-wide registry. One menu bar, one registry.
 *
 * Explicitly annotated because the package compiles with
 * `isolatedDeclarations: true` — an exported value cannot rely on an inferred
 * type.
 */
export const auxiliaryRouteRegistry: AuxiliaryRouteRegistry = new AuxiliaryRouteRegistry();
