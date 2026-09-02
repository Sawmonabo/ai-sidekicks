// One owner per event kind: the door a family projects its own events through.
//
// WHY THIS EXISTS. `SessionStoreRegistry` takes an `EntityProjectorRegistry` at
// construction and the composition root supplied a CONSTANT — the frame's own
// run-lifecycle table. Every other partition `entities.ts` declares (`approval`,
// `workflow-run`, `browser-page`, `artifact`, and the rest) was therefore
// unpopulatable by anyone: the family that owns a surface could not fold the events
// its surface renders, because the only projector table was decided one family below
// it and closed at build time.
//
// What a family does when it cannot project its own category is read the wire TWICE
// — once through the read its surface already performs, and again through a
// subscription it should not need — and then hold the result beside the store rather
// than in it. That is the client-side aggregation the store exists to prevent, and it
// arrives as a second source of truth for state the log already orders.
//
// SO THE TABLE BECOMES A REGISTRY, on the same construction pattern as the deck's
// pane board (`workspace/seats/pane-registry.ts`) and the frame's surface board: a
// `KeyedRegistry` with `duplicatePolicy: "owner-scoped"`, so a family re-registering
// its own claim replaces (a hot reload re-runs its module) and a DIFFERENT family
// claiming a taken event kind is refused by an error naming both owners. Never
// last-writer-wins: two projectors for one kind is a defect, and keeping the last
// would make which fold runs depend on module import order.
//
// WHY IT LIVES IN `store/` AND THE SEED DOES NOT. The registry is a store concern —
// it holds what a store is opened with — and `store/` sits below `frame/` in the
// family DAG, so this module cannot import the frame's run projectors and does not
// try. The process-wide instance is minted here EMPTY and seeded by the composition,
// where `frame/run-lifecycle-projector.ts` claims the run-lifecycle kinds under its
// own name. That ordering is the point: families register, and only then does a
// window open a session store.

import { KeyedRegistry } from "../core/index.js";
import type { EntityProjector, EntityProjectorRegistry } from "./entities.js";

/** One family's claim on one event kind. */
interface EntityProjectorClaim {
  readonly project: EntityProjector;
  /** The family that owns it, so a conflict and an unprojected kind both name someone. */
  readonly owner: string;
}

export class ConsoleEntityProjectorRegistry {
  readonly #claimsByEventKind = new KeyedRegistry<string, EntityProjectorClaim>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "event kind",
    ownerOf: (claim) => claim.owner,
    duplicateHint:
      "one fold per event kind — a second projector would make which one runs depend on module import order",
  });

  /** Claim one event kind. A second claim by a different owner is an error, not a swap. */
  public register(eventKind: string, project: EntityProjector, owner: string): void {
    this.#claimsByEventKind.register(eventKind, { project, owner });
  }

  /**
   * Claim every kind in one table, atomically.
   *
   * Atomic because `KeyedRegistry.registerAll` checks the whole batch before storing
   * any of it: a family whose table collides half way through leaves the registry as
   * it was, rather than half-claimed in a state no caller unwinds.
   */
  public registerAll(projectors: EntityProjectorRegistry, owner: string): void {
    this.#claimsByEventKind.registerAll(
      Object.entries(projectors).map((entry) => [entry[0], { project: entry[1], owner }] as const),
    );
  }

  /**
   * The table a store is opened with, frozen.
   *
   * A snapshot rather than a live view, and frozen rather than merely typed
   * `Readonly`: a store folds events for as long as its session is open, and a table
   * that changed underneath it would mean two events of one kind folding two ways
   * inside one session. Freezing says so at runtime, where a `Readonly` type says
   * nothing at all.
   */
  public snapshot(): EntityProjectorRegistry {
    const projectors: Record<string, EntityProjector> = {};
    for (const eventKind of this.#claimsByEventKind.keys()) {
      const claim = this.#claimsByEventKind.get(eventKind);
      if (claim !== undefined) {
        projectors[eventKind] = claim.project;
      }
    }
    return Object.freeze(projectors);
  }

  /** Who claims one event kind, or `undefined` when nobody does. */
  public ownerOf(eventKind: string): string | undefined {
    return this.#claimsByEventKind.get(eventKind)?.owner;
  }
}

/**
 * The process-wide registry the composition seeds and every window's stores read.
 *
 * Minted EMPTY. The frame's run-lifecycle projectors reach it through
 * `registerConsoleFamilies`, which is handed this instance by `frame/ConsoleRoot.tsx`
 * — the same way the surface board and the pane board are named at that one site
 * rather than reached for inside the composition.
 */
export const consoleEntityProjectorRegistry: ConsoleEntityProjectorRegistry =
  new ConsoleEntityProjectorRegistry();
