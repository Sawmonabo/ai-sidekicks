// What a view is told about an upload's silence: the instant it becomes worth disclosing, and
// whether it has. The progress figure is the daemon's (the chunk reply carries it), so it lives
// in `services/attachment-ingest-acknowledgement.ts`. Every function takes an entry and, where
// the answer moves on its own, the instant it is asked at; nothing here reads a clock, since an
// age computed from the wall clock would move while nothing was happening.

import { INGEST_STALL_DISCLOSURE_MS } from "./caps.js";
import type { AttachmentIngestEntry } from "./shapes.js";

/**
 * The instant this upload's silence becomes worth disclosing, or `undefined` when nothing is
 * outstanding. A deadline rather than a predicate because the card and the staged list need the
 * same threshold: the list wakes at it to hand the card a fresher instant.
 */
export function ingestStallDisclosureAtMs(entry: AttachmentIngestEntry): number | undefined {
  if (entry.state !== "ingesting" || entry.lastProgressAtMilliseconds === undefined) {
    return undefined;
  }
  return entry.lastProgressAtMilliseconds + INGEST_STALL_DISCLOSURE_MS;
}

/** Whether this upload has been silent long enough to say so. */
export function isIngestStalled(entry: AttachmentIngestEntry, nowMilliseconds: number): boolean {
  const disclosureAtMilliseconds = ingestStallDisclosureAtMs(entry);
  return disclosureAtMilliseconds !== undefined && nowMilliseconds >= disclosureAtMilliseconds;
}
