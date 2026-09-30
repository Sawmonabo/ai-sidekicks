// Running one event's registered projector, all-or-nothing. A projector is pure and total
// (`entities.ts`), and one that rejects a malformed payload is a defect in its feature; this
// boundary keeps that local: the event loses its entity contribution, never the batch, the
// process or half a partition.

import type { ProjectedSessionEvent, EntityProjectorTable } from "./entities.js";
import { mergeRemoval, mergeUpsert, type SessionPartitions } from "./entity-partitions.js";

/**
 * The registered projectors, and the one way to run them. A class because the registry is
 * per-store construction state; a free function would make every call site carry it.
 */
export class EntityProjectionRunner {
  readonly #projectors: EntityProjectorTable;

  public constructor(projectors: EntityProjectorTable) {
    this.#projectors = projectors;
  }

  /**
   * Apply one event's projection, or answer `undefined` when the projector rejected it.
   *
   * All-or-nothing: merges accumulate on a scratch value, so a projector that throws, or a
   * mutation naming a nonexistent kind, leaves the caller's partitions as they were; the loss is
   * reported through the store's degraded vocabulary. An event no projector claims is not a
   * failure and answers the partitions unchanged.
   */
  public run(
    partitions: SessionPartitions,
    event: ProjectedSessionEvent,
  ): SessionPartitions | undefined {
    const projector = Object.hasOwn(this.#projectors, event.kind)
      ? this.#projectors[event.kind]
      : undefined;
    if (projector === undefined) {
      return partitions;
    }
    let projected = partitions;
    try {
      for (const mutation of projector(event)) {
        projected =
          mutation.operation === "upsert"
            ? mergeUpsert(projected, mutation.entity)
            : mergeRemoval(projected, mutation.ref);
      }
    } catch {
      return undefined;
    }
    return projected;
  }
}
