// Running one event's registered projector, all-or-nothing.
//
// A projector is required to be pure and total (`store/entities.ts`), and one that
// rejects a malformed payload is a defect in the view family that registered it.
// This module is the boundary that keeps that defect local: it costs the event its
// entity contribution and nothing else — never the batch, never the process, and
// never half a partition.

import type { ConsoleSessionEvent, EntityProjectorRegistry } from "./entities.js";
import { mergeRemoval, mergeUpsert, type SessionPartitions } from "./entity-partitions.js";

/**
 * The registered projectors, and the one way to run them.
 *
 * A class rather than a free function over a registry argument because the
 * registry is per-store construction state: a free function would have every call
 * site carry it, and the first site that carried a different one would be a second
 * projection path with no way to tell it apart from the first.
 */
export class EntityProjectionRunner {
  readonly #projectors: EntityProjectorRegistry;

  public constructor(projectors: EntityProjectorRegistry) {
    this.#projectors = projectors;
  }

  /**
   * Apply one event's projection, or answer `undefined` when the projector
   * rejected it.
   *
   * All-or-nothing: the merges accumulate onto a scratch value and only the
   * completed one is returned, so a projector that throws — or a mutation naming a
   * kind that does not exist — leaves the caller's partitions exactly as they
   * were. Half a transition nothing will ever complete is worse than none of it,
   * and the store's own degraded vocabulary is where the loss is reported.
   *
   * An event whose kind no projector claims is not a failure: it contributes no
   * entity and the caller's partitions are answered unchanged.
   */
  public run(
    partitions: SessionPartitions,
    event: ConsoleSessionEvent,
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
