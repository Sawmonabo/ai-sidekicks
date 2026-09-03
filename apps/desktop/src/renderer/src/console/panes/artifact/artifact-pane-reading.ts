// What the artifact pane renders from, and the pure reductions over it.
//
// The seam against `artifact-reader.ts` is WHAT the pane knows against WHO asked for
// it. That file owns the calls, the scheduler, and the generation stamp; this one owns
// the immutable value those produce and every total function over it, so a reduction
// can be driven directly in a test with no bridge, no clock, and no reader at all.
//
// Nothing here reaches the port or the wire. `repos/artifact-model.ts` owns what a
// served manifest IS; this module owns how one reading becomes the next.

import { ATTACHMENT_BYTE_CAP_DEFAULT, refuse, type ConsoleRefusal } from "../../core/index.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachment-model.js";
import type {
  ArtifactDeleteReceipt,
  ArtifactManifestRow,
  ArtifactsPanelState,
} from "../../repos/artifact-model.js";
import type { ArtifactPayloadReading } from "./artifact-payload.js";

/**
 * The effective allow-list and byte cap, with where they came from.
 *
 * `source` is rendered rather than inferred. An operator override REPLACES the default
 * wholesale — `Spec-014 §Bounds (normative defaults; operator-tunable)` — so a hint that
 * could not say which of the two it is showing would be a hint a participant cannot
 * trust against a deployment they cannot see.
 */
export interface ArtifactAllowlistReading {
  readonly source: "effective" | "shipped-default";
  readonly mediaTypes: readonly string[];
  readonly maximumByteLength: number;
  /** Why the effective read did not answer, on the `shipped-default` arm. */
  readonly refusal: ConsoleRefusal | undefined;
}

/** Everything the pane renders from, in one immutable value. */
export interface ArtifactPaneReading {
  readonly artifacts: ArtifactsPanelState;
  readonly allowlist: ArtifactAllowlistReading;
  /**
   * What the last delete REPORTED, which is not the same as that it happened.
   *
   * On the reading rather than in the pane's `useState`, on `refusalByArtifactId`'s
   * rule: the fact is the daemon's and the reader is what learns it. Cleared by the
   * next list, because the receipt is about a row that list no longer holds and a
   * consequence left standing over a re-read would read as this read's own.
   */
  readonly lastDeleteReceipt: ArtifactDeleteReceipt | undefined;
  /** The payload fetch a participant asked for, at most one at a time. */
  readonly payload: ArtifactPayloadReading;
  /**
   * What the last act on a row answered, keyed by artifact id. Refusals only.
   *
   * Held on the reading rather than in the pane's own `useState`, because a served act
   * CHANGES the row it was about — the read replaces it, the delete removes it — and a
   * refusal kept in a second place would still be beside a row the reader has since
   * re-established.
   */
  readonly refusalByArtifactId: ReadonlyMap<string, ConsoleRefusal>;
}

/**
 * How one act on a row settled, for the sentence the pane announces.
 *
 * FOUR ARMS BECAUSE A LATE ANSWER SPLITS TWO WAYS, AND ONLY ONE OF THEM IS SILENT.
 *
 * `superseded` is an act whose answer changed nothing on screen and never will —
 * the reader was disposed under it, or the act itself was refused after a refresh
 * had already re-read the row it was about. Announcing a settlement for one of
 * those would report work the participant cannot see.
 *
 * `reconciling` is the other half, and it is NOT silent: the act was SERVED while a
 * refresh was in flight, so the fact it established holds — the reader applied it
 * and scheduled the read that re-establishes the rest. It is not `settled` because
 * the racing read may put the row back for the interval before that read lands, and
 * a reader cannot vouch for a screen it does not yet own.
 */
export type ArtifactRowActOutcome =
  | { readonly status: "settled" }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly status: "reconciling" }
  | { readonly status: "superseded" };

const NO_ROW_REFUSALS: ReadonlyMap<string, ConsoleRefusal> = new Map();

/** The bounds the console ships with, when the deployment's own could not be read. */
export const SHIPPED_DEFAULT_ALLOWLIST: ArtifactAllowlistReading = {
  source: "shipped-default",
  mediaTypes: ATTACHMENT_ALLOWLIST_DEFAULT,
  maximumByteLength: ATTACHMENT_BYTE_CAP_DEFAULT,
  refusal: undefined,
};

/** Before anyone asked. `not-checked` is a different claim from an empty list. */
export const NOTHING_READ_YET: ArtifactPaneReading = {
  artifacts: { kind: "not-checked" },
  allowlist: SHIPPED_DEFAULT_ALLOWLIST,
  lastDeleteReceipt: undefined,
  payload: { status: "not-checked" },
  refusalByArtifactId: NO_ROW_REFUSALS,
};

/** Which subsystem refused, when the refusal is the pane's own and not the port's. */
export const ARTIFACT_READER_REFUSAL_ORIGIN = "artifact-pane-reader";

/** The one code this pane mints. The port owns every other refusal it renders. */
export const ARTIFACT_READ_THREW_CODE = "read-threw";

/**
 * The refusal a read that threw becomes.
 *
 * A thrown value is not a refusal until something makes it one, and the alternative —
 * letting it reject inside a timer callback — leaves the pane on the in-flight absence
 * for the rest of its life. The message is carried; the thrown value is not.
 */
export function readFailureRefusal(error: unknown): ConsoleRefusal {
  const cause =
    error instanceof Error ? error.message : "the read threw a value that is not an error.";
  return refuse(
    ARTIFACT_READER_REFUSAL_ORIGIN,
    ARTIFACT_READ_THREW_CODE,
    `The artifact read failed before it could answer: ${cause}`,
  );
}

/**
 * The listed rows with one replaced by a fresher read of the same artifact.
 *
 * A row the current list no longer holds is left out rather than re-added: the list is
 * what the list read answered, and putting a row back on the strength of a
 * single-artifact read would claim a session membership no list established.
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

/**
 * The listed rows without the one a served delete removed.
 *
 * Reading the served reply rather than predicting it: the daemon answered, so the
 * manifest is gone and the row that stood for it goes with it. The re-read that
 * follows is what re-establishes the rest of the list.
 */
export function withoutRow(
  artifacts: ArtifactsPanelState,
  artifactId: string,
): ArtifactsPanelState {
  if (artifacts.kind !== "listed") {
    return artifacts;
  }
  return { kind: "listed", rows: artifacts.rows.filter((listed) => listed.id !== artifactId) };
}

/**
 * How a delete settled, with the receipt on the two arms the daemon served.
 *
 * `ArtifactRowActOutcome`'s four arms with the receipt added where one exists, rather
 * than a fifth arm or an optional member: the receipt is present on exactly the arms
 * that mean the daemon answered, so a caller narrowing on `status` has it without
 * asking whether it might be absent. Assignable to the shared type, so the pane's one
 * announcer still takes it.
 */
export type ArtifactDeleteOutcome =
  | { readonly status: "settled"; readonly receipt: ArtifactDeleteReceipt }
  | { readonly status: "reconciling"; readonly receipt: ArtifactDeleteReceipt }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly status: "superseded" };

/** The row refusals with one act's refusal recorded against its row. */
export function withRowRefusal(
  refusalByArtifactId: ReadonlyMap<string, ConsoleRefusal>,
  artifactId: string,
  refusal: ConsoleRefusal,
): ReadonlyMap<string, ConsoleRefusal> {
  const recorded = new Map(refusalByArtifactId);
  recorded.set(artifactId, refusal);
  return recorded;
}

/** The row refusals without the one an act has since answered for. */
export function withoutRowRefusal(
  refusalByArtifactId: ReadonlyMap<string, ConsoleRefusal>,
  artifactId: string,
): ReadonlyMap<string, ConsoleRefusal> {
  if (!refusalByArtifactId.has(artifactId)) {
    return refusalByArtifactId;
  }
  const remaining = new Map(refusalByArtifactId);
  remaining.delete(artifactId);
  return remaining;
}
