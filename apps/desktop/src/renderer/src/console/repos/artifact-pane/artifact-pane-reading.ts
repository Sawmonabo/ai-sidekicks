// What the artifact pane renders from, and the pure reductions over it.
//
// The seam against `artifact-reader.ts` is WHAT the pane knows against WHO asked for
// it. That file owns the calls, the scheduler, and the generation stamp; this one owns
// the immutable value those produce and every total function over it, so a reduction
// can be driven directly in a test with no bridge, no clock, and no reader at all.
//
// Nothing here CALLS the port or the wire. `repos/artifacts/artifact-model.ts` owns what a
// served manifest IS; this module owns how one reading becomes the next. What one port
// ANSWER becomes before it gets here is `repos/growth-call.ts`, at the family root: the
// proposal gate is a second caller of that reading, and a reduction two sub-modules
// share has no home inside either one.

import { ATTACHMENT_BYTE_CAP_DEFAULT, type ConsoleRefusal } from "../../core/index.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../attachments/attachment-policy.js";
import type {
  ArtifactDeleteReceipt,
  ArtifactManifestRow,
  ArtifactsPanelState,
} from "../artifacts/artifact-model.js";
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

/**
 * The instant a reading nobody has published yet carries.
 *
 * Reachable by nothing a participant sees: `NOTHING_READ_YET` draws no row, so no age
 * is rendered against it, and the reader stamps its own opening reading from the
 * window's clock at construction. Named rather than written as a bare `0` so the
 * declaration says which of the two it is — an instant nobody took, not midnight 1970.
 */
export const UNREAD_AT_MILLISECONDS = 0;

/** Everything the pane renders from, in one immutable value. */
export interface ArtifactPaneReading {
  readonly artifacts: ArtifactsPanelState;
  /**
   * The instant this reading was published at, taken from the window's own clock.
   *
   * ON THE READING, WHICH IS THE WHOLE POINT. `repos/mounts/repo-mounts-model.ts` states the
   * rule for this family and names the alternative as the defect: a card reading
   * `Date.now()` in its render body would move an age on any unrelated re-render, and
   * under the fixture it would move against wall time while the scenario advanced on
   * frozen time — so a screenshot listing a row pinned text that renders differently
   * next month. An age moves when the READ moves, and on no other occasion; an age
   * that advanced on a timer would be the interval poll the budget forbids, wearing a
   * clock face.
   *
   * Stamped by the reader's one publish rather than by each producer, so no path can
   * put a reading on screen carrying an instant from an earlier one.
   */
  readonly readAtMilliseconds: number;
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
   * Which rows have a manifest re-read on the wire, so their control holds.
   *
   * On the reading rather than in the panel's own `useState`, on `refusalByArtifactId`'s
   * rule: the acts are what know a call is outstanding, and a second copy of that fact
   * beside them would be a control held against a register nothing is checking. A SET
   * rather than one id, because the panel draws a list and two rows re-reading at once
   * are two independent calls on two independent rows.
   */
  readonly manifestReadInFlightArtifactIds: ReadonlySet<string>;
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

/** One shared empty set, so a reading nobody has acted on keeps a stable identity. */
const NO_MANIFEST_READS_IN_FLIGHT: ReadonlySet<string> = new Set();

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
  readAtMilliseconds: UNREAD_AT_MILLISECONDS,
  allowlist: SHIPPED_DEFAULT_ALLOWLIST,
  lastDeleteReceipt: undefined,
  payload: { status: "not-checked" },
  manifestReadInFlightArtifactIds: NO_MANIFEST_READS_IN_FLIGHT,
  refusalByArtifactId: NO_ROW_REFUSALS,
};

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

/** The in-flight set with one row's manifest re-read recorded as outstanding. */
export function withManifestReadInFlight(
  manifestReadInFlightArtifactIds: ReadonlySet<string>,
  artifactId: string,
): ReadonlySet<string> {
  const outstanding = new Set(manifestReadInFlightArtifactIds);
  outstanding.add(artifactId);
  return outstanding;
}

/** The in-flight set without the row whose manifest re-read has settled. */
export function withoutManifestReadInFlight(
  manifestReadInFlightArtifactIds: ReadonlySet<string>,
  artifactId: string,
): ReadonlySet<string> {
  if (!manifestReadInFlightArtifactIds.has(artifactId)) {
    return manifestReadInFlightArtifactIds;
  }
  const remaining = new Set(manifestReadInFlightArtifactIds);
  remaining.delete(artifactId);
  return remaining;
}

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

/**
 * What a settled read publishes: both legs, and what of the previous reading survives.
 *
 * ONE SNAPSHOT, BOTH LEGS. Publishing each leg as it lands would let a snapshot hold a
 * list from one refresh beside an allow-list from another, so the reader joins them and
 * calls this once. Which members carry forward is the decision this function exists to
 * hold in one place, and each is carried for its own reason rather than by a spread:
 *
 *   • `lastDeleteReceipt` is CLEARED BY THE LIST THAT FOLLOWS IT. The receipt is about a
 *     row this read has just answered for — by not returning it — so a consequence left
 *     standing would read as a fact about the list now on screen.
 *   • `payload` SURVIVES: it is about an artifact this read either returned or did not,
 *     and either way nothing here re-fetched bytes to answer for it.
 *   • `manifestReadInFlightArtifactIds` and `refusalByArtifactId` are THE ACTS' REGISTERS
 *     rather than this read's. A row whose re-read is still on the wire is still holding
 *     its control, and a publish that rebuilt the set would offer it back mid-flight; a
 *     refusal records an ACT that did not happen, and a read that did not re-attempt the
 *     act does not answer for it.
 */
export function settledReadReading(
  previous: ArtifactPaneReading,
  artifacts: ArtifactPaneReading["artifacts"],
  allowlist: ArtifactAllowlistReading,
): Omit<ArtifactPaneReading, "readAtMilliseconds"> {
  return {
    artifacts,
    allowlist,
    lastDeleteReceipt: undefined,
    payload: previous.payload,
    manifestReadInFlightArtifactIds: previous.manifestReadInFlightArtifactIds,
    refusalByArtifactId: previous.refusalByArtifactId,
  };
}
