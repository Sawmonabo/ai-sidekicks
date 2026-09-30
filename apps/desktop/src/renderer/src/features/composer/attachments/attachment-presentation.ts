// What a view is told about an attachment: the two instants, and the sentence an unresolved
// marker carries. The progress figure is the daemon's (the chunk reply carries it), so it lives
// in `services/attachment-ingest-acknowledgement.ts`. Every function takes an entry and, where
// the answer moves on its own, the instant it is asked at; nothing here reads a clock, since an
// age computed from the wall clock would move while nothing was happening. The unresolved
// marker is read from the reading node's own manifest row, never a fresher relay answer.

import type { SessionAttachmentUnresolvedCause } from "@ai-sidekicks/contracts";

import {
  INGEST_STALL_DISCLOSURE_MS,
  INGEST_STREAM_LIFETIME_CEILING_MS,
} from "./attachment-caps.js";
import type { AttachmentIngestEntry } from "./attachment-shapes.js";

/** What a cause means, and what a user can do about it. */
export interface UnresolvedAttachmentPresentation {
  readonly meaning: string;
  /** Absent means there is no remedy, said outright rather than left blank. */
  readonly remedy: string | undefined;
}

/**
 * The six causes, total over `SessionAttachmentUnresolvedCause`, each with its own remedy.
 * `deleted` carries none: a softer sentence would imply a way back.
 */
export const UNRESOLVED_ATTACHMENT_PRESENTATION: Readonly<
  Record<SessionAttachmentUnresolvedCause, UnresolvedAttachmentPresentation>
> = {
  deleted: {
    meaning: "The manifest is gone.",
    remedy: undefined,
  },
  local_only_remote: {
    meaning: "Held on the publishing node only, and this is not that node.",
    remedy: "Change its visibility to shared on the publishing node.",
  },
  pending_replication: {
    meaning: "The publisher has it and the relay does not yet.",
    remedy: "Wait for the publisher's transfer to finish.",
  },
  over_cap: {
    meaning: "Too large to pin on the relay, so it is only reachable from the publisher.",
    remedy: "The publisher must be online.",
  },
  quota_exceeded: {
    meaning: "The publisher's relay quota was full when this was published.",
    remedy: "Free relay quota, then re-publish.",
  },
  expired: {
    meaning: "The payload is not obtainable from the relay.",
    remedy: "The publisher re-publishes it while online.",
  },
};

/** Milliseconds left on this stream's six-hour ceiling, or `undefined` before it opened. */
export function ingestCeilingRemainingMs(
  entry: AttachmentIngestEntry,
  nowMilliseconds: number,
): number | undefined {
  if (entry.openedAtMilliseconds === undefined) {
    return undefined;
  }
  const elapsed = nowMilliseconds - entry.openedAtMilliseconds;
  return Math.max(0, INGEST_STREAM_LIFETIME_CEILING_MS - elapsed);
}

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

/** Whether this upload has been silent long enough to disclose the ceiling. */
export function isIngestStalled(entry: AttachmentIngestEntry, nowMilliseconds: number): boolean {
  const disclosureAtMilliseconds = ingestStallDisclosureAtMs(entry);
  return disclosureAtMilliseconds !== undefined && nowMilliseconds >= disclosureAtMilliseconds;
}
