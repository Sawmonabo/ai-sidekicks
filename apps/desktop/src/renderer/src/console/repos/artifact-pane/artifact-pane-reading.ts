// What the artifact pane renders from, and the pure reductions over it.
//
// `artifact-reader.ts` owns the calls, the scheduler and the generation stamp; this file
// owns the immutable value those produce and every total function over it, so a
// reduction can be driven directly in a test with no bridge, clock or reader.

import type { ArtifactManifestRow, ArtifactsPanelState } from "../artifacts/artifact-model.js";
import type { ArtifactPayloadReading } from "./artifact-payload.js";

/**
 * The instant a reading nobody has published yet carries.
 *
 * Named rather than a bare `0`, so it reads as an instant nobody took and not midnight
 * 1970. The reader stamps its opening reading from the window's clock at construction.
 */
export const UNREAD_AT_MILLISECONDS = 0;

/** Everything the pane renders from, in one immutable value. */
export interface ArtifactPaneReading {
  readonly artifacts: ArtifactsPanelState;
  /**
   * The instant this reading was published at, from the window's own clock.
   *
   * On the reading so an age moves when the read moves and on no other occasion: a card
   * calling `Date.now()` in its render body would move an age on any unrelated re-render.
   * The reader's one publish stamps it, so no producer can put a reading on screen with
   * an earlier instant.
   */
  readonly readAtMilliseconds: number;
  /** The payload fetch a user asked for, at most one at a time. Absent until one starts. */
  readonly payload: ArtifactPayloadReading | undefined;
  /**
   * Which rows have a manifest re-read on the wire, so their control holds.
   *
   * A set, because two rows re-reading at once are two independent calls.
   */
  readonly manifestReadInFlightArtifactIds: ReadonlySet<string>;
}

/**
 * How one manifest re-read settled.
 *
 * `superseded` is a re-read whose answer changed nothing on screen and never will: the
 * reader was disposed under it, or a refresh had already re-read the row it was about.
 */
export type ArtifactRowActOutcome =
  | { readonly status: "settled" }
  | { readonly status: "superseded" };

/** One shared empty set, so a reading nobody has acted on keeps a stable identity. */
const NO_ACTS_IN_FLIGHT: ReadonlySet<string> = new Set();

/** Before the first read answers. `loading` is a different claim from an empty list. */
export const NOTHING_READ_YET: ArtifactPaneReading = {
  artifacts: { kind: "loading" },
  readAtMilliseconds: UNREAD_AT_MILLISECONDS,
  payload: undefined,
  manifestReadInFlightArtifactIds: NO_ACTS_IN_FLIGHT,
};

/**
 * The listed rows with one replaced by a fresher read of the same artifact.
 *
 * A row the current list no longer holds is left out rather than re-added: putting a row
 * back on the strength of a single-artifact read would claim a place in the list no list
 * read established.
 */
export function withReplacedRow(
  artifacts: ArtifactsPanelState,
  row: ArtifactManifestRow,
): ArtifactsPanelState {
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
 * Releasing a row that is not held answers the same set, so a release with nothing to
 * release does not mint an identity a subscriber reads as a change.
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
 * `payload` and the in-flight set survive: they belong to acts this read did not start,
 * and a row whose re-read is still on the wire is still holding its control.
 */
export function settledReadReading(
  previous: ArtifactPaneReading,
  artifacts: ArtifactPaneReading["artifacts"],
): Omit<ArtifactPaneReading, "readAtMilliseconds"> {
  return {
    artifacts,
    payload: previous.payload,
    manifestReadInFlightArtifactIds: previous.manifestReadInFlightArtifactIds,
  };
}
