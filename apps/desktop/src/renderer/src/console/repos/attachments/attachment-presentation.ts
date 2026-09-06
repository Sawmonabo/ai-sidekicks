// What a surface is TOLD about an attachment: the two instants, and the sentence an
// unresolved marker carries.
//
// THE PROGRESS FIGURE IS NOT HERE, AND THAT IS THE SEAM MOVING RATHER THAN WIDENING.
// The running total is the DAEMON's — the chunk reply carries it — so reading one is a
// protocol question rather than a presentation one and lives in
// `attachment-ingest-acknowledgement.ts` beside the leg that asks it.
//
// THE SEAM, IN ONE SENTENCE: this module changes when what a person sees changes. Every
// function here takes an entry — and, where the answer moves on its own, the instant it
// is being asked at — and returns something a card renders. It writes nothing, calls
// nothing, and holds no state, which is what lets `AttachmentCard.tsx` stay a render.
//
// THE INSTANT IS ALWAYS A PARAMETER. Nothing here reads a clock. An age that a card
// computed from the wall clock would move while nothing was happening, and a stall
// disclosure that appeared with no publish behind it would be a figure with no record.
// `attachment-carrier.ts` stamps the snapshot and hands the instant down.
//
// WHAT THIS MODULE REFUSES TO MODEL:
//   • No unresolved cause recomputed from live relay state. The marker is read from the
//     reading node's own manifest row and mapped to copy here, never to a fresher
//     answer.

import { INGEST_STALL_DISCLOSURE_MS, INGEST_STREAM_LIFETIME_CEILING_MS } from "../../core/index.js";
import type { UnresolvedAttachmentCause } from "./attachment-policy.js";
import type { AttachmentIngestEntry } from "./attachment-shapes.js";

// --- Where the bounds live -----------------------------------------------
//
// NOT HERE. The attachment byte cap, the carrier cap, the chunk cap, the stream
// lifetime, and the stall disclosure are behavioural limits three modules spend — this
// one, the ingest client, and the artifact pane — and four of the five mirror a bound
// `Spec-014 §Bounds (normative defaults; operator-tunable)` registers on the wire. A
// view-family module holding them would make this file a configuration authority its
// neighbours had to import to learn a number the daemon owns, so they sit in
// `core/constants.ts` with their rationales and their wire sources, and the two this
// file's own arithmetic spends are imported above like any other consumer's.

/** What a cause means, and what a participant can do about it. */
export interface UnresolvedAttachmentPresentation {
  readonly meaning: string;
  /** ABSENT means there is no remedy — said outright rather than left blank. */
  readonly remedy: string | undefined;
}

/**
 * The six causes, total over `UnresolvedAttachmentCause`.
 *
 * Each carries its OWN remedy, because they are six different situations and a shared
 * "try again later" would be wrong for five of them. `deleted` carries none, and the
 * absence is the honest answer rather than a softer sentence that implies a way back.
 */
export const UNRESOLVED_ATTACHMENT_PRESENTATION: Readonly<
  Record<UnresolvedAttachmentCause, UnresolvedAttachmentPresentation>
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
 * The instant this upload's silence becomes worth disclosing, or `undefined` where
 * there is nothing outstanding to go quiet.
 *
 * The DEADLINE rather than only the predicate, because two callers need it and they
 * need the same one: the card asks whether the instant it was handed is past it, and
 * the carrier asks when to hand the card a fresher instant. Two subtractions against
 * one threshold would be two places for the threshold to be spent, and a carrier that
 * woke a second early would render a card that was still not stalled.
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
