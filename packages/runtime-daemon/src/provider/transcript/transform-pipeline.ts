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

import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
  DeclaredLossKind,
  DriverTranscriptExportResult,
} from "@ai-sidekicks/contracts";

import { DECLARED_LOSS_KINDS } from "@ai-sidekicks/contracts";

import type { OutboundFrameOrigin } from "../drivers/outbound-frame.js";

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
 * The text a repaired tool result carries. Fixed rather than composed per call so
 * a target reading two repaired results cannot infer a difference that is not
 * there, and so a test can assert the repair by value.
 */
export const SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT: string =
  "This tool call produced no result: the turn ended before one was recorded.";

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
  const strippedBlockIds: Set<string> = new Set<string>();

  // Two passes, because a result carried INSIDE a private block may be rendered
  // before that block in segment order and must still go with it.
  for (const turn of state.turns) {
    for (const segment of turn.segments) {
      if (segment.kind === "reasoning" && segment.disclosure === "private") {
        strippedBlockIds.add(segment.blockId);
      }
    }
  }

  const strippedTurns: CanonicalTranscriptTurn[] = [];
  let recordedPrivateReasoningLoss = false;

  for (const turn of state.turns) {
    const keptSegments: CanonicalTranscriptSegment[] = [];
    for (const segment of turn.segments) {
      if (segment.kind === "reasoning") {
        if (segment.disclosure === "private") {
          recordedPrivateReasoningLoss = true;
          continue;
        }
        keptSegments.push({ kind: "text", text: segment.text });
        continue;
      }
      if (
        segment.kind === "tool_result" &&
        segment.enclosingReasoningBlockId !== undefined &&
        strippedBlockIds.has(segment.enclosingReasoningBlockId)
      ) {
        // The result goes with the block that carried it. Its CALL survives —
        // that asymmetry is what step 4 exists to answer.
        recordedPrivateReasoningLoss = true;
        continue;
      }
      keptSegments.push(segment);
    }
    if (keptSegments.length > 0) {
      strippedTurns.push({ position: turn.position, role: turn.role, segments: keptSegments });
    }
  }

  if (recordedPrivateReasoningLoss) {
    declaredLosses.push("provider_private_reasoning");
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
 * Three repairs, all declared:
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
 */
export const repairPairingIntegrity: TranscriptPipelineStep = (state) => {
  // Flat segment ordinals across the whole transcript, so "before" and "after"
  // are answerable across a turn boundary — which is where a provider's own
  // out-of-order emission lands them.
  const firstCallOrdinalByToolCallId: Map<string, number> = new Map<string, number>();
  const resolvedToolCallIds: Set<string> = new Set<string>();
  let scanOrdinal = 0;

  for (const turn of state.turns) {
    for (const segment of turn.segments) {
      if (segment.kind === "tool_call" && !firstCallOrdinalByToolCallId.has(segment.toolCallId)) {
        firstCallOrdinalByToolCallId.set(segment.toolCallId, scanOrdinal);
      }
      scanOrdinal += 1;
    }
  }

  for (const turn of state.turns) {
    for (const segment of turn.segments) {
      // A result whose call is absent resolves nothing: it is dropped below, so
      // counting it here would suppress the synthetic its call never gets.
      if (segment.kind === "tool_result" && firstCallOrdinalByToolCallId.has(segment.toolCallId)) {
        resolvedToolCallIds.add(segment.toolCallId);
      }
    }
  }

  let repaired = false;
  const repairedTurns: CanonicalTranscriptTurn[] = [];
  // Results lifted out of a position before their call, keyed by that call.
  const resultsAwaitingTheirCall: Map<string, CanonicalTranscriptSegment[]> = new Map<
    string,
    CanonicalTranscriptSegment[]
  >();
  let emitOrdinal = 0;

  for (const turn of state.turns) {
    const segments: CanonicalTranscriptSegment[] = [];
    for (const segment of turn.segments) {
      const currentOrdinal: number = emitOrdinal;
      emitOrdinal += 1;

      if (segment.kind === "tool_result") {
        const callOrdinal: number | undefined = firstCallOrdinalByToolCallId.get(
          segment.toolCallId,
        );
        if (callOrdinal === undefined) {
          repaired = true;
          continue;
        }
        if (currentOrdinal < callOrdinal) {
          repaired = true;
          const stashed: CanonicalTranscriptSegment[] =
            resultsAwaitingTheirCall.get(segment.toolCallId) ?? [];
          stashed.push(segment);
          resultsAwaitingTheirCall.set(segment.toolCallId, stashed);
          continue;
        }
        segments.push(segment);
        continue;
      }

      segments.push(segment);

      if (segment.kind !== "tool_call") {
        continue;
      }
      // Every result that preceded this call was stashed on the way here, so
      // re-homing them now lands each one directly after the call it answers.
      const rehomed: CanonicalTranscriptSegment[] | undefined = resultsAwaitingTheirCall.get(
        segment.toolCallId,
      );
      if (rehomed !== undefined) {
        segments.push(...rehomed);
        resultsAwaitingTheirCall.delete(segment.toolCallId);
      }
      if (!resolvedToolCallIds.has(segment.toolCallId)) {
        repaired = true;
        segments.push({
          kind: "tool_result",
          toolCallId: segment.toolCallId,
          outcome: "failed",
          provenance: "repaired",
          text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
        });
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
   * Export one canonical transcript. Called twice on the same projection this
   * returns equal frames and equal ids — the derivation is deterministic and
   * nothing is carried between calls.
   */
  exportTranscript(projection: CanonicalTranscriptProjection): DriverTranscriptExportResult {
    const identityMap: ToolCallIdentityMap =
      this.#deriveTargetToolCallId === undefined
        ? new ToolCallIdentityMap()
        : new ToolCallIdentityMap(this.#deriveTargetToolCallId);

    let state: TranscriptPipelineState = createTranscriptPipelineState(projection, identityMap);
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
