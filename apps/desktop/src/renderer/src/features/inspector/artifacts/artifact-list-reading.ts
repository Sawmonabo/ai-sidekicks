// What the `Artifacts` section renders from, and the pure reductions over it.
//
// `artifact-list-reader.ts` owns the calls and scheduling; this file owns the immutable value
// and the total functions over it, so a reduction is testable with no bridge, clock or reader.

import type { ArtifactManifestRow, ArtifactsSectionState } from "./artifact-model.js";
import type { ArtifactPayloadReading } from "@renderer/store/artifacts/artifact-payload.js";

/**
 * The instant of a reading nobody has published.
 *
 * A name rather than a bare `0`, so it reads as an instant nobody took and not midnight 1970.
 */
export const UNREAD_AT_MILLISECONDS = 0;

/** Everything the section renders from, in one immutable value. */
export interface ArtifactListReading {
  readonly artifacts: ArtifactsSectionState;
  /**
   * When this reading was published, from the window's clock.
   *
   * On the reading so an age moves only when the read moves: `Date.now()` in a render body
   * would move it on any re-render.
   */
  readonly readAtMilliseconds: number;
  /** The payload fetch a user asked for, at most one at a time. Absent until one starts. */
  readonly payload: ArtifactPayloadReading | undefined;
  /** Rows with a manifest re-read on the wire, so their control holds. */
  readonly manifestReadInFlightArtifactIds: ReadonlySet<string>;
}

/**
 * How one manifest re-read settled.
 *
 * `superseded` changed nothing on screen and never will: the reader was disposed under it, or
 * a refresh had already re-read the row.
 */
export type ArtifactRowActOutcome =
  | { readonly status: "settled" }
  | { readonly status: "superseded" };

/** One shared empty set, so a reading nobody has acted on keeps a stable identity. */
const NO_ACTS_IN_FLIGHT: ReadonlySet<string> = new Set();

/** Before the first read answers. `loading` is a different claim from an empty list. */
export const NOTHING_READ_YET: ArtifactListReading = {
  artifacts: { kind: "loading" },
  readAtMilliseconds: UNREAD_AT_MILLISECONDS,
  payload: undefined,
  manifestReadInFlightArtifactIds: NO_ACTS_IN_FLIGHT,
};

/**
 * The listed rows with one replaced by a fresher read of the same artifact.
 *
 * A row absent from the current list is left out, not re-added: a single-artifact read must
 * not claim a place in the list that no list read established.
 */
export function withReplacedRow(
  artifacts: ArtifactsSectionState,
  row: ArtifactManifestRow,
): ArtifactsSectionState {
  if (artifacts.kind !== "listed") {
    return artifacts;
  }
  return {
    kind: "listed",
    rows: artifacts.rows.map((listed) => (listed.id === row.id ? row : listed)),
  };
}

/** An in-flight set with one row's re-read recorded. A copy, never a mutation. */
export function withArtifactActInFlight(
  inFlightArtifactIds: ReadonlySet<string>,
  artifactId: string,
): ReadonlySet<string> {
  const outstanding = new Set(inFlightArtifactIds);
  outstanding.add(artifactId);
  return outstanding;
}

/**
 * An in-flight set without the row whose re-read has settled.
 *
 * Releasing a row that is not held answers the same set, so a subscriber reads no change.
 */
export function withoutArtifactActInFlight(
  inFlightArtifactIds: ReadonlySet<string>,
  artifactId: string,
): ReadonlySet<string> {
  if (!inFlightArtifactIds.has(artifactId)) {
    return inFlightArtifactIds;
  }
  const remaining = new Set(inFlightArtifactIds);
  remaining.delete(artifactId);
  return remaining;
}

/**
 * What a settled list read publishes, and what of the previous reading survives it.
 *
 * `payload` and the in-flight set survive: they belong to acts this read did not start.
 */
export function settledReadReading(
  previous: ArtifactListReading,
  artifacts: ArtifactListReading["artifacts"],
): Omit<ArtifactListReading, "readAtMilliseconds"> {
  return {
    artifacts,
    payload: previous.payload,
    manifestReadInFlightArtifactIds: previous.manifestReadInFlightArtifactIds,
  };
}
