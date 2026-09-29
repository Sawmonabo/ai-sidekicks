// What an act needs from the half of the artifact list that reads.
//
// Declared in its own module because two classes act against it: `artifact-row-actions.ts`
// owns the manifest re-read and `artifact-payload-fetch.ts` owns the payload fetch. Declared
// in either, the other would import a contract from a peer and close a cycle.

import type { CurrentGenerationClaim } from "@renderer/lib/reads/generation-latch.js";
import type { ArtifactListReading } from "./artifact-list-reading.js";

/**
 * What an act needs from the half of the artifact list that reads.
 *
 * Implemented by the reader, so the two halves share a contract rather than a field.
 * Every member reads or writes state the reader owns, which is why they are named as
 * operations rather than exposed as the fields they touch.
 */
export interface ArtifactListReadingPublisher {
  /** The reading standing right now. Every publish below spreads forward from it. */
  currentReading(): ArtifactListReading;
  /** Put one reading on the section. */
  publish(reading: ArtifactListReading): void;
  /**
   * The round the scheduled read is on.
   *
   * Read, never mutated: an act takes it before its call and asks `isCurrent` after, and
   * a round the reader superseded means a refresh has re-read the rows the act was about.
   */
  scheduledReadClaim(): CurrentGenerationClaim;
}
