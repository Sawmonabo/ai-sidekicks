// What an artifact is to this console: the vocabularies, the row type, and the pure reductions
// the panel draws from.
//
// `ArtifactManifestRow` is a console view model that copies the contract's `ArtifactManifest`.
// The filter's types are the contract's own union, so a type the wire drops fails the filter in
// the same compile; a type a newer daemon sends is drawn by its own words under every type.
//
// Models no payload preview: payloads are explicit-fetch downloads, and nothing in the product
// executes one.

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type {
  ArtifactManifest,
  ArtifactType as ManifestType,
} from "@ai-sidekicks/contracts/artifacts/manifest";

import { lossyStringify } from "#renderer/lib/wire/errors.js";

/** One artifact type: a filter over one list, so the diff pane is a view onto it. */
export type ArtifactType = ManifestType;

/**
 * The manifest envelope a row renders from.
 *
 * `digest` and `size` are always present. The two optional members are absent for two
 * different reasons, and each renders as its own fact rather than a shared "unknown".
 */
export interface ArtifactManifestRow {
  readonly id: ArtifactId;
  readonly sessionId: string;
  /** The run that produced it, when a run did. */
  readonly runId?: string | undefined;
  /** Its type: one the filter offers, or one a newer daemon sends, as sent. */
  readonly artifactType: ArtifactManifest["artifactType"];
  readonly digest: string;
  readonly size: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

/** Zero rows of every type. Total, so the compiler holds it to the wire's union. */
const NO_ARTIFACTS_BY_TYPE: Readonly<Record<ArtifactType, number>> = {
  file: 0,
  diff: 0,
  summary: 0,
  log: 0,
  design: 0,
  workflowOutput: 0,
};

/**
 * Every artifact type, in the order the filter offers them.
 *
 * @consumedBy the inspector's Artifacts section
 */
export const ARTIFACT_FILTER_TYPES = Object.keys(NO_ARTIFACTS_BY_TYPE) as readonly ArtifactType[];

/** The filter's "every type" member, which is not an artifact type. */
export const ARTIFACT_TYPE_FILTER_ALL = "all";

/** What the type filter can be set to: every type, or one. */
export type ArtifactTypeFilter = typeof ARTIFACT_TYPE_FILTER_ALL | ArtifactType;

/**
 * What the panel is showing.
 *
 * `loading` and `listed` with no rows differ on purpose: the read has not answered, or it
 * found none.
 */
export type ArtifactsSectionState =
  | { readonly kind: "loading" }
  | { readonly kind: "listed"; readonly rows: readonly ArtifactManifestRow[] };

/**
 * The rows one filter admits, in the order they arrived.
 *
 * @consumedBy the inspector's Artifacts section
 */
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
 * How many rows each type has, zeros included, so the filter can offer every type. A type the
 * filter does not offer counts under none.
 *
 * @consumedBy the inspector's Artifacts section
 */
export function artifactTypeCounts(
  rows: readonly ArtifactManifestRow[],
): Readonly<Record<ArtifactType, number>> {
  const counts: Record<ArtifactType, number> = { ...NO_ARTIFACTS_BY_TYPE };
  for (const row of rows) {
    if (isFilterType(row.artifactType)) {
      counts[row.artifactType] += 1;
    }
  }
  return counts;
}

/**
 * Read one served manifest as a row.
 *
 * The free-form `metadata` map goes through `renderableStringMap`: a value may be any JSON
 * value, and an object-valued entry would otherwise throw in the row.
 */
export function artifactManifestRowFrom(manifest: ArtifactManifest): ArtifactManifestRow {
  return {
    id: manifest.id,
    sessionId: manifest.sessionId,
    runId: manifest.runId,
    artifactType: manifest.artifactType,
    digest: manifest.digest,
    size: manifest.size,
    metadata: renderableStringMap(manifest.metadata),
    createdAt: manifest.createdAt,
  };
}

function isFilterType(artifactType: string): artifactType is ArtifactType {
  return Object.hasOwn(NO_ARTIFACTS_BY_TYPE, artifactType);
}

/**
 * Every entry of one free-form wire map, as the string a row draws for it.
 *
 * Every value is rendered, since a row showing fewer entries than the daemon sent would
 * misreport provenance. `JSON.stringify` throws on a `BigInt`, a cycle and a hostile
 * `toJSON`, and answers `undefined` for `undefined`, a function and a symbol; both land on
 * `lossyStringify`.
 */
function renderableStringMap(
  entries: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const rendered: Record<string, string> = {};
  // `Object.entries` throws on `null` and `undefined`, and the member is typed present but not
  // proven present; such a row draws no entries.
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
    // A `BigInt`, a cycle, or a `toJSON` that threw.
    return lossyStringify(value);
  }
  // `undefined`, a function or a symbol serialize to nothing.
  return serialized ?? lossyStringify(value);
}
