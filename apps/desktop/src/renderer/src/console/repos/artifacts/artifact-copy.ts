// What the console is allowed to SAY about an artifact — the tone-and-sentence tables
// over the wire's five closed sets, and the two readings that pick from them.
//
// SPLIT FROM `artifact-model.ts` ON THE SEAM THAT FILE'S OWN FIRST LINE DRAWS: what an
// artifact IS versus what the console may say about one. The model side is the row
// type, the filter, and the pure reductions; this side is every word a participant
// reads. They part cleanly because the dependency runs one way — copy names the model's
// types, and no model function names a sentence — so a change to a sentence recompiles
// nothing but the surfaces that draw it.
//
// EVERY TABLE IS TOTAL OVER A WIRE VOCABULARY, NOT OVER A LOCAL ONE. The five keys are
// `artifact-model.ts`'s aliases of the bridge's own declarations, so a member the wire
// drops fails the compile here rather than leaving a row of copy for a status that no
// longer exists. That totality is the whole reason the tables are `Record<K, …>` and not
// partial maps with a fallback: a fallback would render the drift instead of failing on
// it.

import type { ChipTone } from "../../primitives/index.js";

import type {
  ArtifactDeleteReceipt,
  ArtifactManifestRow,
  ArtifactPayloadDisposition,
  ArtifactReplicationStatus,
  ArtifactState,
  ArtifactVisibility,
} from "./artifact-model.js";

/** A vocabulary member's tone and its one sentence. */
export interface ArtifactPresentation {
  readonly tone: ChipTone;
  readonly meaning: string;
}

/** The three states. Total over `ArtifactState` by construction. */
export const ARTIFACT_STATE_PRESENTATION: Readonly<Record<ArtifactState, ArtifactPresentation>> = {
  pending: {
    tone: "neutral",
    meaning: "In flight. The publish has started and has not completed.",
  },
  published: {
    tone: "neutral",
    meaning: "Published.",
  },
  superseded: {
    tone: "neutral",
    meaning: "Superseded by a later artifact. The row stays as history.",
  },
};

/** The two visibility classes. Total over `ArtifactVisibility`. */
export const ARTIFACT_VISIBILITY_PRESENTATION: Readonly<
  Record<ArtifactVisibility, ArtifactPresentation>
> = {
  "local-only": {
    tone: "neutral",
    meaning: "Held on this node only. No relay copy exists.",
  },
  shared: {
    tone: "accent",
    meaning: "Shared with the session through the relay.",
  },
};

/**
 * The five replication statuses. Total over `ArtifactReplicationStatus`.
 *
 * Two of the sentences are the design's own words rather than a paraphrase, and
 * both matter: `over_cap` and `quota_exceeded` say the payload is unavailable WHILE
 * THE PUBLISHER IS OFFLINE — a condition that lifts — and `expired` says the
 * payload is not obtainable FROM THE RELAY with re-publish as the remedy, never the
 * narrower "TTL elapsed", which describes the cause and hides the way out.
 */
export const ARTIFACT_REPLICATION_PRESENTATION: Readonly<
  Record<ArtifactReplicationStatus, ArtifactPresentation>
> = {
  pending_replication: {
    tone: "neutral",
    meaning: "Awaiting deferred transfer to the relay.",
  },
  pinned: {
    tone: "neutral",
    meaning: "Held on the relay.",
  },
  over_cap: {
    tone: "attention",
    meaning: "Unavailable while the publisher is offline.",
  },
  quota_exceeded: {
    tone: "attention",
    meaning: "Unavailable while the publisher is offline.",
  },
  expired: {
    tone: "attention",
    meaning: "Payload not obtainable from the relay. The publisher re-publishing restores it.",
  },
};

/** The sixth reading: no `replicationStatus` at all. */
export const ARTIFACT_REPLICATION_ABSENT: ArtifactPresentation = {
  tone: "neutral",
  meaning: "Local-only — no relay copy is expected, so there is no relay status to report.",
};

/** What an absent `createdBy` names. A producer, stated as one. */
export const ARTIFACT_PRODUCER_ABSENT_LABEL = "the daemon";

/** What each payload disposition tells a participant about the bytes. */
export const ARTIFACT_PAYLOAD_DISPOSITION_COPY: Readonly<
  Record<ArtifactPayloadDisposition, string>
> = {
  reclaimed: "The bytes were reclaimed.",
  reclaim_pending: "The bytes are still being reclaimed.",
  retained_by_references: "The bytes stayed: another manifest names them.",
};

/**
 * What a delete's own receipt says, in one sentence.
 *
 * ONE COMPOSITION FOR BOTH HALVES OF THE REPORT. The panel draws this sentence and
 * the pane announces it, and until the daemon's receipt reached the console at all
 * they were two different claims: the strip said the bytes' disposition was
 * unreported and the announcement said the reply carried none. Both were true of a
 * reply that carried nothing and neither is true now, and a second spelling of the
 * consequence would be the copy that drifts.
 *
 * Every word is the receipt's own. The disposition comes from the table above, which
 * is total over the three arms the daemon may settle, and the re-publish clause reads
 * the boolean rather than inferring anything from the disposition — a payload retained
 * by another manifest still foreclosed re-publish if this row carried the relay key.
 */
export function artifactDeleteReceiptSentence(receipt: ArtifactDeleteReceipt): string {
  const rePublish = receipt.rePublishForeclosed
    ? "Re-publishing this artifact is now permanently impossible."
    : "Re-publishing is still possible.";
  return `${ARTIFACT_PAYLOAD_DISPOSITION_COPY[receipt.payloadDisposition]} ${rePublish}`;
}

/**
 * The consequence a delete confirm states BEFORE the act.
 *
 * CONDITIONAL, BECAUSE THE FACT IS NOT KNOWN YET. Whether a delete forecloses
 * re-publishing is `rePublishForeclosed` on the receipt, and the receipt exists only
 * AFTER the act: the daemon reports whether this row carried the publisher-retained
 * relay key and that key died with it, which is local state no read on this surface
 * has asked for. A confirmation that stated the foreclosure flatly was therefore
 * false for every artifact that carried no such key — and contradicted the receipt
 * the same panel prints a moment later, which says re-publishing is still possible.
 *
 * So this sentence says what deletion MAY cost and names the receipt as what settles
 * it. It does not soften the warning: the destructive case is stated in full, and the
 * only thing removed is the claim that it is the case here.
 */
export const ARTIFACT_DELETE_CONSEQUENCE =
  "Deleting may foreclose re-publishing this artifact: where this row carried the retained relay key, that key is destroyed with it and a participant who joins later has no way back to it. The receipt this delete answers with reports whether that happened.";

/** The replication reading for a row, absent status included. */
export function artifactReplicationPresentation(row: ArtifactManifestRow): ArtifactPresentation {
  return row.replicationStatus === undefined
    ? ARTIFACT_REPLICATION_ABSENT
    : ARTIFACT_REPLICATION_PRESENTATION[row.replicationStatus];
}

/** Who produced a row. An absent producer is the daemon, named rather than blanked. */
export function artifactProducerLabel(row: ArtifactManifestRow): string {
  return row.createdBy ?? ARTIFACT_PRODUCER_ABSENT_LABEL;
}
