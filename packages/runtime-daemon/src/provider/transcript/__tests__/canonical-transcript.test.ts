// Canonical transcript fold + ordered transform pipeline (Plan-005 Phase 3, T3.19).
//
// Two properties carry this file, and both are asserted positively rather than
// left to a comment:
//
//   * THE PROJECTION IS NOT A STORE. Two folds taken at one log position are
//     equal; a fold taken after an appended event is not. Nothing is memoized.
//   * THE STEP ORDER IS THE CONTRACT. The pipeline's five steps are exported
//     individually, so the order-sensitivity cases COMPOSE them wrongly on
//     purpose and observe the defect — which is the only way an ordering claim
//     is falsifiable at all.
//
// Refs: Plan-005 §Phase 3 / T3.19, invariant I-005-8, ADR-029,
// `Spec-005 §Canonical Transcript Export And Replay`.

import { describe, expect, it } from "vitest";

import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  DriverTranscriptExportResult,
  RunId,
  SessionId,
} from "@ai-sidekicks/contracts";

import type { StoredEvent } from "../../../session/types.js";
import {
  CanonicalTranscriptFold,
  TRANSCRIPT_BEARING_EVENT_TYPES,
  isEventInRunScope,
  type TranscriptContentReference,
  type TranscriptContentSource,
  type TranscriptEventReader,
  type TranscriptReasoningBlock,
  type TranscriptToolResultBody,
} from "../canonical-transcript.js";
import {
  CANONICAL_TRANSCRIPT_PIPELINE,
  CANONICAL_TRANSCRIPT_PIPELINE_STEP_NAMES,
  SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
  SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT,
  ToolCallIdentityCollisionError,
  ToolCallIdentityMap,
  TranscriptTransformPipeline,
  UnmappedToolCallIdentityError,
  createTranscriptPipelineState,
  foldTurns,
  mapToolCallIdentity,
  renderTargetFrames,
  repairPairingIntegrity,
  stripNonPortableContent,
  type RenderedTranscriptFrame,
  type TranscriptPipelineState,
} from "../transform-pipeline.js";

const SESSION_ID: SessionId = "session-canonical-transcript" as SessionId;
const RUN_ID: RunId = "run-canonical-transcript" as RunId;
const OTHER_RUN_ID: RunId = "run-unrelated" as RunId;

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

function storedEvent(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
): StoredEvent {
  return {
    id: `evt-${sequence.toString()}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-08-26T00:00:00.000Z",
    monotonicNs: BigInt(sequence),
    category: "provider",
    type,
    actor: null,
    payload,
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

/**
 * A mutable in-memory log. Appending to it is how the projection-not-a-store
 * cases move the fold's position without rebuilding the whole fixture.
 */
class RecordedEventLog implements TranscriptEventReader {
  readonly #events: StoredEvent[] = [];

  append(event: StoredEvent): void {
    this.#events.push(event);
  }

  readEvents(): ReadonlyArray<StoredEvent> {
    return [...this.#events];
  }
}

/**
 * The content the durable payloads deliberately do not carry, keyed by the
 * logged row's own sequence. Test-local because no shipped implementation exists
 * — see the port's declaration for why that is the honest state of the corpus
 * rather than a gap in this task.
 */
class RecordedContentSource implements TranscriptContentSource {
  readonly assistantTextBySequence: Map<number, string> = new Map<number, string>();
  readonly participantTextBySequence: Map<number, string> = new Map<number, string>();
  readonly reasoningBlocksBySequence: Map<number, readonly TranscriptReasoningBlock[]> = new Map<
    number,
    readonly TranscriptReasoningBlock[]
  >();
  readonly toolArgumentsBySequence: Map<number, string> = new Map<number, string>();
  readonly toolResultBodyBySequence: Map<number, TranscriptToolResultBody> = new Map<
    number,
    TranscriptToolResultBody
  >();

  readAssistantText(reference: TranscriptContentReference): string | undefined {
    return this.assistantTextBySequence.get(reference.sequence);
  }

  readParticipantText(reference: TranscriptContentReference): string | undefined {
    return this.participantTextBySequence.get(reference.sequence);
  }

  readReasoningBlocks(reference: TranscriptContentReference): readonly TranscriptReasoningBlock[] {
    return this.reasoningBlocksBySequence.get(reference.sequence) ?? [];
  }

  readToolCallArguments(reference: TranscriptContentReference): string | undefined {
    return this.toolArgumentsBySequence.get(reference.sequence);
  }

  readToolResultBody(reference: TranscriptContentReference): TranscriptToolResultBody | undefined {
    return this.toolResultBodyBySequence.get(reference.sequence);
  }
}

interface TranscriptFixture {
  readonly log: RecordedEventLog;
  readonly contentSource: RecordedContentSource;
  readonly fold: CanonicalTranscriptFold;
}

function makeFixture(): TranscriptFixture {
  const log = new RecordedEventLog();
  const contentSource = new RecordedContentSource();
  const fold = new CanonicalTranscriptFold({ eventReader: log, contentSource });
  return { log, contentSource, fold };
}

/**
 * One participant turn, one assistant turn carrying a private reasoning block
 * whose tool result was emitted INSIDE it, and the tool call that result answers.
 * This is the shape both the strip and the pairing repair are specified against.
 */
function seedInterruptedToolFixture(fixture: TranscriptFixture): void {
  // The participant row carries NO message member, matching the shape the read
  // path actually hands back: the emitter routes that text through the encrypted
  // envelope, so the words arrive through the content port like every other body.
  fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant" }));
  fixture.contentSource.participantTextBySequence.set(1, "run the tests");
  fixture.log.append(storedEvent(2, "assistant.thinking_update", { runId: RUN_ID }));
  fixture.contentSource.reasoningBlocksBySequence.set(2, [
    {
      blockId: "block-private-1",
      reasoningKind: "thinking",
      disclosure: "private",
      text: "internal deliberation",
    },
  ]);
  fixture.log.append(
    storedEvent(3, "tool.invoked", { runId: RUN_ID, toolCallId: "call-1", toolName: "run_tests" }),
  );
  fixture.contentSource.toolArgumentsBySequence.set(3, '{"suite":"unit"}');
  fixture.log.append(storedEvent(4, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
  fixture.contentSource.toolResultBodyBySequence.set(4, {
    text: "42 passed",
    enclosingReasoningBlockId: "block-private-1",
  });
  fixture.log.append(storedEvent(5, "assistant.message", { runId: RUN_ID }));
  fixture.contentSource.assistantTextBySequence.set(5, "all green");
}

function segmentsOf(frames: readonly RenderedTranscriptFrame[]): CanonicalTranscriptSegment[] {
  return frames.flatMap((frame) => [...frame.segments]);
}

// --------------------------------------------------------------------------
// The fold
// --------------------------------------------------------------------------

describe("canonical transcript fold — scope and ordering", () => {
  it("orders turns by the log and separates participant turns from assistant turns", () => {
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns.map((turn) => turn.role)).toEqual(["participant", "assistant"]);
    expect(projection.turns.map((turn) => turn.position)).toEqual([1, 2]);
    expect(projection.turns[0]?.segments).toEqual([{ kind: "text", text: "run the tests" }]);
    expect(projection.turns[1]?.segments.map((segment) => segment.kind)).toEqual([
      "reasoning",
      "tool_call",
      "tool_result",
      "text",
    ]);
  });

  it("reads a participant turn through the content port, not off the row's clear payload", () => {
    const fixture = makeFixture();
    // The shape the read path actually returns: no message member anywhere on
    // the clear payload, because the emitter routed those words through the
    // encrypted envelope. A fold that read `payload.message` would render an
    // unavailable turn here and every real participant turn would vanish.
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant" }));
    fixture.contentSource.participantTextBySequence.set(1, "ship it");

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]?.role).toBe("participant");
    expect(projection.turns[0]?.segments).toEqual([{ kind: "text", text: "ship it" }]);
    expect(
      new TranscriptTransformPipeline().exportTranscript(projection, "unbounded").declaredLosses,
    ).toEqual([]);
  });

  it("carries an unreadable participant turn with an empty body and declares the loss", () => {
    const fixture = makeFixture();
    // Deliberately NOT seeded: the port answers "unavailable" for the person's
    // own words. They are not dropped — a dropped turn is indistinguishable from
    // a turn that never happened, and nothing would then be declared over it.
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant" }));
    fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(2, "on it");

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns.map((turn) => turn.role)).toEqual(["participant", "assistant"]);
    expect(projection.turns[0]?.position).toBe(1);
    expect(projection.turns[0]?.segments).toEqual([
      { kind: "text", text: "", contentUnavailable: true },
    ]);
    // The assistant half is intact, so the loss below is the participant's alone.
    expect(projection.turns[1]?.segments).toEqual([{ kind: "text", text: "on it" }]);

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");
    expect(exported.declaredLosses).toEqual(["turn_content_unavailable"]);
    expect(exported.frames).toHaveLength(2);
  });

  it("keeps another run's rows out of this run's transcript", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant" }));
    fixture.contentSource.participantTextBySequence.set(1, "mine");
    fixture.log.append(
      storedEvent(2, "user.message", { runId: OTHER_RUN_ID, actor: "participant" }),
    );
    fixture.contentSource.participantTextBySequence.set(2, "someone else's");
    // A row naming NO run cannot be proven to belong to this one, so it is out.
    fixture.log.append(storedEvent(3, "user.message", { actor: "participant" }));
    fixture.contentSource.participantTextBySequence.set(3, "unscoped");

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]?.segments).toEqual([{ kind: "text", text: "mine" }]);
  });

  it("splits two consecutive assistant turns on the turn marker", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(1, "first");
    fixture.log.append(storedEvent(2, "run.turn_started", { runId: RUN_ID }));
    fixture.log.append(storedEvent(3, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(3, "second");

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns).toHaveLength(2);
    expect(projection.turns.map((turn) => turn.position)).toEqual([1, 3]);
  });

  it("honours a boundary without moving the position the fold was taken at", () => {
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);

    const bounded = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID, boundary: 3 });

    // The boundary bounds the TURNS; the position still reports where the log
    // stood when the fold ran, so a bounded export cannot look current.
    expect(bounded.builtAtPosition).toBe(5);
    expect(bounded.turns.flatMap((turn) => turn.segments).map((segment) => segment.kind)).toEqual([
      "text",
      "reasoning",
      "tool_call",
    ]);
  });

  it("carries every transcript-bearing event type, and nothing outside that set", () => {
    expect([...TRANSCRIPT_BEARING_EVENT_TYPES]).toEqual([
      "run.turn_started",
      "user.message",
      "assistant.message",
      "assistant.thinking_update",
      "tool.invoked",
      "tool.result",
      "tool.error",
    ]);
    expect(isEventInRunScope(storedEvent(1, "usage.cost_update", { runId: RUN_ID }), RUN_ID)).toBe(
      false,
    );
    expect(isEventInRunScope(storedEvent(1, "user.message", { runId: RUN_ID }), RUN_ID)).toBe(true);
  });

  it("marks a failed tool row as a failed outcome carrying provider provenance", () => {
    const fixture = makeFixture();
    fixture.log.append(
      storedEvent(1, "tool.invoked", { runId: RUN_ID, toolCallId: "call-1", toolName: "read" }),
    );
    fixture.log.append(storedEvent(2, "tool.error", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(2, { text: "no such file" });

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const result = projection.turns[0]?.segments[1];

    expect(result).toEqual({
      kind: "tool_result",
      toolCallId: "call-1",
      outcome: "failed",
      provenance: "provider",
      text: "no such file",
      enclosingReasoningBlockId: undefined,
    });
  });
});

describe("canonical transcript fold — a projection, never a store", () => {
  it("renders identically twice at one log position and differently after an append", () => {
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);

    const first = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const second = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(first.builtAtPosition).toBe(5);

    fixture.log.append(storedEvent(6, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(6, "one more thing");
    const third = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(third).not.toEqual(first);
    expect(third.builtAtPosition).toBe(6);
  });

  it("moves its position for an appended event belonging to ANOTHER run", () => {
    // The position is taken over the whole log rather than over the run's own
    // rows, so a cached projection cannot look current merely because this run
    // was quiet.
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant" }));
    fixture.contentSource.participantTextBySequence.set(1, "hello");

    const before = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    fixture.log.append(storedEvent(2, "user.message", { runId: OTHER_RUN_ID }));
    fixture.contentSource.participantTextBySequence.set(2, "elsewhere");
    const after = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(after.turns).toEqual(before.turns);
    expect(before.builtAtPosition).toBe(1);
    expect(after.builtAtPosition).toBe(2);
  });
});

// --------------------------------------------------------------------------
// Tool-call identity
// --------------------------------------------------------------------------

describe("tool-call identity map", () => {
  it("round-trips an id in both directions", () => {
    const identityMap = new ToolCallIdentityMap((canonicalId) => `target-${canonicalId}`);
    const targetId = identityMap.bind("call-1");

    expect(targetId).toBe("target-call-1");
    expect(identityMap.canonicalIdFor(targetId)).toBe("call-1");
    expect(identityMap.targetIdFor("call-1")).toBe(targetId);
  });

  it("never re-mints an id it already holds", () => {
    let derivations = 0;
    const identityMap = new ToolCallIdentityMap((canonicalId) => {
      derivations += 1;
      return `${canonicalId}-${derivations.toString()}`;
    });

    expect(identityMap.bind("call-1")).toBe("call-1-1");
    expect(identityMap.bind("call-1")).toBe("call-1-1");
    expect(derivations).toBe(1);
    expect(identityMap.size).toBe(1);
  });

  it("refuses to hand one target id to two distinct calls", () => {
    const identityMap = new ToolCallIdentityMap(() => "collapsed");
    identityMap.bind("call-1");

    expect(() => identityMap.bind("call-2")).toThrow(ToolCallIdentityCollisionError);
  });

  it("throws rather than binding on demand when a lookup precedes the binding", () => {
    const identityMap = new ToolCallIdentityMap();
    expect(() => identityMap.targetIdFor("call-1")).toThrow(UnmappedToolCallIdentityError);
  });
});

// --------------------------------------------------------------------------
// The ordered pipeline
// --------------------------------------------------------------------------

describe("transform pipeline — the ordered contract", () => {
  it("names its five steps in canonical order", () => {
    expect([...CANONICAL_TRANSCRIPT_PIPELINE_STEP_NAMES]).toEqual([
      "fold",
      "map-identity",
      "strip-non-portable",
      "repair-pairing",
      "render",
    ]);
    expect(CANONICAL_TRANSCRIPT_PIPELINE).toHaveLength(
      CANONICAL_TRANSCRIPT_PIPELINE_STEP_NAMES.length,
    );
    expect(CANONICAL_TRANSCRIPT_PIPELINE).toEqual([
      foldTurns,
      mapToolCallIdentity,
      stripNonPortableContent,
      repairPairingIntegrity,
      renderTargetFrames,
    ]);
  });

  it("repairs a tool call whose result the strip removed, rather than dropping or orphaning it", () => {
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    const exported: DriverTranscriptExportResult =
      new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");
    const segments = segmentsOf(exported.frames as readonly RenderedTranscriptFrame[]);

    const calls = segments.filter((segment) => segment.kind === "tool_call");
    const results = segments.filter((segment) => segment.kind === "tool_result");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      kind: "tool_result",
      toolCallId: "call-1",
      outcome: "failed",
      provenance: "repaired",
      text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
    });

    // Positional, not merely present. The target's injection surface pairs a
    // call with the result that FOLLOWS it, so a synthetic result appended at
    // the end of the turn would satisfy every count above and still reconstitute
    // a history that does not match what happened.
    const callFrame = (exported.frames as readonly RenderedTranscriptFrame[]).find((frame) =>
      frame.segments.some((segment) => segment.kind === "tool_call"),
    );
    expect(callFrame).toBeDefined();
    const callIndex =
      callFrame?.segments.findIndex((segment) => segment.kind === "tool_call") ?? -1;
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(callFrame?.segments[callIndex + 1]).toEqual(results[0]);

    // The private block is gone and BOTH losses are declared, in the contract's
    // own enumeration order.
    expect(segments.some((segment) => segment.kind === "reasoning")).toBe(false);
    expect(exported.declaredLosses).toEqual([
      "provider_private_reasoning",
      "tool_call_history_repaired",
    ]);
  });

  it("strips only the result the private block actually enclosed, not an id-alike in another turn", () => {
    const fixture = makeFixture();
    // Both turns cite the SAME block id. Providers restart block numbering per
    // exchange, so an id is unique only within the turn that minted it — and the
    // second turn's block is a visible summary, not the private one.
    fixture.log.append(storedEvent(1, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(1, [
      {
        blockId: "block-1",
        reasoningKind: "thinking",
        disclosure: "private",
        text: "internal deliberation",
      },
    ]);
    fixture.log.append(
      storedEvent(2, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-private",
        toolName: "read_file",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(2, '{"path":"notes.md"}');
    fixture.log.append(
      storedEvent(3, "tool.result", { runId: RUN_ID, toolCallId: "call-private" }),
    );
    fixture.contentSource.toolResultBodyBySequence.set(3, {
      text: "private notes",
      enclosingReasoningBlockId: "block-1",
    });

    fixture.log.append(storedEvent(4, "run.turn_started", { runId: RUN_ID }));

    fixture.log.append(storedEvent(5, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(5, [
      {
        blockId: "block-1",
        reasoningKind: "thinking_summary",
        disclosure: "summary",
        text: "listing the directory",
      },
    ]);
    fixture.log.append(
      storedEvent(6, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-visible",
        toolName: "list_dir",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(6, '{"path":"."}');
    fixture.log.append(
      storedEvent(7, "tool.result", { runId: RUN_ID, toolCallId: "call-visible" }),
    );
    fixture.contentSource.toolResultBodyBySequence.set(7, {
      text: "three entries",
      enclosingReasoningBlockId: "block-1",
    });

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    expect(projection.turns).toHaveLength(2);

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");
    const results = segmentsOf(exported.frames as readonly RenderedTranscriptFrame[]).filter(
      (segment) => segment.kind === "tool_result",
    );
    expect(results).toHaveLength(2);

    // The genuinely enclosed result is still dropped and its call repaired.
    expect(results[0]).toEqual({
      kind: "tool_result",
      toolCallId: "call-private",
      outcome: "failed",
      provenance: "repaired",
      text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
    });

    // The visible turn's result is the provider's own, verbatim. A strip scoped
    // across the whole transcript destroys this one on the id alone and step 4
    // then reports a failure the provider never produced.
    expect(results[1]).toEqual({
      kind: "tool_result",
      toolCallId: "call-visible",
      outcome: "succeeded",
      provenance: "provider",
      text: "three entries",
      enclosingReasoningBlockId: "block-1",
    });
  });

  it("carries a visible reasoning summary forward as plain text, at no declared cost", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(1, [
      {
        blockId: "block-summary-1",
        reasoningKind: "thinking_summary",
        disclosure: "summary",
        text: "checking the failing suite",
      },
      {
        // A redacted SIBLING of the private kind: keying the strip on the kind
        // NAME instead of the disclosure would leave exactly this block behind.
        blockId: "block-private-2",
        reasoningKind: "redacted_thinking",
        disclosure: "private",
        text: "opaque",
      },
    ]);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");
    const segments = segmentsOf(exported.frames as readonly RenderedTranscriptFrame[]);

    expect(segments).toEqual([{ kind: "text", text: "checking the failing suite" }]);
    expect(exported.declaredLosses).toEqual(["provider_private_reasoning"]);
  });

  it("declares no loss for a transcript that lost nothing", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant" }));
    fixture.contentSource.participantTextBySequence.set(1, "hello");
    fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(2, "hi");
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(
      new TranscriptTransformPipeline().exportTranscript(projection, "unbounded").declaredLosses,
    ).toEqual([]);
  });

  it("keeps a turn whose body was unreadable and declares the loss over it", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant" }));
    // Seeded, so exactly ONE turn in this projection is unreadable. Leaving the
    // participant row unseeded too would let this test pass while proving
    // something other than what its name claims.
    fixture.contentSource.participantTextBySequence.set(1, "hello");
    // Deliberately NOT seeded: the content source answers "unavailable".
    fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    // The turn is still there — a dropped one is indistinguishable from a turn
    // that never happened, and the export would then declare nothing at all.
    expect(projection.turns).toHaveLength(2);
    expect(projection.turns[1]?.role).toBe("assistant");
    expect(projection.turns[1]?.segments).toEqual([
      { kind: "text", text: "", contentUnavailable: true },
    ]);

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");
    expect(exported.declaredLosses).toEqual(["turn_content_unavailable"]);
    expect(exported.frames).toHaveLength(2);
  });

  it("declares the loss over an unreadable TOOL body, call and result alike", () => {
    const fixture = makeFixture();
    fixture.log.append(
      storedEvent(1, "tool.invoked", { runId: RUN_ID, toolCallId: "call-1", toolName: "inspect" }),
    );
    fixture.log.append(storedEvent(2, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    const segments = projection.turns.flatMap((turn) => [...turn.segments]);
    // The pairing keys survive: replacing an unreadable call with a marker
    // segment would destroy the id the repair and the identity map run on.
    expect(segments).toEqual([
      {
        kind: "tool_call",
        toolCallId: "call-1",
        toolName: "inspect",
        argumentsJson: "",
        contentUnavailable: true,
      },
      {
        kind: "tool_result",
        toolCallId: "call-1",
        outcome: "succeeded",
        provenance: "provider",
        text: "",
        enclosingReasoningBlockId: undefined,
        contentUnavailable: true,
      },
    ]);

    expect(
      new TranscriptTransformPipeline().exportTranscript(projection, "unbounded").declaredLosses,
    ).toContain("turn_content_unavailable");
  });

  it("is idempotent on ids across two exports of the same transcript", () => {
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const pipeline = new TranscriptTransformPipeline((canonicalId) => `target-${canonicalId}`);

    const first = pipeline.exportTranscript(projection, "unbounded");
    const second = pipeline.exportTranscript(projection, "unbounded");

    expect(second).toEqual(first);
    const firstIds = segmentsOf(first.frames as readonly RenderedTranscriptFrame[])
      .filter((segment) => segment.kind === "tool_call")
      .map((segment) => (segment.kind === "tool_call" ? segment.toolCallId : ""));
    expect(firstIds).toEqual(["target-call-1"]);
  });

  it("round-trips a rendered id back to its canonical one", () => {
    const identityMap = new ToolCallIdentityMap((canonicalId) => `target-${canonicalId}`);
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    let state: TranscriptPipelineState = createTranscriptPipelineState(projection, identityMap);
    for (const step of CANONICAL_TRANSCRIPT_PIPELINE) {
      state = step(state);
    }

    const renderedIds = segmentsOf(state.frames)
      .filter((segment) => segment.kind === "tool_call")
      .map((segment) => (segment.kind === "tool_call" ? segment.toolCallId : ""));
    expect(renderedIds).toEqual(["target-call-1"]);
    for (const renderedId of renderedIds) {
      expect(identityMap.canonicalIdFor(renderedId)).toBe("call-1");
    }
  });

  it("classifies a replayed participant turn as participant text and leaves seeded history unclassified", () => {
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    const frames = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded")
      .frames as readonly RenderedTranscriptFrame[];

    expect(frames.map((frame) => frame.origin)).toEqual(["participant_text", undefined]);
  });
});

describe("transform pipeline — the order is falsifiable", () => {
  function projectionWithStrippedResult(): CanonicalTranscriptProjection {
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);
    return fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
  }

  it("repairing BEFORE stripping leaves the call unpaired — the defect the order prevents", () => {
    // Step 4 before step 3. The repair sees a paired call, does nothing, and the
    // strip then removes the result it would have paired against. The very same
    // fixture emerges repaired under the canonical order, one case above.
    let state: TranscriptPipelineState = createTranscriptPipelineState(
      projectionWithStrippedResult(),
    );
    for (const step of [
      foldTurns,
      mapToolCallIdentity,
      repairPairingIntegrity,
      stripNonPortableContent,
      renderTargetFrames,
    ]) {
      state = step(state);
    }

    const segments = segmentsOf(state.frames);
    expect(segments.filter((segment) => segment.kind === "tool_call")).toHaveLength(1);
    expect(segments.filter((segment) => segment.kind === "tool_result")).toHaveLength(0);
    expect(state.declaredLosses).not.toContain("tool_call_history_repaired");
  });

  it("rendering BEFORE mapping identity throws rather than minting ids", () => {
    // Step 2 after step 5. The render's lookup is deliberately not a
    // bind-on-demand, so this fails loudly instead of producing frames whose ids
    // nothing else agrees about.
    let state: TranscriptPipelineState = createTranscriptPipelineState(
      projectionWithStrippedResult(),
    );
    state = foldTurns(state);
    state = stripNonPortableContent(state);
    state = repairPairingIntegrity(state);

    expect(() => renderTargetFrames(state)).toThrow(UnmappedToolCallIdentityError);
  });

  it("skipping the fold produces nothing — step 1 is a real step", () => {
    let state: TranscriptPipelineState = createTranscriptPipelineState(
      projectionWithStrippedResult(),
    );
    for (const step of [
      mapToolCallIdentity,
      stripNonPortableContent,
      repairPairingIntegrity,
      renderTargetFrames,
    ]) {
      state = step(state);
    }

    expect(state.frames).toEqual([]);
  });

  it("re-homes a result that stands BEFORE the call it answers, and declares the repair", () => {
    // Both ids are present, so a membership check pairs them and reports no loss
    // — while the target is handed a result for a call it has not yet seen.
    const projection: CanonicalTranscriptProjection = {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      builtAtPosition: 3,
      turns: [
        {
          position: 1,
          role: "assistant",
          segments: [
            {
              kind: "tool_result",
              toolCallId: "call-inverted",
              outcome: "succeeded",
              provenance: "provider",
              text: "answered early",
            },
          ],
        },
        {
          position: 2,
          role: "assistant",
          segments: [
            {
              kind: "tool_call",
              toolCallId: "call-inverted",
              toolName: "inspect",
              argumentsJson: "{}",
            },
          ],
        },
      ],
    };

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");

    // The turn the result vacated is gone; the call's turn carries both, in
    // order, and the provider's own outcome is preserved rather than replaced
    // by a synthetic failure that did not happen.
    expect(exported.frames).toHaveLength(1);
    const invertedPairFrames = exported.frames as readonly RenderedTranscriptFrame[];
    expect(invertedPairFrames[0]?.position).toBe(2);
    expect(invertedPairFrames[0]?.segments).toEqual([
      { kind: "tool_call", toolCallId: "call-inverted", toolName: "inspect", argumentsJson: "{}" },
      {
        kind: "tool_result",
        toolCallId: "call-inverted",
        outcome: "succeeded",
        provenance: "provider",
        text: "answered early",
      },
    ]);
    expect(exported.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });

  it("removes a result whose call is absent rather than asserting a call that never happened", () => {
    const projection: CanonicalTranscriptProjection = {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      builtAtPosition: 2,
      turns: [
        {
          position: 1,
          role: "assistant",
          segments: [
            {
              kind: "tool_result",
              toolCallId: "call-from-another-run",
              outcome: "succeeded",
              provenance: "provider",
              text: "orphaned",
            },
          ],
        },
      ],
    };

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");

    expect(exported.frames).toEqual([]);
    expect(exported.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });
});

// --------------------------------------------------------------------------
// One call, one result, one identifier
// --------------------------------------------------------------------------

describe("transform pipeline — pairing is one-to-one, on identifiers that are unique", () => {
  const OWNER_ARGUMENTS = '{"target":"one"}';
  const DUPLICATE_ARGUMENTS = '{"target":"two"}';

  function callSegment(argumentsJson: string): CanonicalTranscriptSegment {
    return { kind: "tool_call", toolCallId: "call-shared", toolName: "inspect", argumentsJson };
  }

  const OWNER_RESULT: CanonicalTranscriptSegment = {
    kind: "tool_result",
    toolCallId: "call-shared",
    outcome: "succeeded",
    provenance: "provider",
    text: "the answer to the first call",
  };

  function projectionOfTurns(
    turnSegments: readonly (readonly CanonicalTranscriptSegment[])[],
  ): CanonicalTranscriptProjection {
    return {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      builtAtPosition: turnSegments.length,
      turns: turnSegments.map((segments, index) => ({
        position: index + 1,
        role: "assistant",
        segments,
      })),
    };
  }

  /**
   * The property the repair owes, asserted over the exported frames rather than
   * over one arrangement of them: every exported call carries a DISTINCT
   * identifier, every call is answered exactly once, every answer follows its own
   * call, and no answer names a call that is not there.
   */
  function expectOneAnswerPerDistinctCall(exported: DriverTranscriptExportResult): void {
    const segments = segmentsOf(exported.frames as readonly RenderedTranscriptFrame[]);
    const callIds = segments
      .filter((segment) => segment.kind === "tool_call")
      .map((segment) => (segment.kind === "tool_call" ? segment.toolCallId : ""));
    expect(new Set(callIds).size).toBe(callIds.length);

    for (const callId of callIds) {
      const callIndex = segments.findIndex(
        (segment) => segment.kind === "tool_call" && segment.toolCallId === callId,
      );
      const answerIndices = segments.flatMap((segment, index) =>
        segment.kind === "tool_result" && segment.toolCallId === callId ? [index] : [],
      );
      expect(answerIndices).toHaveLength(1);
      expect(answerIndices[0]).toBeGreaterThan(callIndex);
    }

    const resultIds = segments
      .filter((segment) => segment.kind === "tool_result")
      .map((segment) => (segment.kind === "tool_result" ? segment.toolCallId : ""));
    expect([...resultIds].sort()).toEqual([...callIds].sort());
  }

  function repairedDuplicateSegments(
    duplicateToolCallId: string,
  ): readonly CanonicalTranscriptSegment[] {
    return [
      callSegment(OWNER_ARGUMENTS),
      OWNER_RESULT,
      {
        kind: "tool_call",
        toolCallId: duplicateToolCallId,
        toolName: "inspect",
        argumentsJson: DUPLICATE_ARGUMENTS,
      },
      {
        kind: "tool_result",
        toolCallId: duplicateToolCallId,
        outcome: "failed",
        provenance: "repaired",
        text: SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT,
      },
    ];
  }

  it("retains the first answer to a call and drops a second one under its identifier", () => {
    // A provider answers a call once. Marking the call resolved and keeping both
    // answers exports a one-to-many pairing under no declared repair at all.
    const projection = projectionOfTurns([
      [
        callSegment(OWNER_ARGUMENTS),
        OWNER_RESULT,
        {
          kind: "tool_result",
          toolCallId: "call-shared",
          outcome: "failed",
          provenance: "provider",
          text: "a second answer to a call already answered",
        },
      ],
    ]);

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");

    expect(segmentsOf(exported.frames as readonly RenderedTranscriptFrame[])).toEqual([
      callSegment(OWNER_ARGUMENTS),
      OWNER_RESULT,
    ]);
    expectOneAnswerPerDistinctCall(exported);
    expect(exported.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });

  it("disambiguates a later call reusing an identifier, when the answer sits between them", () => {
    const projection = projectionOfTurns([
      [callSegment(OWNER_ARGUMENTS), OWNER_RESULT, callSegment(DUPLICATE_ARGUMENTS)],
    ]);

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");

    // The identifier is derived from the duplicate's own position in the
    // transcript, and its arguments cross unchanged.
    expect(segmentsOf(exported.frames as readonly RenderedTranscriptFrame[])).toEqual(
      repairedDuplicateSegments("call-shared-repaired-2"),
    );
    expectOneAnswerPerDistinctCall(exported);
    expect(exported.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });

  it("disambiguates a later call reusing an identifier, when the answer follows both", () => {
    // The owner's own answer is pulled up beside it, so a target pairing a call
    // with the result that follows cannot read the duplicate's synthetic failure
    // as the first call's outcome.
    const projection = projectionOfTurns([
      [callSegment(OWNER_ARGUMENTS)],
      [callSegment(DUPLICATE_ARGUMENTS)],
      [OWNER_RESULT],
    ]);

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");
    const frames = exported.frames as readonly RenderedTranscriptFrame[];

    expect(segmentsOf(frames)).toEqual(repairedDuplicateSegments("call-shared-repaired-1"));
    // The turn the answer vacated carries nothing and is gone.
    expect(frames.map((frame) => frame.position)).toEqual([1, 2]);
    expectOneAnswerPerDistinctCall(exported);
    expect(exported.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });

  it("disambiguates a later call reusing an identifier, when the answer precedes both", () => {
    // The re-home lands the answer on the call that OWNS the identifier, never on
    // the duplicate that came after it.
    const projection = projectionOfTurns([
      [OWNER_RESULT],
      [callSegment(OWNER_ARGUMENTS)],
      [callSegment(DUPLICATE_ARGUMENTS)],
    ]);

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");
    const frames = exported.frames as readonly RenderedTranscriptFrame[];

    expect(segmentsOf(frames)).toEqual(repairedDuplicateSegments("call-shared-repaired-2"));
    expect(frames.map((frame) => frame.position)).toEqual([2, 3]);
    expectOneAnswerPerDistinctCall(exported);
    expect(exported.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });

  it("answers an unpaired owner and a reused identifier in one transcript, distinctly", () => {
    // The shape a provider re-emitting a call after an interruption produces:
    // neither call was ever answered, so the owner takes the unpaired repair and
    // the duplicate takes the reused-identifier one.
    const projection = projectionOfTurns([
      [callSegment(OWNER_ARGUMENTS), callSegment(DUPLICATE_ARGUMENTS)],
    ]);

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");

    expect(segmentsOf(exported.frames as readonly RenderedTranscriptFrame[])).toEqual([
      callSegment(OWNER_ARGUMENTS),
      {
        kind: "tool_result",
        toolCallId: "call-shared",
        outcome: "failed",
        provenance: "repaired",
        text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
      },
      {
        kind: "tool_call",
        toolCallId: "call-shared-repaired-1",
        toolName: "inspect",
        argumentsJson: DUPLICATE_ARGUMENTS,
      },
      {
        kind: "tool_result",
        toolCallId: "call-shared-repaired-1",
        outcome: "failed",
        provenance: "repaired",
        text: SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT,
      },
    ]);
    expectOneAnswerPerDistinctCall(exported);
    expect(exported.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });

  it("derives the same disambiguated identifier on every export of one transcript", () => {
    const projection = projectionOfTurns([
      [callSegment(OWNER_ARGUMENTS)],
      [callSegment(DUPLICATE_ARGUMENTS)],
      [OWNER_RESULT],
    ]);
    const pipeline = new TranscriptTransformPipeline();

    // A counter or a random value would make the second export unrecognizable to
    // a target that already saw the first.
    expect(pipeline.exportTranscript(projection, "unbounded")).toEqual(
      pipeline.exportTranscript(projection, "unbounded"),
    );
  });

  it("routes a disambiguated identifier through the identity map like any other", () => {
    // The render's rewrite is a LOOKUP, so an identifier minted after the mapping
    // step reaches it bound or the export throws.
    const projection = projectionOfTurns([
      [callSegment(OWNER_ARGUMENTS)],
      [callSegment(DUPLICATE_ARGUMENTS)],
      [OWNER_RESULT],
    ]);

    const exported = new TranscriptTransformPipeline(
      (canonicalId) => `target-${canonicalId}`,
    ).exportTranscript(projection, "unbounded");

    const renderedIds = segmentsOf(exported.frames as readonly RenderedTranscriptFrame[])
      .filter((segment) => segment.kind === "tool_call")
      .map((segment) => (segment.kind === "tool_call" ? segment.toolCallId : ""));
    expect(renderedIds).toEqual(["target-call-shared", "target-call-shared-repaired-1"]);
  });

  it("mints an identifier the transcript does not already spend", () => {
    // The composed name is not reserved, so a provider is free to have used it.
    // A repair that collided with a real call would recreate the defect.
    const projection = projectionOfTurns([
      [
        callSegment(OWNER_ARGUMENTS),
        callSegment(DUPLICATE_ARGUMENTS),
        {
          kind: "tool_call",
          toolCallId: "call-shared-repaired-1",
          toolName: "inspect",
          argumentsJson: '{"target":"three"}',
        },
        OWNER_RESULT,
      ],
    ]);

    const exported = new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");
    const callIds = segmentsOf(exported.frames as readonly RenderedTranscriptFrame[])
      .filter((segment) => segment.kind === "tool_call")
      .map((segment) => (segment.kind === "tool_call" ? segment.toolCallId : ""));

    expect(callIds).toEqual(["call-shared", "call-shared-repaired-1-1", "call-shared-repaired-1"]);
    expectOneAnswerPerDistinctCall(exported);
  });
});

// --------------------------------------------------------------------------
// The export boundary
// --------------------------------------------------------------------------

/**
 * Four turns, alternating roles so each event lands in a turn of its own:
 * positions 1 and 3 are the participant's, 2 and 4 the assistant's.
 */
function seedFourTurnFixture(fixture: TranscriptFixture): void {
  fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant" }));
  fixture.contentSource.participantTextBySequence.set(1, "first question");
  fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
  fixture.contentSource.assistantTextBySequence.set(2, "first answer");
  fixture.log.append(storedEvent(3, "user.message", { runId: RUN_ID, actor: "participant" }));
  fixture.contentSource.participantTextBySequence.set(3, "second question");
  fixture.log.append(storedEvent(4, "assistant.message", { runId: RUN_ID }));
  fixture.contentSource.assistantTextBySequence.set(4, "second answer");
}

function exportedPositions(exported: DriverTranscriptExportResult): number[] {
  return (exported.frames as readonly RenderedTranscriptFrame[]).map((frame) => frame.position);
}

function exportedText(exported: DriverTranscriptExportResult): string {
  return segmentsOf(exported.frames as readonly RenderedTranscriptFrame[])
    .map((segment) => (segment.kind === "text" ? segment.text : ""))
    .join("\n");
}

describe("transform pipeline — a bounded export carries only what the bound admits", () => {
  it("renders no turn past the bound, and the whole projection when there is none", () => {
    const fixture = makeFixture();
    seedFourTurnFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const pipeline = new TranscriptTransformPipeline();

    const bounded: DriverTranscriptExportResult = pipeline.exportTranscript(projection, 2);
    const whole: DriverTranscriptExportResult = pipeline.exportTranscript(projection, "unbounded");

    expect(exportedPositions(bounded)).toEqual([1, 2]);
    // Asserted on the rendered CONTENT, not merely on the frame count: a bound
    // that filtered positions while leaving the later turns' text somewhere in
    // the export would still leak the conversation it was asked to withhold.
    expect(exportedText(bounded)).toContain("first answer");
    expect(exportedText(bounded)).not.toContain("second question");
    expect(exportedText(bounded)).not.toContain("second answer");

    expect(exportedPositions(whole)).toEqual([1, 2, 3, 4]);
    expect(exportedText(whole)).toContain("second answer");
  });

  it("includes the turn sitting exactly on the bound", () => {
    const fixture = makeFixture();
    seedFourTurnFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const pipeline = new TranscriptTransformPipeline();

    // The bound is INCLUSIVE. An off-by-one in the other direction would drop a
    // turn the caller asked to keep, so both sides of the same position are
    // asserted rather than one.
    expect(exportedPositions(pipeline.exportTranscript(projection, 2))).toEqual([1, 2]);
    expect(exportedPositions(pipeline.exportTranscript(projection, 1))).toEqual([1]);
  });

  it("leaves the position the fold was taken at where the fold put it", () => {
    const fixture = makeFixture();
    seedFourTurnFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    new TranscriptTransformPipeline().exportTranscript(projection, 2);

    // Bounding is a question about this export, not a claim that the
    // conversation stopped — and the projection the caller handed in is not the
    // pipeline's to mutate.
    expect(projection.builtAtPosition).toBe(4);
    expect(projection.turns).toHaveLength(4);
  });

  it("declares losses over the admitted turns only", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant" }));
    fixture.contentSource.participantTextBySequence.set(1, "what changed");
    // The unreadable body sits PAST the bound. A bounded export that declared it
    // would be reporting a loss over content it did not carry.
    fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const pipeline = new TranscriptTransformPipeline();

    expect(pipeline.exportTranscript(projection, 1).declaredLosses).toEqual([]);
    expect(pipeline.exportTranscript(projection, "unbounded").declaredLosses).toEqual([
      "turn_content_unavailable",
    ]);
  });

  it("bounds the turns BEFORE pairing repair, so a call keeps an answer inside the bound", () => {
    const fixture = makeFixture();
    fixture.log.append(
      storedEvent(1, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "read_file",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(1, '{"path":"notes.md"}');
    fixture.log.append(storedEvent(2, "run.turn_started", { runId: RUN_ID }));
    // The real answer arrives in the NEXT turn, outside the bound below.
    fixture.log.append(storedEvent(3, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(3, { text: "the file contents" });
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    const bounded: DriverTranscriptExportResult =
      new TranscriptTransformPipeline().exportTranscript(projection, 1);
    const segments = segmentsOf(bounded.frames as readonly RenderedTranscriptFrame[]);

    // This is what makes the PLACEMENT falsifiable rather than merely the
    // filtering. Bounding after the repair instead would pair the call with the
    // out-of-bound result, then leave that pairing to be undone downstream — an
    // unanswered call reaching the target under no declared loss at all.
    expect(segments.filter((segment) => segment.kind === "tool_call")).toHaveLength(1);
    expect(segments.filter((segment) => segment.kind === "tool_result")).toEqual([
      {
        kind: "tool_result",
        toolCallId: "call-1",
        outcome: "failed",
        provenance: "repaired",
        text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
      },
    ]);
    expect(exportedText(bounded)).not.toContain("the file contents");
    expect(bounded.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });
});

// --------------------------------------------------------------------------
// Legacy tool rows that name no pairing key
// --------------------------------------------------------------------------

describe("canonical transcript fold — a tool row naming no call identifier", () => {
  it("carries the invocation and its answer as content instead of dropping both", () => {
    const fixture = makeFixture();
    // Neither row names a call identifier — the shape older history legally has,
    // since only live emitters are held to that key.
    fixture.log.append(storedEvent(1, "tool.invoked", { runId: RUN_ID, toolName: "read_file" }));
    fixture.contentSource.toolArgumentsBySequence.set(1, '{"path":"notes.md"}');
    fixture.log.append(storedEvent(2, "tool.result", { runId: RUN_ID }));
    fixture.contentSource.toolResultBodyBySequence.set(2, { text: "the file contents" });

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const exported: DriverTranscriptExportResult =
      new TranscriptTransformPipeline().exportTranscript(projection, "unbounded");

    // The silent-drop shape is an empty export declaring nothing. Both halves of
    // that are asserted, because either alone would let it back in.
    expect(exported.frames).not.toEqual([]);
    expect(exported.frames).toHaveLength(1);
    // The literal text a target receives, not merely a substring of it: the row
    // has to read as tool activity rather than as prose the assistant wrote.
    expect(
      segmentsOf(exported.frames as readonly RenderedTranscriptFrame[]).map((segment) =>
        segment.kind === "text" ? segment.text : "",
      ),
    ).toEqual([
      '[tool call read_file] {"path":"notes.md"}',
      "[tool result succeeded] the file contents",
    ]);
    // Nothing was lost, so nothing is declared — and the row rides the one
    // segment kind that needs no identifier, so no identifier was minted.
    expect(exported.declaredLosses).toEqual([]);
    expect(
      segmentsOf(exported.frames as readonly RenderedTranscriptFrame[]).map(
        (segment) => segment.kind,
      ),
    ).toEqual(["text", "text"]);
  });

  it("leaves a row that does name its call rendered structurally", () => {
    const fixture = makeFixture();
    fixture.log.append(
      storedEvent(1, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "read_file",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(1, '{"path":"notes.md"}');
    fixture.log.append(storedEvent(2, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(2, { text: "the file contents" });

    const exported: DriverTranscriptExportResult =
      new TranscriptTransformPipeline().exportTranscript(
        fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
        "unbounded",
      );

    expect(
      segmentsOf(exported.frames as readonly RenderedTranscriptFrame[]).map(
        (segment) => segment.kind,
      ),
    ).toEqual(["tool_call", "tool_result"]);
    expect(exported.declaredLosses).toEqual([]);
  });

  it("names a failed answer as failed rather than borrowing the succeeded wording", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "tool.error", { runId: RUN_ID }));
    fixture.contentSource.toolResultBodyBySequence.set(1, { text: "permission denied" });

    const exported: DriverTranscriptExportResult =
      new TranscriptTransformPipeline().exportTranscript(
        fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
        "unbounded",
      );

    expect(
      segmentsOf(exported.frames as readonly RenderedTranscriptFrame[]).map((segment) =>
        segment.kind === "text" ? segment.text : "",
      ),
    ).toEqual(["[tool result failed] permission denied"]);
    expect(exported.declaredLosses).toEqual([]);
  });

  it("withholds and marks an unkeyed answer the provider emitted inside a private block", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(1, [
      {
        blockId: "block-1",
        reasoningKind: "thinking",
        disclosure: "private",
        text: "internal deliberation",
      },
    ]);
    fixture.log.append(storedEvent(2, "tool.result", { runId: RUN_ID }));
    fixture.contentSource.toolResultBodyBySequence.set(2, {
      text: "private notes",
      enclosingReasoningBlockId: "block-1",
    });

    const exported: DriverTranscriptExportResult =
      new TranscriptTransformPipeline().exportTranscript(
        fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
        "unbounded",
      );

    // A text segment carries no enclosure, so the strip cannot see one — which
    // makes rendering this body as text a way around the very step that exists
    // to remove it. It is withheld, and the withholding is DECLARED.
    expect(exportedText(exported)).not.toContain("private notes");
    expect(exportedText(exported)).not.toContain("internal deliberation");
    expect(exported.declaredLosses).toEqual([
      "provider_private_reasoning",
      "turn_content_unavailable",
    ]);
  });

  it("marks an unkeyed invocation whose arguments could not be read", () => {
    const fixture = makeFixture();
    // No arguments seeded: the body is unreadable, and inventing one is the
    // single thing the fold may not do.
    fixture.log.append(storedEvent(1, "tool.invoked", { runId: RUN_ID, toolName: "read_file" }));

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns[0]?.segments).toEqual([
      { kind: "text", text: "", contentUnavailable: true },
    ]);
    expect(
      new TranscriptTransformPipeline().exportTranscript(projection, "unbounded").declaredLosses,
    ).toEqual(["turn_content_unavailable"]);
  });

  it("still drops a row that names its call but no tool", () => {
    const fixture = makeFixture();
    // The inverse shape, and NOT one older history produces: the tool row names
    // its tool unconditionally and makes only the call identifier optional.
    // Carrying this one as text would throw away a pairing key that IS present
    // and orphan the answer under it, so the drop stands.
    fixture.log.append(storedEvent(1, "tool.invoked", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolArgumentsBySequence.set(1, '{"path":"notes.md"}');

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns).toEqual([]);
  });
});
