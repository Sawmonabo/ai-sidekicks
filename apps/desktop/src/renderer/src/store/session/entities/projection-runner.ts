// Running one event's registered projector, all-or-nothing. A projector is pure and total
// (`vocabulary.ts`), and one that rejects a malformed payload is a defect in its feature; this
// boundary keeps that local: the event loses its entity contribution, never the batch, the
// process or half a partition.

import { RealClock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import type { ProjectedSessionEvent, EntityProjectorTable } from "./vocabulary.js";
import { mergeRemoval, mergeUpsert, type SessionPartitions } from "./partitions.js";

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
   * All-or-nothing: merges accumulate on a scratch value, so a projector that throws, or a mutation
   * naming a nonexistent kind, leaves the caller's partitions as they were; the loss is reported
   * through the store's degraded vocabulary, and the event kind and what was thrown go to
   * diagnostic capture, so the failing projector can be found. An event no projector claims is not
   * a failure and answers the partitions unchanged.
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
    } catch (error: unknown) {
      windowDiagnosticCapture.record({
        at: diagnosticStampAt(new RealClock()),
        severity: "error",
        source: "store/session",
        kind: "projector-threw",
        detail: `${event.kind}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
    return projected;
  }
}
