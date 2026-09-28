// What an artifact is to this console: the vocabularies, the row type, and the pure
// reductions the panel draws from.
//
// The sentences the console may say about one are in `artifact-copy.ts`; copy names these
// types and nothing here names a sentence.
//
// `ArtifactManifestRow` is a console view model, not a wire type: it copies the manifest
// envelope the bridge serves as `GrowthArtifactSummary`, field for field. The state and
// type vocabularies are the bridge's own declarations, so a member the wire drops leaves
// the row type, the filter and the copy tables in the same compile.
//
// This module models no payload preview and never nulls a derivative's `subject`. Payloads
// are explicit-fetch downloads with no in-product execution surface.

import type {
  GrowthArtifactState,
  GrowthArtifactSummary,
  GrowthArtifactType,
} from "../../bridge/index.js";
import { lossyStringify } from "../../core/index.js";

/** One artifact state: an alias of the wire's union, so a dropped member fails the compile. */
export type ArtifactState = GrowthArtifactState;

/**
 * One artifact type, a filter over one list and never six lists.
 *
 * `diff` is a member of the set, so the diff pane is a view onto this list rather than a
 * second store.
 */
export type ArtifactType = GrowthArtifactType;

/**
 * The manifest envelope a row renders from.
 *
 * `digest` and `size` are always present. The three optional members are optional for
 * three different reasons, and each renders as its own fact rather than as a shared
 * "unknown".
 */
export interface ArtifactManifestRow {
  readonly id: string;
  readonly sessionId: string;
  /** The run that produced it, when a run did. */
  readonly runId?: string | undefined;
  /** The user that produced it. ABSENT means the daemon itself — a producer, not a gap. */
  readonly createdBy?: string | undefined;
  readonly artifactType: ArtifactType;
  readonly digest: string;
  readonly size: number;
  readonly annotations: Readonly<Record<string, string>>;
  /** The source this artifact was derived from, when it is a derivative. */
  readonly subject?: string | undefined;
  readonly state: ArtifactState;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

/** The filter's "every type" member, which is not an artifact type. */
export const ARTIFACT_TYPE_FILTER_ALL = "all";

/** What the type filter can be set to: every type, or one of the six. */
export type ArtifactTypeFilter = typeof ARTIFACT_TYPE_FILTER_ALL | ArtifactType;

/**
 * What the panel is showing.
 *
 * `loading` and `listed` with an empty array are different arms on purpose: one says the
 * read has not answered and the other says it found none, and the operator's next move
 * differs.
 */
export type ArtifactsPanelState =
  | { readonly kind: "loading" }
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
 * Total rather than sparse so the filter can offer every type, including the ones at
 * zero.
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
 * `artifactId` becomes `id`. The two free-form maps, `annotations` and `metadata`, are
 * read through `renderableStringMap` rather than copied, because nothing parses them at
 * the port boundary: an absent map or an object-valued entry would otherwise throw in
 * the row and take the whole panel down.
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
    state: summary.state,
    metadata: renderableStringMap(summary.metadata),
    createdAt: summary.createdAt,
  };
}

/**
 * Every entry of one free-form wire map, as the string a row draws for it.
 *
 * A value is always rendered in some form, because a row that silently showed fewer
 * entries than the daemon sent would misreport the provenance it exists to show.
 * `JSON.stringify` throws on a `BigInt`, a cycle and a hostile `toJSON`, and answers
 * `undefined` for `undefined`, a function and a symbol; both cases land on
 * `lossyStringify`, the console's total stringifier.
 */
function renderableStringMap(
  entries: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const rendered: Record<string, string> = {};
  // `Object.entries` throws on `null` and `undefined`, and the member is typed present
  // but not proven present. A row missing its provenance draws no entries, the same as
  // a row with an empty map.
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
  // `undefined`, a function or a symbol serialize to nothing.
  return serialized ?? lossyStringify(value);
}
