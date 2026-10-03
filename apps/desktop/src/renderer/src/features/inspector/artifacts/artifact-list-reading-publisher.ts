// What an act needs from the reading half of the artifact list.
//
// Its own module because `artifact-row-actions.ts` and `artifact-payload-fetch.ts` both act
// against it; declared in either, the other would import from a peer and close a cycle.

import type { CurrentGenerationClaim } from "@renderer/lib/reads/generation-latch.js";
import type { ArtifactListReading } from "./artifact-list-reading.js";

/**
 * What an act needs from the reading half of the artifact list.
 *
 * Implemented by the reader. Members are operations, not fields, because each reads or writes
 * state the reader owns.
 */
export interface ArtifactListReadingPublisher {
  /** The reading standing right now; every publish spreads forward from it. */
  currentReading(): ArtifactListReading;
  /** Put one reading on the section. */
  publish(reading: ArtifactListReading): void;
  /**
   * The round the scheduled read is on.
   *
   * Read only: an act takes it before its call and asks `isCurrent` after, so a refresh in
   * between marks the act stale.
   */
  scheduledReadClaim(): CurrentGenerationClaim;
}
