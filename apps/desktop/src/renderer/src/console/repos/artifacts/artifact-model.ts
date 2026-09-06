// What an artifact IS to this console — the vocabularies, the row type, and the pure
// reductions the panel draws from.
//
// WHAT THE CONSOLE MAY SAY about one is `artifact-copy.ts`, split off on the seam this
// line used to straddle. The dependency runs one way: copy names these types, and
// nothing here names a sentence.
//
// WIRE TRUTH FIRST, BECAUSE THIS IS THE FILE WHERE IT IS EASIEST TO GET WRONG.
// `packages/contracts` registers three artifact EVENT strings — `artifact.published`,
// `artifact.superseded`, `artifact.visibility_updated` — and no manifest type, no
// payload variant for any of the three, and no method string for reading, listing,
// re-classifying, or deleting one. `Plan-023 §Console growth slate` carries that
// absence as its own rows, and `console/bridge/growth-port/growth-port.ts` is where the console
// reaches for those operations and is refused by name.
//
// So `ArtifactManifestRow` below is A CONSOLE VIEW MODEL AND NOT A WIRE TYPE. It
// transcribes the manifest envelope `Spec-014 §Interfaces And Contracts` describes,
// field for field, so the panel is built against the shape the owning
// document specifies rather than against a shape this file invented — and when the
// wire lands, the diff is an import and a deletion here, not a redesign of the
// panel. Nothing in this module claims the daemon sends it.
//
// THE CLOSED SETS ARE THE WIRE'S, NOT THIS MODULE'S. Five of them — states,
// visibility classes, types, replication statuses, payload dispositions — used to be
// declared here as `as const` arrays, member for member identical to the ones
// `bridge/growth-values/artifacts.ts` declares for the same envelope, each copy under
// a comment claiming to be the one home. The drift that pair admits is silent and
// one-directional: the wire DROPS a replication status, this module still enumerates
// it, the copy table still holds a row for it and the filter still offers it,
// and nothing fails, because a value assigned into a row stays assignable when the
// union it came from shrinks. So the five vocabularies are derived from the bridge's
// own declarations through `bridge/index.ts`, and the totals follow from them: three
// states, two visibility classes, six types, five replication statuses plus absent,
// three payload dispositions.
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

import type {
  GrowthArtifactPayloadDisposition,
  GrowthArtifactReplicationStatus,
  GrowthArtifactState,
  GrowthArtifactSummary,
  GrowthArtifactType,
  GrowthArtifactVisibility,
} from "../../bridge/index.js";
import { lossyStringify, type ConsoleRefusal } from "../../core/index.js";

/**
 * One artifact state, named in this family's vocabulary and declared in the wire's.
 *
 * AN ALIAS AND NOT A SECOND UNION: the five aliases below rename nothing and add
 * nothing, so a member the wire drops leaves the row type, the filter, and the
 * presentation tables in the same compile. `pending` renders; `superseded` stays as
 * history.
 */
export type ArtifactState = GrowthArtifactState;

/** One visibility CLASS. V1 visibility is class-based and policy-based, never per-recipient. */
export type ArtifactVisibility = GrowthArtifactVisibility;

/**
 * One artifact type, which is a FILTER over one list and never six lists.
 *
 * Every diff artifact is an artifact and appears in artifact listings, so the diff
 * pane is a view onto this list rather than a second store — a rule the wire's own set
 * makes structural, because `diff` is a member of it rather than a sibling collection.
 */
export type ArtifactType = GrowthArtifactType;

/** One replication status. ABSENT is the sixth reading and is not a member — see the copy table. */
export type ArtifactReplicationStatus = GrowthArtifactReplicationStatus;

/** What a delete did to the bytes. Reported after the act, never predicted before it. */
export type ArtifactPayloadDisposition = GrowthArtifactPayloadDisposition;

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

/**
 * Read one served manifest summary as a row.
 *
 * THIS FUNCTION USED TO BE A REFUSAL. `console/bridge/growth-values/artifacts.ts` once answered
 * `artifactList` with a four-member payload summary — `artifactId`, `name`,
 * `byteLength`, `contentType` — and a reader that had mapped those four into the
 * envelope below would have put a `state` and a `visibility` on screen that no read
 * established. So a served list was refused by name instead. `GrowthArtifactSummary`
 * now mirrors `api-payload-contracts.md §ArtifactManifest` member for member, so the
 * mapping this comment used to forbid is the only member-for-member reading there is,
 * and every field a row renders comes from one the reply carried.
 *
 * ONE MEMBER IS SPELLED DIFFERENTLY AND TWO ARE READ RATHER THAN COPIED. `artifactId`
 * becomes `id`, the name this view model has always used. And the two free-form maps —
 * `annotations` and `metadata` — both go through the total reader below, so a
 * non-string value is rendered in its own JSON form rather than dropped: a row that
 * silently showed fewer entries than the daemon sent would misreport the provenance
 * it exists to show.
 *
 * BOTH MAPS, BECAUSE THE WIRE PROVES NEITHER. `metadata` is typed `unknown` per value
 * and `annotations` is typed `Readonly<Record<string, string>>`, and the difference is
 * a declaration rather than a check: nothing parses either at the port boundary, so a
 * summary is whatever crossed the process boundary. Copied through, an absent
 * `annotations` map threw inside `ArtifactRow`'s `Object.entries` and an object-valued
 * entry threw as a React child — one row taking the whole panel down, which is the
 * exact failure the reader was written against on the sibling map.
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
    annotations: renderableStringMap(summary.annotations),
    subject: summary.subject,
    visibility: summary.visibility,
    state: summary.state,
    replicationStatus: summary.replicationStatus,
    metadata: renderableStringMap(summary.metadata),
    createdAt: summary.createdAt,
  };
}

/**
 * Every entry of one free-form wire map, as the string a row draws for it.
 *
 * ONE READER FOR BOTH MAPS. `annotations` and `metadata` are the same kind of thing —
 * free-form daemon-side provenance a row renders as pairs — and a second copy of this
 * reading would be a second chance for one of the two to lose its guard.
 *
 * `JSON.stringify` IS NOT TOTAL, AND BOTH OF ITS FAILURES REACH THIS ROW. Nothing
 * upstream of here constrains what a value is:
 *
 *   • IT THROWS on a `BigInt`, on a structure that refers to itself, and on a hostile
 *     `toJSON`. Thrown from here it escapes the row builder, the reader's fold, and
 *     the render — taking the whole pane down over one provenance entry.
 *   • IT ANSWERS `undefined` for `undefined`, a function, and a symbol, which the
 *     return type says cannot happen. That value went into a `Record<string, string>`
 *     unchecked, so the row carried a hole the compiler had been told was a string
 *     and a surface reading `.length` on it threw one layer further out.
 *
 * Both land on `lossyStringify`, the console's total stringifier — reached through
 * `core/`, which declares itself the home for turning an unknown into displayable
 * text, and total by construction rather than by one more layer of `try`. A value is RENDERED IN SOME FORM either way,
 * because a row that silently showed fewer entries than the daemon sent would
 * misreport the provenance it exists to show.
 */
function renderableStringMap(
  entries: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const rendered: Record<string, string> = {};
  // `Object.entries` THROWS on `null` and on `undefined`, and the member is typed
  // present rather than proven present: a summary is whatever crossed the process
  // boundary. A row missing its provenance draws no entries, which is what a row
  // whose map is empty draws too — and is the only reading available, where the
  // alternative is the whole list read rejecting over one row.
  if (typeof entries !== "object" || entries === null) {
    return rendered;
  }
  for (const [key, value] of Object.entries(entries)) {
    rendered[key] = typeof value === "string" ? value : renderableMapValue(value);
  }
  return rendered;
}

/** One non-string map value, as a string, whatever it is. */
function renderableMapValue(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // A `BigInt`, a cycle, or a `toJSON` that threw. The value is still shown.
    return lossyStringify(value);
  }
  // `undefined`, a function, or a symbol: serialization succeeded and produced no
  // JSON at all, which is a different fact from a failure and takes the same home.
  return serialized ?? lossyStringify(value);
}
