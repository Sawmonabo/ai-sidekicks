// The ordered transcript transform steps: fold, strip non-portable content, repair pairing. The
// order is the contract: repairing before stripping repairs pairs the strip then breaks. The steps
// are exported individually, and a caller that composes them wrongly gets a wrong answer, not a
// quietly different one. `transformTranscript` is the only place that hard-codes the order.
//
// A transformed transcript is a projection of a log that moves, so it is never cached.
//
// The pairing repair is the one place this module mints an id: a transcript with two calls under
// one id cannot be carried as-is, so the repair disambiguates the later call instead of dropping
// it, and declares that it did.

import type { DeclaredLossKind } from "@ai-sidekicks/contracts";

import { DECLARED_LOSS_KINDS } from "@ai-sidekicks/contracts";

import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
} from "../provider-driver.js";

// --------------------------------------------------------------------------
// Pipeline state and steps
// --------------------------------------------------------------------------

/** What each step reads and rewrites. */
export interface TranscriptPipelineState {
  readonly projection: CanonicalTranscriptProjection;
  readonly turns: readonly CanonicalTranscriptTurn[];
  readonly declaredLosses: readonly DeclaredLossKind[];
}

/** One pipeline step: reads the state and returns the next one. */
export type TranscriptPipelineStep = (state: TranscriptPipelineState) => TranscriptPipelineState;

/**
 * The text a repaired tool result carries where the call was never answered. Fixed, so a target
 * cannot infer a difference between two such results and a test can assert the repair by value.
 */
export const SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT: string =
  "This tool call produced no result: the turn ended before one was recorded.";

/**
 * The text a repaired tool result carries where the call reused an id an earlier call owns. It
 * is separate from the interrupted text because the cause differs, and saying the turn ended
 * would be false.
 */
export const SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT: string =
  "This tool call produced no result: it reused an identifier an earlier call already holds.";

// Readable rather than opaque, so a person reading the target conversation can see the id was
// repaired and which id it came from.
const REPAIRED_TOOL_CALL_ID_INFIX = "-repaired-";

/** Build the state a pipeline run starts from. */
export function createTranscriptPipelineState(
  projection: CanonicalTranscriptProjection,
): TranscriptPipelineState {
  return {
    projection,
    // Empty, not pre-seated: a composition that skips the fold step yields nothing rather than
    // quietly working.
    turns: [],
    declaredLosses: [],
  };
}

/**
 * True when a segment stands in for a body the fold could not read. Exported because the loss
 * declaration here and the brief projection's prose rendering and identity key must agree on it.
 */
export function segmentContentIsUnavailable(segment: CanonicalTranscriptSegment): boolean {
  return segment.kind !== "reasoning" && segment.contentUnavailable === true;
}

/**
 * Step 1: seat the folded turns the projection carries, declaring the loss for any body the
 * fold could not read, so no consumer reads an empty loss list as "nothing was dropped".
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

/** Shared empty lookup for a turn that stripped no private block. */
const EMPTY_BLOCK_ID_SET: ReadonlySet<string> = new Set<string>();

/**
 * Step 2: strip what is not portable, recording each stripped class.
 *
 * Keyed on `disclosure`, never on a reasoning-kind name: a filter matching one kind leaves that
 * kind's redacted sibling behind and breaks the multi-turn protocol. Visible summaries carry
 * forward as plain text and declare no loss.
 */
export const stripNonPortableContent: TranscriptPipelineStep = (state) => {
  const declaredLosses: DeclaredLossKind[] = [...state.declaredLosses];

  // Two passes, because a result inside a private block may be rendered before that block in
  // segment order and must still go with it.
  //
  // The set of stripped block ids is scoped per turn. Providers restart block numbering, so a
  // flat set would let one turn's private id censor an unrelated turn's real tool result, which
  // step 3 would then repair into a failure the provider never produced. It is keyed by array
  // index, not `turn.position`, which a malformed projection can repeat.
  //
  // The turn is the enclosure boundary: the fold closes a turn at a turn marker or a user
  // message, which ends the provider exchange. A result cited by a block across that boundary
  // survives as provider output; the private block itself is stripped in every turn.
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
        // The stand-in for a result with no id whose enclosing block resolved private. It
        // survives a positional bound that cut the private block away, so it is dropped here
        // with the same loss. The boolean declares the loss once when the block also survives.
        recordedPrivateReasoningLoss = true;
        continue;
      }
      if (segment.kind === "tool_result" && segment.enclosingReasoningBlockId !== undefined) {
        if (
          segment.enclosureDisclosure === "private" ||
          strippedBlockIdsInTurn.has(segment.enclosingReasoningBlockId)
        ) {
          // The result goes with the block that carried it; its call survives, which step 3
          // answers. Two sources: the fold's stamp survives a positional bound that cuts the
          // private block; the in-turn set is the floor for a projection built by anything
          // that does not stamp, where failing open would carry private reasoning.
          recordedPrivateReasoningLoss = true;
          continue;
        }
        if (segment.enclosureDisclosure === "unknown") {
          // The enclosure could not be shown portable, so the result is withheld. This does
          // not claim the content was private, so it declares the unavailability instead.
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
    // Declared here because step 1 sees the unreadable marker only when a bound has not cut it
    // away, and a withheld result that declared nothing would read as "nothing dropped".
    declaredLosses.push("turn_content_unavailable");
  }

  return { ...state, turns: strippedTurns, declaredLosses: orderDeclaredLosses(declaredLosses) };
};

/**
 * Step 3: repair pairing integrity, strictly after the strip.
 *
 * Pairing is positional. A result that precedes its call is as unpaired as one with no call, and a
 * set-membership check would report it as no loss. Repaired calls carry distinct ids and each is
 * answered exactly once, because a reader mis-attributes any other shape. Every repair is
 * declared:
 *
 *   - An unpaired call takes a synthetic error result right after it and is never dropped.
 *   - A result that precedes its call is re-homed directly after it, keeping the provider's
 *     real outcome.
 *   - A result whose call is absent is removed; carrying it would assert a call that never
 *     happened.
 *   - Of several results under one id, the first-positioned one stays and the rest are removed.
 *   - A call reusing an id an earlier call owns gets a disambiguated id derived from its
 *     position, with a synthetic error result under the new id. Its arguments are unchanged.
 *     Dropping the call or carrying two indistinguishable calls are the alternatives.
 */
export const repairPairingIntegrity: TranscriptPipelineStep = (state) => {
  // Flat segment ordinals across the whole transcript, so "before" and "after" hold across a
  // turn boundary, where a provider's out-of-order emission lands them.
  const ownerCallOrdinalByToolCallId: Map<string, number> = new Map<string, number>();
  const reusedToolCallIds: Set<string> = new Set<string>();
  const retainedResultOrdinalByToolCallId: Map<string, number> = new Map<string, number>();
  const retainedResultByToolCallId: Map<string, CanonicalTranscriptSegment> = new Map<
    string,
    CanonicalTranscriptSegment
  >();
  // Every id the transcript already uses, so a disambiguated one cannot collide with a real call.
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
  // The retained result of a call that stands before it, keyed by that call.
  const resultAwaitingItsCall: Map<string, CanonicalTranscriptSegment> = new Map<
    string,
    CanonicalTranscriptSegment
  >();
  // Results already emitted beside their call, so the walk skips them where they used to sit.
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
        // A distinct call reusing the owner's id gets its own id and its own synthetic result.
        repaired = true;
        const disambiguatedToolCallId: string = mintDisambiguatedToolCallId(
          segment.toolCallId,
          currentOrdinal,
          identifiersInUse,
        );
        identifiersInUse.add(disambiguatedToolCallId);
        segments.push({ ...segment, toolCallId: disambiguatedToolCallId });
        segments.push({
          kind: "tool_result",
          // A minted answer takes its call's position: no logged event contributed it. It never
          // postdates a bound, since the bound is applied before step 1.
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
        // Stashed on the way here, so it lands directly after the call it answers.
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
        // A reused id puts a second call between this one and its answer. Pulling the answer up
        // stops a reader that pairs a call with the next result from reading the duplicate's
        // synthetic failure as this call's outcome.
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

// Derived from the call's position, not a counter or random value, so two runs over one
// transcript yield the same id. The suffix loop covers a provider that already used the name.
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

/** What the three steps leave of a projection: its portable turns and every declared loss. */
export interface TransformedTranscript {
  readonly turns: readonly CanonicalTranscriptTurn[];
  readonly declaredLosses: readonly DeclaredLossKind[];
}

/** Runs fold, strip and repair over one projection, in that order. */
export function transformTranscript(
  projection: CanonicalTranscriptProjection,
): TransformedTranscript {
  let state: TranscriptPipelineState = createTranscriptPipelineState(projection);
  state = foldTurns(state);
  state = stripNonPortableContent(state);
  state = repairPairingIntegrity(state);
  return { turns: state.turns, declaredLosses: state.declaredLosses };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * The losses deduplicated and in the contract's enumeration order, so two runs of one transcript
 * declare identical lists.
 */
export function orderDeclaredLosses(
  losses: readonly DeclaredLossKind[],
): readonly DeclaredLossKind[] {
  const present: Set<DeclaredLossKind> = new Set<DeclaredLossKind>(losses);
  return DECLARED_LOSS_KINDS.filter((kind) => present.has(kind));
}
