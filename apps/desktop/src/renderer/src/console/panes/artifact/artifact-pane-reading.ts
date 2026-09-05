// What the artifact pane renders from, and the pure reductions over it.
//
// The seam against `artifact-reader.ts` is WHAT the pane knows against WHO asked for
// it. That file owns the calls, the scheduler, and the generation stamp; this one owns
// the immutable value those produce and every total function over it, so a reduction
// can be driven directly in a test with no bridge, no clock, and no reader at all.
//
// Nothing here CALLS the port or the wire. `repos/artifact-model.ts` owns what a
// served manifest IS; this module owns how one reading becomes the next — and, since
// `growthAnswerReading` below, what one port ANSWER becomes before it gets there.
// Reading an answer is the same kind of total reduction as the rest of this file and
// belongs beside them, which is why the one port type it names travels through the
// bridge barrel rather than the two callers each carrying their own narrowing.

import type { GrowthUnavailable } from "../../bridge/index.js";
import {
  ATTACHMENT_BYTE_CAP_DEFAULT,
  isConsoleRefusal,
  normalizeWireRejection,
  refuse,
  type ConsoleRefusal,
  type WireRefusal,
} from "../../core/index.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachments/attachment-policy.js";
import type {
  ArtifactDeleteReceipt,
  ArtifactManifestRow,
  ArtifactsPanelState,
} from "../../repos/artifacts/artifact-model.js";
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
  allowlist: SHIPPED_DEFAULT_ALLOWLIST,
  lastDeleteReceipt: undefined,
  payload: { status: "not-checked" },
  manifestReadInFlightArtifactIds: NO_MANIFEST_READS_IN_FLIGHT,
  refusalByArtifactId: NO_ROW_REFUSALS,
};

/** Which subsystem refused, when the refusal is the pane's own and not the port's. */
export const ARTIFACT_READER_REFUSAL_ORIGIN = "artifact-pane-reader";

/**
 * The three codes this pane mints. The port owns every other refusal the pane renders.
 *
 * Declared here, beside the reading they are recorded on, rather than in either of
 * the two modules that raise them: a refusal vocabulary split across the reader and
 * the acts would be two closed sets for one pane, and a caller narrowing on a code
 * would have to know which half minted it.
 */
export const ARTIFACT_READ_THREW_CODE = "read-threw";

export const ARTIFACT_PAYLOAD_FETCH_IN_FLIGHT_CODE = "payload-fetch-in-flight";

export const ARTIFACT_MANIFEST_READ_IN_FLIGHT_CODE = "manifest-read-in-flight";

export const ARTIFACT_REPLY_UNREADABLE_CODE = "reply-unreadable";

/**
 * The refusal a read that threw becomes.
 *
 * A thrown value is not a refusal until something makes it one, and the alternative —
 * letting it reject inside a timer callback — leaves the pane on the in-flight absence
 * for the rest of its life.
 *
 * A DELEGATION, NOT A NORMALIZER, on `repos/repo-reads.ts:repoCallRefusal`'s shape.
 * The three-arm reading this replaces flattened everything to one code and one
 * sentence: a JSON-RPC envelope carrying `data.type` arrived as `read-threw` with the
 * daemon's dotted code and its own words discarded, a rate-limit envelope lost its
 * retry hint, a `ConsoleRefusal` thrown across the bridge lost the origin its author
 * named, and `error instanceof Error` answered false for an `Error` minted in the
 * preload realm — which is the realm every bridge rejection crosses — so that value
 * took the not-an-error arm and its message went with it. `core/wire-rejection.ts`
 * owns all four of those readings and a terminal that never throws, and the two
 * things left here are this pane's own: the origin, and the sentence for a rejection
 * that said nothing machine-readable.
 *
 * THE REJECTED VALUE IS NOT QUOTED INTO THE SENTENCE. It names the leg and stops
 * there — a rejection off the wire can carry participant content as readily as a
 * schema failure can, which is the rule `Spec-023 §Console Design (Meridian)` rule 9
 * sets and which the copy this replaces broke by interpolating the message into it.
 *
 * THE RETURN TYPE IS THE NORMALIZER'S OWN. `WireRefusal` is a `ConsoleRefusal`
 * widened by the optional retry hint a rate-limit envelope registers, so every
 * consumer that takes a refusal takes this unchanged — and narrowing it back to
 * `ConsoleRefusal` here would hide the one member this delegation exists to stop
 * dropping from the only reader that could offer the retry.
 */
export function readFailureRefusal(error: unknown): WireRefusal {
  return normalizeWireRejection(ARTIFACT_READER_REFUSAL_ORIGIN, error, {
    code: ARTIFACT_READ_THREW_CODE,
    detail: "The artifact read failed before it could answer.",
  });
}

/**
 * The refusal a second payload fetch becomes while the first is still on the wire.
 *
 * NAMED RATHER THAN SILENT, and it names the artifact the pane is actually waiting
 * on rather than the one that was pressed: a participant told "something is in
 * flight" cannot tell what. The control that produced it is held while a fetch is
 * pending, so this is structurally unreachable from the pane — and recorded anyway,
 * for `repos/proposal-gate-actions.ts`'s reason: a press that produced nothing at all
 * is the silent no-op rule 8 forbids.
 */
export function payloadFetchInFlightRefusal(pendingArtifactId: string): ConsoleRefusal {
  return refuse(
    ARTIFACT_READER_REFUSAL_ORIGIN,
    ARTIFACT_PAYLOAD_FETCH_IN_FLIGHT_CODE,
    `The payload of ${pendingArtifactId} has been asked for and the daemon has not answered yet. Nothing else is fetched until it settles.`,
  );
}

/**
 * The refusal a second manifest re-read becomes while this row's first is on the wire.
 *
 * NAMED RATHER THAN SILENT, on `payloadFetchInFlightRefusal`'s reason, and it names the
 * ROW: two presses on one row are two reads of one manifest whose answers can settle in
 * either order, so the older reply would put the staler row back. The control that
 * produced it is held while that row's read is pending, so this is structurally
 * unreachable from the panel — and recorded anyway, because a press that produced
 * nothing at all is the silent no-op rule 8 forbids.
 */
export function manifestReadInFlightRefusal(artifactId: string): ConsoleRefusal {
  return refuse(
    ARTIFACT_READER_REFUSAL_ORIGIN,
    ARTIFACT_MANIFEST_READ_IN_FLIGHT_CODE,
    `The manifest of ${artifactId} has been asked for again and the daemon has not answered yet. That row is read once until it settles.`,
  );
}

/**
 * One growth-port answer, in the two arms the port produces.
 *
 * The served arm is written out rather than imported because `GrowthOutcome` does not
 * leave the bridge barrel, and a view family reaching past that barrel is the deep
 * import the structure rules exist to prevent. `GrowthUnavailable` does leave it, so
 * the arm that carries a vocabulary is the port's own value and only the two-member
 * served arm is restated — and a served arm that lost `value` would fail to assign at
 * every call site rather than drifting quietly.
 *
 * Exported because the ACT half holds one of these across a `try`: a call that
 * REJECTS never produces an answer at all, and the module that turns the rejection
 * into a refusal has to name the type of the value it would otherwise have had.
 */
export type GrowthAnswer<TValue> =
  | { readonly status: "served"; readonly value: TValue }
  | GrowthUnavailable;

/**
 * What one growth-port answer said, or why nothing was read.
 *
 * `repos/repo-reads.ts`'s read-or-refusal shape, because it is the same question asked
 * of a different port: a second vocabulary for it would make a surface rendering both
 * translate between two shapes to reach one renderer, which is exactly what
 * `core/refusal.ts` exists to have stopped.
 */
export type GrowthAnswerReading<TValue> =
  | { readonly status: "read"; readonly value: TValue }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * Read one growth-port answer, by the shape the reply actually has.
 *
 * NARROWED ON THE REFUSAL, NOT ON ONE DISCRIMINANT VALUE'S ABSENCE. Every call site
 * in this pane used to ask `status === "unavailable"` and treat everything else as
 * served. That is not the same claim, and the difference is reachable: `core`'s bare
 * `refuse(...)` is a refusal WITHOUT the port's discriminant — `growthUnavailable`
 * builds its own by spreading exactly that value — so such a reply passed the test as
 * served and was then dereferenced for a `value` it does not carry. The pane published
 * `read-threw` carrying a `TypeError` sentence, which made a wire that is simply not
 * registered read as the console breaking, and buried the refusal that said so.
 *
 * MOST SPECIFIC FIRST, which is `core/wire-rejection.ts`'s own arm ordering: a reply
 * that already IS the console's one refusal shape is one, and
 * `GrowthUnavailable` extends that shape, so the port's own refusal and a bare
 * `refuse(...)` are recognised by the same test and neither reaches the value branch.
 * A served answer carries no `code`, `detail`, or `origin`, so it cannot be mistaken
 * for one in the other direction.
 *
 * TOTAL, because a reply that is neither is a fact rather than a crash. Rule 8 admits
 * no silent no-op, so the third arm is a refusal a person can read and paste, naming
 * the operation and never the reply — which may be participant content.
 */
export function growthAnswerReading<TValue>(
  operation: string,
  answer: GrowthAnswer<TValue>,
): GrowthAnswerReading<TValue> {
  if (isConsoleRefusal(answer)) {
    return { status: "refused", refusal: answer };
  }
  if (!carriesServedValue(answer)) {
    return {
      status: "refused",
      refusal: refuse(
        ARTIFACT_READER_REFUSAL_ORIGIN,
        ARTIFACT_REPLY_UNREADABLE_CODE,
        `${operation} answered with a shape that is neither a served value nor a refusal, so nothing was read.`,
      ),
    };
  }
  return { status: "read", value: answer.value };
}

/**
 * Whether an answer the types call served actually carries the member.
 *
 * The check the declared type cannot make: the fixture bridge is assembled behind a
 * cast, and the live port is one process boundary away, so what arrives is whatever
 * was sent. Presence rather than definedness — no operation on this pane serves an
 * absent value, and testing for `undefined` would refuse one that legitimately did.
 */
function carriesServedValue(answer: unknown): answer is { readonly value: unknown } {
  return typeof answer === "object" && answer !== null && "value" in answer;
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
