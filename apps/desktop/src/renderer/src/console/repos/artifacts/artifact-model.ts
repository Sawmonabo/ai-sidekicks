// What an artifact IS to this console, and what the console is allowed to say about
// one — the vocabularies, the copy, and the pure reductions the panel draws from.
//
// WIRE TRUTH FIRST, BECAUSE THIS IS THE FILE WHERE IT IS EASIEST TO GET WRONG.
// `packages/contracts` registers three artifact EVENT strings — `artifact.published`,
// `artifact.superseded`, `artifact.visibility_updated` — and no manifest type, no
// payload variant for any of the three, and no method string for reading, listing,
// re-classifying, or deleting one. `Plan-023 §Console growth slate` carries that
// absence as its own rows, and `console/bridge/growth-port.ts` is where the console
// reaches for those operations and is refused by name.
//
// So `ArtifactManifestRow` below is A CONSOLE VIEW MODEL AND NOT A WIRE TYPE. It
// transcribes the manifest envelope `Spec-014 §Interfaces And Contracts` describes,
// field for field, so the panel is built against the shape the owning
// document specifies rather than against a shape this file invented — and when the
// wire lands, the diff is an import and a deletion here, not a redesign of the
// panel. Nothing in this module claims the daemon sends it.
//
// THE FOUR CLOSED SETS ARE DECLARED ONCE EACH and every consumer derives from them,
// which is the rule and also the only way the totals below can be trusted: three
// states, two visibility classes, six types, five replication statuses plus absent.
//
// WHAT THIS MODULE REFUSES TO MODEL — its own Never list, because no committed
// document carries one for this surface:
//   • No payload preview shape, of any kind. Payloads are explicit-fetch downloads
//     with no in-product execution surface, and the design calls that the defense
//     rather than a preference. A field here holding renderable payload content
//     would be the beginning of the thing that rule forbids.
//   • No recomputation of `replicationStatus`. The persisted value is read verbatim
//     — which is exactly what lets an unresolved attachment marker carry a
//     non-`pinned` status as its cause — so this module maps it to copy and never
//     to a fresher answer.
//   • No per-recipient sharing and no partial redaction. Visibility is a class, and
//     the only two classes are here.
//   • No nulling of a derivative's `subject`. `subject` is read and rendered; the
//     remedy on a blocked delete is the daemon's own, and the console states it.

import type { GrowthArtifactSummary } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import type { ChipTone } from "../../primitives/index.js";

/** The three states a manifest is in. `pending` renders; `superseded` stays as history. */
export const ARTIFACT_STATES = ["pending", "published", "superseded"] as const;

/** One artifact state. Derived, so the vocabulary is declared exactly once. */
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

/** The two visibility CLASSES. V1 visibility is class-based and policy-based, never per-recipient. */
export const ARTIFACT_VISIBILITIES = ["local-only", "shared"] as const;

/** One visibility class. Derived. */
export type ArtifactVisibility = (typeof ARTIFACT_VISIBILITIES)[number];

/**
 * The six types, which are a FILTER over one list and never six lists.
 *
 * Every diff artifact is an artifact and appears in artifact listings, so the diff
 * pane is a view onto this list rather than a second store — a rule this set makes
 * structural, because `diff` is a member here rather than a sibling collection.
 */
export const ARTIFACT_TYPES = [
  "file",
  "diff",
  "summary",
  "log",
  "design",
  "workflow_output",
] as const;

/** One artifact type. Derived. */
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** The five replication statuses. ABSENT is the sixth reading and is not a member — see the copy table. */
export const ARTIFACT_REPLICATION_STATUSES = [
  "pending_replication",
  "pinned",
  "over_cap",
  "quota_exceeded",
  "expired",
] as const;

/** One replication status. Derived. */
export type ArtifactReplicationStatus = (typeof ARTIFACT_REPLICATION_STATUSES)[number];

/** What a delete did to the bytes. Reported after the act, never predicted before it. */
export const ARTIFACT_PAYLOAD_DISPOSITIONS = [
  "reclaimed",
  "reclaim_pending",
  "retained_by_references",
] as const;

/** One payload disposition. Derived. */
export type ArtifactPayloadDisposition = (typeof ARTIFACT_PAYLOAD_DISPOSITIONS)[number];

/**
 * The manifest envelope a row renders from.
 *
 * `digest` and `size` are always present — the design says so and the panel relies
 * on it, which is why neither is optional here. The four that are optional are
 * optional for four different reasons, and each is rendered as its own fact rather
 * than as a shared "unknown".
 */
export interface ArtifactManifestRow {
  readonly id: string;
  readonly sessionId: string;
  /** The run that produced it, when a run did. */
  readonly runId?: string | undefined;
  /** The participant that produced it. ABSENT means the daemon itself — a producer, not a gap. */
  readonly createdBy?: string | undefined;
  readonly artifactType: ArtifactType;
  readonly digest: string;
  readonly size: number;
  readonly annotations: Readonly<Record<string, string>>;
  /** The source this artifact was derived from, when it is a derivative. */
  readonly subject?: string | undefined;
  readonly visibility: ArtifactVisibility;
  readonly state: ArtifactState;
  /** ABSENT means local-only: no relay copy is expected, so no relay status exists to report. */
  readonly replicationStatus?: ArtifactReplicationStatus | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

/** What a delete reported, after the fact. */
export interface ArtifactDeleteReceipt {
  readonly artifactId: string;
  /**
   * True when re-publish is permanently impossible for this artifact and the
   * late-join remedy is gone.
   *
   * THE ONLY PLACE THIS FACT EXISTS. Nothing before the delete can answer it — the
   * daemon settles it by observing whether the row carried the retained relay key at
   * the moment the row went — so the confirmation states the possibility and this
   * member states what happened. Two halves of one disclosure, and only the second
   * one is a fact.
   */
  readonly rePublishForeclosed: boolean;
  readonly payloadDisposition: ArtifactPayloadDisposition;
}

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

/** The filter's "every type" member, which is not an artifact type. */
export const ARTIFACT_TYPE_FILTER_ALL = "all";

/** What the type filter can be set to: every type, or one of the six. */
export type ArtifactTypeFilter = typeof ARTIFACT_TYPE_FILTER_ALL | ArtifactType;

/**
 * What the panel is showing, as four arms rather than a bag of booleans.
 *
 * `not-checked` and `listed` with an empty array are DIFFERENT arms on purpose: one
 * says nobody asked and the other says the read found none, and the console's
 * absence grammar renders them differently because the operator's next move differs.
 * A `rows: readonly []` standing in for both is precisely the conflation the rule
 * forbids.
 */
export type ArtifactsPanelState =
  | { readonly kind: "not-checked" }
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly kind: "listed"; readonly rows: readonly ArtifactManifestRow[] };

/** The rows one filter admits, in the order they arrived. */
export function filterArtifactRows(
  rows: readonly ArtifactManifestRow[],
  filter: ArtifactTypeFilter,
): readonly ArtifactManifestRow[] {
  if (filter === ARTIFACT_TYPE_FILTER_ALL) {
    return rows;
  }
  return rows.filter((row) => row.artifactType === filter);
}

/**
 * How many rows each type has, total over the six.
 *
 * Total rather than sparse so the filter can render every type it offers, including
 * the ones at zero: a filter that hid its empty options would make the six-type
 * vocabulary invisible exactly when a participant is looking for something that is
 * not there.
 */
export function artifactTypeCounts(
  rows: readonly ArtifactManifestRow[],
): Readonly<Record<ArtifactType, number>> {
  const counts: Record<ArtifactType, number> = {
    file: 0,
    diff: 0,
    summary: 0,
    log: 0,
    design: 0,
    workflow_output: 0,
  };
  for (const row of rows) {
    counts[row.artifactType] += 1;
  }
  return counts;
}

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

/**
 * Read one served manifest summary as a row.
 *
 * THIS FUNCTION USED TO BE A REFUSAL. `console/bridge/growth-values.ts` once answered
 * `artifactList` with a four-member payload summary — `artifactId`, `name`,
 * `byteLength`, `contentType` — and a reader that had mapped those four into the
 * envelope below would have put a `state` and a `visibility` on screen that no read
 * established. So a served list was refused by name instead. `GrowthArtifactSummary`
 * now mirrors `api-payload-contracts.md §ArtifactManifest` member for member, so the
 * mapping this comment used to forbid is the only member-for-member reading there is,
 * and every field a row renders comes from one the reply carried.
 *
 * ONE MEMBER IS SPELLED DIFFERENTLY AND ONE IS NARROWED. `artifactId` becomes `id`,
 * the name this view model has always used. And `metadata` is freeform daemon-side
 * provenance typed `unknown` on the wire while the row renders strings, so a
 * non-string value is rendered in its own JSON form rather than dropped: a row that
 * silently showed fewer entries than the daemon sent would misreport the provenance
 * it exists to show.
 */
export function artifactManifestRowFromSummary(
  summary: GrowthArtifactSummary,
): ArtifactManifestRow {
  return {
    id: summary.artifactId,
    sessionId: summary.sessionId,
    runId: summary.runId,
    createdBy: summary.createdBy,
    artifactType: summary.artifactType,
    digest: summary.digest,
    size: summary.size,
    annotations: summary.annotations,
    subject: summary.subject,
    visibility: summary.visibility,
    state: summary.state,
    replicationStatus: summary.replicationStatus,
    metadata: renderableMetadata(summary.metadata),
    createdAt: summary.createdAt,
  };
}

/** Every metadata entry, as the string a row draws for it. */
function renderableMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    rendered[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return rendered;
}
