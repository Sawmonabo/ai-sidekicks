// One owner per event kind: the registry each feature projects its own events through, so no
// feature has to aggregate its category client-side outside the store.
//
// It is a `KeyedRegistry` with `duplicatePolicy: "owner-scoped"`, like the pane and screen
// registries: an owner re-registering replaces its claim (hot reload), and a different owner
// claiming a taken kind is refused with an error naming both. The process-wide instance starts
// empty and is seeded in `app/registrations.ts`, before any window opens a session store.

import { KeyedRegistry } from "#renderer/lib/keyed-registry.js";
import type {
  EntityProjector,
  EntityProjectorTable,
} from "#renderer/store/session/entities/vocabulary.js";

/** The event-kind to projector table, with one claiming owner per kind. */
export class EntityProjectorRegistry {
  readonly #claimsByEventKind = new KeyedRegistry<string, EntityProjectorClaim>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "event kind",
    ownerOf: (claim) => claim.owner,
    duplicateHint:
      "one fold per event kind — a second projector would " +
      "make which one runs depend on module import order",
  });

  /** Claims one event kind. A second claim by a different owner is an error, not a swap. */
  public register(eventKind: string, project: EntityProjector, owner: string): void {
    this.#claimsByEventKind.register(eventKind, { project, owner });
  }

  /** Claims every kind in one table atomically; a collision leaves the registry unchanged. */
  public registerAll(projectors: EntityProjectorTable, owner: string): void {
    this.#claimsByEventKind.registerAll(
      Object.entries(projectors).map((entry) => [entry[0], { project: entry[1], owner }] as const),
    );
  }

  /**
   * The table a store is opened with: a frozen snapshot, so the table cannot change under a
   * store that folds events for its session's whole life.
   */
  public snapshot(): EntityProjectorTable {
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

/** One feature's claim on one event kind. */
interface EntityProjectorClaim {
  readonly project: EntityProjector;
  /** The feature that owns the kind, so a conflict names someone. */
  readonly owner: string;
}

/**
 * The process-wide registry that `registerFeatureContributions` seeds and every window's stores
 * read.
 */
export const entityProjectorRegistry: EntityProjectorRegistry = new EntityProjectorRegistry();
