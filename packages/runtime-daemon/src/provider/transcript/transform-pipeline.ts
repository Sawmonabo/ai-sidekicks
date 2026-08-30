// The ordered transcript transform pipeline (Plan-005 Phase 3, T3.19).
//
// `Spec-005 §Canonical Transcript Export And Replay` states five steps and then
// states that their ORDER is the contract, with two named failure modes:
// repairing before stripping repairs pairs the strip then breaks, and mapping
// identity after rendering renders ids the map has not yet fixed. This module is
// built so both are observable rather than merely documented — the steps are
// individually exported and individually pure enough to compose, and a caller
// that composes them wrongly gets a wrong answer or a thrown error instead of a
// quietly different one. `TranscriptTransformPipeline` is the only thing that
// hard-codes the canonical order.
//
// Nothing here memoizes. A rendered transcript is a projection of a log that
// moves, so caching one hands a later caller a conversation the session no
// longer has (ADR-029).
//
// Spec coverage: `Spec-005 §Canonical Transcript Export And Replay` (steps 2-5);
// `Spec-005 §Pitfalls To Avoid` (no re-minted tool-call ids; no strip-after-repair;
// no cached render). Verifies invariant I-005-8.
//
// The never-re-mint rule binds the IDENTITY MAP absolutely: no call whose
// identifier is intact is ever given a different one, which is what makes an
// export-and-back round trip the identity function on ids. The pairing repair
// carries the single exception the rule cannot cover, because the rule's other
// half — that an identifier is never reused across two distinct calls — is
// already broken by the time the repair sees it: a transcript carrying two calls
// under one id cannot be exported as-is, and the repair disambiguates the later
// call rather than dropping it or shipping a pairing the target mis-attributes.
// It is declared as a repair, and it is the ONLY id this module mints.

import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
  DeclaredLossKind,
  DriverTranscriptExportResult,
} from "@ai-sidekicks/contracts";

import { DECLARED_LOSS_KINDS } from "@ai-sidekicks/contracts";

import type { OutboundFrameOrigin } from "../drivers/outbound-frame.js";

import { boundProjectionToPosition, type TranscriptExportBound } from "./canonical-transcript.js";

// --------------------------------------------------------------------------
// Tool-call identity
// --------------------------------------------------------------------------

/**
 * Derives the id the target provider will see from the canonical id. The default
 * is the identity function, which is what makes an export-and-back round trip
 * the identity function on ids; a driver whose provider constrains id syntax
 * supplies its own and the map still guarantees the mapping is bidirectional.
 */
export type TargetToolCallIdDerivation = (canonicalToolCallId: string) => string;

/** Thrown when a derivation would give two distinct canonical ids one target id. */
export class ToolCallIdentityCollisionError extends Error {
  readonly canonicalToolCallId: string;
  readonly conflictingCanonicalToolCallId: string;
  readonly targetToolCallId: string;

  constructor(
    canonicalToolCallId: string,
    conflictingCanonicalToolCallId: string,
    targetToolCallId: string,
  ) {
    super(
      `Two distinct tool calls would share one target identifier: refusing to reuse "${targetToolCallId}".`,
    );
    this.name = "ToolCallIdentityCollisionError";
    this.canonicalToolCallId = canonicalToolCallId;
    this.conflictingCanonicalToolCallId = conflictingCanonicalToolCallId;
    this.targetToolCallId = targetToolCallId;
  }
}

/** Thrown when a render reaches a tool call the identity map never bound. */
export class UnmappedToolCallIdentityError extends Error {
  readonly canonicalToolCallId: string;

  constructor(canonicalToolCallId: string) {
    super(
      `No target identifier is bound for tool call "${canonicalToolCallId}"; identity must be mapped before frames are rendered.`,
    );
    this.name = "UnmappedToolCallIdentityError";
    this.canonicalToolCallId = canonicalToolCallId;
  }
}

/**
 * The stable, bidirectional canonical-to-target tool-call identity mapping.
 *
 * Encapsulated rather than a bare `Map` pair because the two directions must
 * never disagree and the never-re-mint rule is enforced at the binding, not at
 * the call site: `bind` is idempotent for a canonical id it already holds, so a
 * second pass over the same transcript cannot mint a second identity, and it
 * refuses outright to hand one target id to two canonical ids.
 */
export class ToolCallIdentityMap {
  readonly #deriveTargetId: TargetToolCallIdDerivation;
  readonly #targetIdByCanonicalId: Map<string, string> = new Map<string, string>();
  readonly #canonicalIdByTargetId: Map<string, string> = new Map<string, string>();

  constructor(deriveTargetId: TargetToolCallIdDerivation = (canonicalId) => canonicalId) {
    this.#deriveTargetId = deriveTargetId;
  }

  /** Bind (or return the existing binding for) one canonical tool-call id. */
  bind(canonicalToolCallId: string): string {
    const alreadyBound: string | undefined = this.#targetIdByCanonicalId.get(canonicalToolCallId);
    if (alreadyBound !== undefined) {
      return alreadyBound;
    }

    const targetToolCallId: string = this.#deriveTargetId(canonicalToolCallId);
    const conflicting: string | undefined = this.#canonicalIdByTargetId.get(targetToolCallId);
    if (conflicting !== undefined) {
      throw new ToolCallIdentityCollisionError(canonicalToolCallId, conflicting, targetToolCallId);
    }

    this.#targetIdByCanonicalId.set(canonicalToolCallId, targetToolCallId);
    this.#canonicalIdByTargetId.set(targetToolCallId, canonicalToolCallId);
    return targetToolCallId;
  }

  /**
   * The target id for an ALREADY-bound canonical id. Throws rather than binding
   * on demand: a lazily-bound lookup here would make a render that ran before
   * the identity step succeed with ids nothing else agrees about, which is
   * exactly the reordering the step sequence forbids.
   */
  targetIdFor(canonicalToolCallId: string): string {
    const targetToolCallId: string | undefined =
      this.#targetIdByCanonicalId.get(canonicalToolCallId);
    if (targetToolCallId === undefined) {
      throw new UnmappedToolCallIdentityError(canonicalToolCallId);
    }
    return targetToolCallId;
  }

  /** The canonical id a target id came from — the reverse direction. */
  canonicalIdFor(targetToolCallId: string): string | undefined {
    return this.#canonicalIdByTargetId.get(targetToolCallId);
  }

  /** How many calls are bound. */
  get size(): number {
    return this.#targetIdByCanonicalId.size;
  }
}

// --------------------------------------------------------------------------
// Rendered frames
// --------------------------------------------------------------------------

/**
 * The frame-origin discriminator, which is the provider-bound text-neutrality
 * seam's own closed set rather than a second copy of it.
 *
 * Kept as a named alias because this module's render reads in its own vocabulary
 * — a rendered frame's origin — while the values must stay the ONE set the
 * neutralization boundary keys on. Two independent spellings of a fail-closed
 * discriminator would drift into an arm that neutralizes on one side and does
 * not on the other, which is exactly the failure the closed set exists to
 * prevent.
 */
export type RenderedFrameOrigin = OutboundFrameOrigin;

/**
 * One provider-neutral outbound frame. Drivers map these into their own target
 * shapes; the pipeline owns ordering, identity, and loss, not wire encoding.
 *
 * `origin` is present for a replayed PARTICIPANT turn, which the spec classifies
 * explicitly. It is deliberately ABSENT for prior assistant and tool turns: the
 * discriminator classifies turns on the provider's text-input channel, seeded
 * history is not one, and the discriminator's own fail-closed arm already rules
 * that an absent origin neutralizes — so leaving it absent takes the safe arm
 * instead of inventing a fourth classification for a frame the closed set does
 * not describe.
 */
export interface RenderedTranscriptFrame {
  readonly position: number;
  readonly role: CanonicalTranscriptTurn["role"];
  readonly origin?: RenderedFrameOrigin | undefined;
  readonly segments: readonly CanonicalTranscriptSegment[];
}

// --------------------------------------------------------------------------
// Pipeline state and steps
// --------------------------------------------------------------------------

/** What each step reads and rewrites. */
export interface TranscriptPipelineState {
  readonly projection: CanonicalTranscriptProjection;
  readonly turns: readonly CanonicalTranscriptTurn[];
  readonly identityMap: ToolCallIdentityMap;
  readonly declaredLosses: readonly DeclaredLossKind[];
  readonly frames: readonly RenderedTranscriptFrame[];
}

export type TranscriptPipelineStep = (state: TranscriptPipelineState) => TranscriptPipelineState;

/** The step names, in canonical order. */
export const CANONICAL_TRANSCRIPT_PIPELINE_STEP_NAMES: readonly string[] = [
  "fold",
  "map-identity",
  "strip-non-portable",
  "repair-pairing",
  "render",
];

/**
 * The text a repaired tool result carries where the call was simply never
 * answered. Fixed rather than composed per call so a target reading two such
 * results cannot infer a difference that is not there, and so a test can assert
 * the repair by value.
 */
export const SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT: string =
  "This tool call produced no result: the turn ended before one was recorded.";

/**
 * The text a repaired tool result carries where the call reused an identifier an
 * earlier call already owns.
 *
 * A SECOND fixed text rather than a reuse of the one above, for the reason that
 * one argues for a fixed text at all: the two repairs have genuinely different
 * causes, and saying the turn ended would be a fabricated one. Both are fixed, so
 * neither invents a per-call distinction.
 */
export const SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT: string =
  "This tool call produced no result: it reused an identifier an earlier call already holds.";

/**
 * What a disambiguated identifier is built from. Deliberately readable rather
 * than opaque: a person reading the target conversation should be able to see
 * that the id was repaired and which id it was repaired away from.
 */
const REPAIRED_TOOL_CALL_ID_INFIX = "-repaired-";

/** Build the state a pipeline run starts from. */
export function createTranscriptPipelineState(
  projection: CanonicalTranscriptProjection,
  identityMap: ToolCallIdentityMap = new ToolCallIdentityMap(),
): TranscriptPipelineState {
  return {
    projection,
    // Starts EMPTY rather than pre-seated: step 1 is a real step, so a
    // composition that skips it produces nothing rather than quietly working.
    turns: [],
    identityMap,
    declaredLosses: [],
    frames: [],
  };
}

/**
 * True when a segment stands in for a body the fold could not read. Exported
 * because three surfaces must agree on the predicate: the loss declaration
 * below, the memo's prose rendering, and the memo's identity key — a surface
 * that disagreed would either hide the gap or key two different transcripts the
 * same way.
 */
export function segmentContentIsUnavailable(segment: CanonicalTranscriptSegment): boolean {
  return segment.kind !== "reasoning" && segment.contentUnavailable === true;
}

/**
 * Step 1 — seat the folded turns the projection carries, declaring the loss for
 * any body the fold could not read.
 *
 * Declared HERE rather than in either caller because this is the only step both
 * the export pipeline and the memo floor run, so a projection built over an
 * unavailable body cannot reach a consumer that reads the empty list as the
 * positive claim that nothing was dropped.
 */
export const foldTurns: TranscriptPipelineStep = (state) => {
  const carriesUnavailableContent: boolean = state.projection.turns.some((turn) =>
    turn.segments.some(segmentContentIsUnavailable),
  );

  return {
    ...state,
    turns: state.projection.turns,
    declaredLosses: carriesUnavailableContent
      ? orderDeclaredLosses([...state.declaredLosses, "turn_content_unavailable"])
      : state.declaredLosses,
  };
};

/**
 * Step 2 — bind every tool call's identity, in log order.
 *
 * The map is the one deliberately stateful collaborator in the pipeline, so this
 * step mutates it rather than returning a new one: steps 2 and 5 must consult the
 * SAME map, and threading a replacement through the state would let a caller
 * swap it between them.
 */
export const mapToolCallIdentity: TranscriptPipelineStep = (state) => {
  for (const turn of state.turns) {
    for (const segment of turn.segments) {
      if (segment.kind === "tool_call") {
        state.identityMap.bind(segment.toolCallId);
      }
    }
  }
  return state;
};

/** Shared empty lookup for a turn that stripped no private block. */
const EMPTY_BLOCK_ID_SET: ReadonlySet<string> = new Set<string>();

/**
 * Step 3 — strip what is not portable, recording each stripped class.
 *
 * Keyed on `disclosure`, never on a reasoning-kind name: a filter matching one
 * kind leaves that kind's redacted sibling behind, and the multi-turn protocol
 * then breaks on a block nobody classified. Visible summaries are already
 * canonical, so they carry forward as plain text and cost no declared loss.
 */
export const stripNonPortableContent: TranscriptPipelineStep = (state) => {
  const declaredLosses: DeclaredLossKind[] = [...state.declaredLosses];

  // Two passes, because a result carried INSIDE a private block may be rendered
  // before that block in segment order and must still go with it.
  //
  // Scoped PER TURN, and that scope is the whole point of the map. A block id is
  // unique only within the exchange that minted it — providers restart their
  // block numbering freely — so a flat set makes one turn's private id censor an
  // unrelated visible turn's real tool result, which step 4 then repairs into a
  // synthetic failure the provider never produced. Keyed by the turn's ARRAY
  // INDEX rather than by `turn.position`, which is a data value a malformed
  // projection can repeat; the index is structural and both passes walk the same
  // array in the same order, so both compute it identically.
  //
  // The turn is the right occurrence boundary because it is where enclosure is
  // real: the fold coalesces consecutive assistant rows into one turn and closes
  // that turn at a turn marker or a participant message, either of which means
  // the provider exchange ended. A block cited across that boundary was not
  // carrying the result. Such a result therefore survives as provider output,
  // while the private block itself is stripped regardless of turn — reasoning
  // never leaks, only tool output outlives a cross-turn citation.
  const strippedBlockIdsByTurnIndex: Map<number, Set<string>> = new Map<number, Set<string>>();

  state.turns.forEach((turn, turnIndex) => {
    for (const segment of turn.segments) {
      if (segment.kind === "reasoning" && segment.disclosure === "private") {
        const idsForTurn: Set<string> =
          strippedBlockIdsByTurnIndex.get(turnIndex) ?? new Set<string>();
        idsForTurn.add(segment.blockId);
        strippedBlockIdsByTurnIndex.set(turnIndex, idsForTurn);
      }
    }
  });

  const strippedTurns: CanonicalTranscriptTurn[] = [];
  let recordedPrivateReasoningLoss = false;
  let recordedUnknownEnclosureLoss = false;

  state.turns.forEach((turn, turnIndex) => {
    const strippedBlockIdsInTurn: ReadonlySet<string> =
      strippedBlockIdsByTurnIndex.get(turnIndex) ?? EMPTY_BLOCK_ID_SET;
    const keptSegments: CanonicalTranscriptSegment[] = [];
    for (const segment of turn.segments) {
      if (segment.kind === "reasoning") {
        if (segment.disclosure === "private") {
          recordedPrivateReasoningLoss = true;
          continue;
        }
        keptSegments.push({ kind: "text", position: segment.position, text: segment.text });
        continue;
      }
      if (segment.kind === "text" && segment.withheldEnclosure === "private") {
        // The settle's stand-in for an id-less legacy result whose enclosing
        // block resolved `private` — the carrier that survives a positional
        // bound after the bound has cut the private block itself away. Dropped
        // here for the same reason the keyed arm below drops its result, and
        // declaring the same loss: the body went with the block that carried
        // it. The dedup boolean makes the unbounded case — where the private
        // block ALSO survives to this step and declares this same kind —
        // declare once, not twice.
        recordedPrivateReasoningLoss = true;
        continue;
      }
      if (segment.kind === "tool_result" && segment.enclosingReasoningBlockId !== undefined) {
        if (
          segment.enclosureDisclosure === "private" ||
          strippedBlockIdsInTurn.has(segment.enclosingReasoningBlockId)
        ) {
          // The result goes with the block that carried it. Its CALL survives —
          // that asymmetry is what step 4 exists to answer.
          //
          // Two sources, and the second is not redundant. The fold's stamp is the
          // one that survives a positional bound, which can cut away the private
          // reasoning segment while keeping the result it enclosed. The in-turn
          // set is the FLOOR for a projection assembled by anything that does not
          // stamp: without it a producer that forgets the stamp fails open, and
          // failing open here means exporting private reasoning.
          recordedPrivateReasoningLoss = true;
          continue;
        }
        if (segment.enclosureDisclosure === "unknown") {
          // The enclosure could not be established portable. Withheld on exactly
          // the reasoning of the private arm, with the one honest difference:
          // this is not a claim the content WAS private, so it does not declare
          // the private-reasoning loss. It declares the unavailability that
          // caused it, which is also what the fold declares over the unreadable
          // row itself when a bound has not cut that row away.
          recordedUnknownEnclosureLoss = true;
          continue;
        }
      }
      keptSegments.push(segment);
    }
    if (keptSegments.length > 0) {
      strippedTurns.push({ position: turn.position, role: turn.role, segments: keptSegments });
    }
  });

  if (recordedPrivateReasoningLoss) {
    declaredLosses.push("provider_private_reasoning");
  }
  if (recordedUnknownEnclosureLoss) {
    // Declared by THIS step rather than left to step 1, which sees the unreadable
    // reasoning marker only when a bound has not cut it away. A withheld result
    // that declared nothing would read to every consumer as a transcript that
    // dropped nothing.
    declaredLosses.push("turn_content_unavailable");
  }

  return { ...state, turns: strippedTurns, declaredLosses: orderDeclaredLosses(declaredLosses) };
};

/**
 * Step 4 — repair pairing integrity, strictly after the strip.
 *
 * Pairing is POSITIONAL, not set membership. A result that precedes its own call
 * is as structurally invalid to the target as an unpaired one, and a
 * presence-only check reports it as no loss at all: both ids are present, so the
 * two global sets agree and the step declares nothing. The scan below walks the
 * turns in order and asks where each id was called, so "paired" can only mean
 * "resolved after it was called".
 *
 * The property this step delivers is stronger than "every call is answered": the
 * exported calls carry DISTINCT identifiers and each is answered exactly once.
 * A one-to-many or many-to-one pairing is not something a target reconciles, it
 * is something a target mis-attributes or rejects, so neither shape may leave
 * here.
 *
 * Five repairs, all declared:
 *
 *   - An unpaired call takes a synthetic error result immediately after itself
 *     and is NEVER dropped: the target's injection surface performs no pairing
 *     validation, so an unpaired call is accepted silently and every later
 *     request against that session is then rejected.
 *   - A result that precedes its call is RE-HOMED to sit directly after it,
 *     which preserves the provider's own outcome rather than discarding it for a
 *     synthetic that asserts a failure that did not happen.
 *   - A result whose call is absent entirely is removed — there is nothing to
 *     pair it to, and injecting it would assert a call that never happened.
 *   - Of two or more results under ONE identifier, the first-positioned one is
 *     retained and the rest are removed. A provider answers a call once; a later
 *     result under the same id is malformation, and keeping both would export
 *     the one-to-many pairing this step exists to prevent.
 *   - A call reusing an identifier an EARLIER call already owns is given a
 *     disambiguated identifier of its own, derived from its position, and a
 *     synthetic error result under that new identifier. It never shares the
 *     owner's result. This is the one place the pipeline mints an identifier at
 *     all — the never-re-mint rule governs calls whose identity is intact, and
 *     an identifier already carried by two distinct calls is not intact: the
 *     alternatives are dropping a call the provider made, or exporting two calls
 *     the target cannot tell apart. Its arguments are carried through unchanged,
 *     so the content is preserved and only the identifier moves.
 */
export const repairPairingIntegrity: TranscriptPipelineStep = (state) => {
  // Flat segment ordinals across the whole transcript, so "before" and "after"
  // are answerable across a turn boundary — which is where a provider's own
  // out-of-order emission lands them.
  const ownerCallOrdinalByToolCallId: Map<string, number> = new Map<string, number>();
  const reusedToolCallIds: Set<string> = new Set<string>();
  const retainedResultOrdinalByToolCallId: Map<string, number> = new Map<string, number>();
  const retainedResultByToolCallId: Map<string, CanonicalTranscriptSegment> = new Map<
    string,
    CanonicalTranscriptSegment
  >();
  // Every identifier the transcript already spends, so a disambiguated one
  // cannot land on top of a call the provider itself made.
  const identifiersInUse: Set<string> = new Set<string>();
  let scanOrdinal = 0;

  for (const turn of state.turns) {
    for (const segment of turn.segments) {
      if (segment.kind === "tool_call") {
        identifiersInUse.add(segment.toolCallId);
        if (ownerCallOrdinalByToolCallId.has(segment.toolCallId)) {
          reusedToolCallIds.add(segment.toolCallId);
        } else {
          ownerCallOrdinalByToolCallId.set(segment.toolCallId, scanOrdinal);
        }
      } else if (segment.kind === "tool_result") {
        identifiersInUse.add(segment.toolCallId);
        if (!retainedResultOrdinalByToolCallId.has(segment.toolCallId)) {
          retainedResultOrdinalByToolCallId.set(segment.toolCallId, scanOrdinal);
          retainedResultByToolCallId.set(segment.toolCallId, segment);
        }
      }
      scanOrdinal += 1;
    }
  }

  let repaired = false;
  const repairedTurns: CanonicalTranscriptTurn[] = [];
  // The retained result of a call that stands before it, keyed by that call. At
  // most one per identifier, because only one result per identifier survives.
  const resultAwaitingItsCall: Map<string, CanonicalTranscriptSegment> = new Map<
    string,
    CanonicalTranscriptSegment
  >();
  // Results already emitted beside their owner call, by their own ordinal, so the
  // walk skips them when it reaches where they used to sit.
  const alreadyEmittedResultOrdinals: Set<number> = new Set<number>();
  let emitOrdinal = 0;

  for (const turn of state.turns) {
    const segments: CanonicalTranscriptSegment[] = [];
    for (const segment of turn.segments) {
      const currentOrdinal: number = emitOrdinal;
      emitOrdinal += 1;

      if (segment.kind === "tool_result") {
        const callOrdinal: number | undefined = ownerCallOrdinalByToolCallId.get(
          segment.toolCallId,
        );
        if (callOrdinal === undefined) {
          repaired = true;
          continue;
        }
        if (retainedResultOrdinalByToolCallId.get(segment.toolCallId) !== currentOrdinal) {
          // A second answer to a call already answered.
          repaired = true;
          continue;
        }
        if (alreadyEmittedResultOrdinals.has(currentOrdinal)) {
          continue;
        }
        if (currentOrdinal < callOrdinal) {
          repaired = true;
          resultAwaitingItsCall.set(segment.toolCallId, segment);
          continue;
        }
        segments.push(segment);
        continue;
      }

      if (segment.kind !== "tool_call") {
        segments.push(segment);
        continue;
      }

      if (ownerCallOrdinalByToolCallId.get(segment.toolCallId) !== currentOrdinal) {
        // A distinct call reusing an identifier the owner above already holds.
        // It takes an identifier of its own and its own synthetic result, so no
        // two exported calls answer to one id and no call shares another's
        // outcome.
        repaired = true;
        const disambiguatedToolCallId: string = mintDisambiguatedToolCallId(
          segment.toolCallId,
          currentOrdinal,
          identifiersInUse,
        );
        identifiersInUse.add(disambiguatedToolCallId);
        // The render rewrites every id through the map, so an identifier minted
        // after step 2 has to be bound here or the render would throw on a call
        // this step itself created.
        state.identityMap.bind(disambiguatedToolCallId);
        segments.push({ ...segment, toolCallId: disambiguatedToolCallId });
        segments.push({
          kind: "tool_result",
          // A minted answer stands in at the point its call awaited one, so it
          // takes the CALL's position rather than a position of its own — the
          // only honest value, since no logged event contributed it. It can
          // never postdate a bound: the bound is applied before step 1, so the
          // call it copies was already inside.
          position: segment.position,
          toolCallId: disambiguatedToolCallId,
          outcome: "failed",
          provenance: "repaired",
          text: SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT,
        });
        continue;
      }

      segments.push(segment);

      const stashed: CanonicalTranscriptSegment | undefined = resultAwaitingItsCall.get(
        segment.toolCallId,
      );
      if (stashed !== undefined) {
        // Stashed on the way here, so re-homing it now lands it directly after
        // the call it answers.
        segments.push(stashed);
        resultAwaitingItsCall.delete(segment.toolCallId);
        continue;
      }

      const retainedResultOrdinal: number | undefined = retainedResultOrdinalByToolCallId.get(
        segment.toolCallId,
      );
      if (retainedResultOrdinal === undefined) {
        repaired = true;
        segments.push({
          kind: "tool_result",
          // The minted-answer rule above: the orphaned call's own position.
          position: segment.position,
          toolCallId: segment.toolCallId,
          outcome: "failed",
          provenance: "repaired",
          text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
        });
        continue;
      }

      const retainedResult: CanonicalTranscriptSegment | undefined = retainedResultByToolCallId.get(
        segment.toolCallId,
      );
      if (reusedToolCallIds.has(segment.toolCallId) && retainedResult !== undefined) {
        // A reused identifier puts a SECOND call between this one and its answer,
        // so the answer is pulled up to sit directly after the call it belongs
        // to. Without it a target that pairs a call with the result following it
        // would read the duplicate's synthetic failure as this call's outcome.
        repaired = true;
        segments.push(retainedResult);
        alreadyEmittedResultOrdinals.add(retainedResultOrdinal);
      }
    }
    if (segments.length > 0) {
      repairedTurns.push({ position: turn.position, role: turn.role, segments });
    }
  }

  const declaredLosses: DeclaredLossKind[] = [...state.declaredLosses];
  if (repaired) {
    declaredLosses.push("tool_call_history_repaired");
  }

  return { ...state, turns: repairedTurns, declaredLosses: orderDeclaredLosses(declaredLosses) };
};

/**
 * A distinct identifier for a call whose own was already taken, derived from the
 * call's POSITION in the transcript rather than from a counter or a random value:
 * two exports of one transcript must produce the same identifier, or a target
 * that saw the first export cannot recognize the second.
 *
 * The suffix loop is not decoration — a provider is free to have already used the
 * composed name, and a "repair" that collided with a real call would recreate the
 * defect it exists to remove.
 */
function mintDisambiguatedToolCallId(
  reusedToolCallId: string,
  segmentOrdinal: number,
  identifiersInUse: ReadonlySet<string>,
): string {
  const stem = `${reusedToolCallId}${REPAIRED_TOOL_CALL_ID_INFIX}${segmentOrdinal.toString()}`;
  let candidate: string = stem;
  let attempt = 0;
  while (identifiersInUse.has(candidate)) {
    attempt += 1;
    candidate = `${stem}-${attempt.toString()}`;
  }
  return candidate;
}

/**
 * Step 5 — render the turns into provider-neutral outbound frames, rewriting
 * every tool-call id through the identity map. The rewrite is a LOOKUP, so a
 * render that ran before the identity step throws instead of minting ids.
 */
export const renderTargetFrames: TranscriptPipelineStep = (state) => {
  const frames: RenderedTranscriptFrame[] = state.turns.map((turn): RenderedTranscriptFrame => {
    const segments: CanonicalTranscriptSegment[] = turn.segments.map((segment) => {
      if (segment.kind === "tool_call") {
        return { ...segment, toolCallId: state.identityMap.targetIdFor(segment.toolCallId) };
      }
      if (segment.kind === "tool_result") {
        return { ...segment, toolCallId: state.identityMap.targetIdFor(segment.toolCallId) };
      }
      return segment;
    });
    return turn.role === "participant"
      ? { position: turn.position, role: turn.role, origin: "participant_text", segments }
      : { position: turn.position, role: turn.role, segments };
  });

  return { ...state, frames };
};

/**
 * The canonical order. Exported so a test can assert the sequence directly rather
 * than inferring it from the runner's behavior.
 */
export const CANONICAL_TRANSCRIPT_PIPELINE: readonly TranscriptPipelineStep[] = [
  foldTurns,
  mapToolCallIdentity,
  stripNonPortableContent,
  repairPairingIntegrity,
  renderTargetFrames,
];

// --------------------------------------------------------------------------
// The export boundary
// --------------------------------------------------------------------------

// Re-exported from the fold rather than declared here.
//
// The bound now belongs to `canonical-transcript.ts`, which applies it to its own
// output as the LAST thing it does, and this pipeline receives an already-bounded
// projection from a bounded fold. Declaring it here would put the definition
// downstream of its primary applier and force the fold to import from the
// pipeline it feeds — the wrong direction. Re-exported so every existing importer
// and this module's own `exportTranscript` signature keep one name for one
// concept: a caller holding an unbounded projection still bounds it here, and it
// is the same function the fold ran.
export type { TranscriptExportBound };
export { boundProjectionToPosition };

// --------------------------------------------------------------------------
// The runner
// --------------------------------------------------------------------------

/**
 * Runs the five steps in canonical order and nothing else. A class rather than a
 * bare function because it owns the per-export identity map's lifetime: one map
 * per export, so an export cannot inherit bindings from an unrelated transcript,
 * and the derivation is injected once rather than passed at every call.
 */
export class TranscriptTransformPipeline {
  readonly #deriveTargetToolCallId: TargetToolCallIdDerivation | undefined;

  constructor(deriveTargetToolCallId?: TargetToolCallIdDerivation) {
    this.#deriveTargetToolCallId = deriveTargetToolCallId;
  }

  /**
   * Export one canonical transcript, optionally bounded.
   *
   * Called twice on the same projection and the same bound this returns equal
   * frames and equal ids — the derivation is deterministic and nothing is
   * carried between calls.
   *
   * `bound` is the inclusive position the export may carry up to, in the
   * projection's own position vocabulary, or the explicit `"unbounded"` arm —
   * required, so no caller can export the whole conversation by forgetting to
   * forward the bound it holds. See {@link boundProjectionToPosition} for why
   * it is applied ahead of the first step rather than to the rendered frames.
   */
  exportTranscript(
    projection: CanonicalTranscriptProjection,
    bound: TranscriptExportBound,
  ): DriverTranscriptExportResult {
    const identityMap: ToolCallIdentityMap =
      this.#deriveTargetToolCallId === undefined
        ? new ToolCallIdentityMap()
        : new ToolCallIdentityMap(this.#deriveTargetToolCallId);

    let state: TranscriptPipelineState = createTranscriptPipelineState(
      boundProjectionToPosition(projection, bound),
      identityMap,
    );
    for (const step of CANONICAL_TRANSCRIPT_PIPELINE) {
      state = step(state);
    }

    return {
      frames: [...state.frames],
      declaredLosses: [...state.declaredLosses],
    };
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Deduplicate and order the declared-loss list by the contract's own enumeration
 * order, so two runs of the same transcript declare their losses identically and
 * a consumer may compare lists directly.
 */
function orderDeclaredLosses(losses: readonly DeclaredLossKind[]): readonly DeclaredLossKind[] {
  const present: Set<DeclaredLossKind> = new Set<DeclaredLossKind>(losses);
  return DECLARED_LOSS_KINDS.filter((kind) => present.has(kind));
}
