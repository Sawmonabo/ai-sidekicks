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
  fixture.log.append(
    storedEvent(1, "user.message", {
      runId: RUN_ID,
      actor: "participant",
      message: "run the tests",
    }),
  );
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

  it("keeps another run's rows out of this run's transcript", () => {
    const fixture = makeFixture();
    fixture.log.append(
      storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant", message: "mine" }),
    );
    fixture.log.append(
      storedEvent(2, "user.message", {
        runId: OTHER_RUN_ID,
        actor: "participant",
        message: "someone else's",
      }),
    );
    // A row naming NO run cannot be proven to belong to this one, so it is out.
    fixture.log.append(
      storedEvent(3, "user.message", { actor: "participant", message: "unscoped" }),
    );

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
    fixture.log.append(
      storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant", message: "hello" }),
    );

    const before = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    fixture.log.append(
      storedEvent(2, "user.message", { runId: OTHER_RUN_ID, message: "elsewhere" }),
    );
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
      new TranscriptTransformPipeline().exportTranscript(projection);
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

    const exported = new TranscriptTransformPipeline().exportTranscript(projection);
    const segments = segmentsOf(exported.frames as readonly RenderedTranscriptFrame[]);

    expect(segments).toEqual([{ kind: "text", text: "checking the failing suite" }]);
    expect(exported.declaredLosses).toEqual(["provider_private_reasoning"]);
  });

  it("declares no loss for a transcript that lost nothing", () => {
    const fixture = makeFixture();
    fixture.log.append(
      storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant", message: "hello" }),
    );
    fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(2, "hi");
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(new TranscriptTransformPipeline().exportTranscript(projection).declaredLosses).toEqual(
      [],
    );
  });

  it("keeps a turn whose body was unreadable and declares the loss over it", () => {
    const fixture = makeFixture();
    fixture.log.append(
      storedEvent(1, "user.message", { runId: RUN_ID, actor: "participant", message: "hello" }),
    );
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

    const exported = new TranscriptTransformPipeline().exportTranscript(projection);
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

    expect(new TranscriptTransformPipeline().exportTranscript(projection).declaredLosses).toContain(
      "turn_content_unavailable",
    );
  });

  it("is idempotent on ids across two exports of the same transcript", () => {
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const pipeline = new TranscriptTransformPipeline((canonicalId) => `target-${canonicalId}`);

    const first = pipeline.exportTranscript(projection);
    const second = pipeline.exportTranscript(projection);

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

    const frames = new TranscriptTransformPipeline().exportTranscript(projection)
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

    const exported = new TranscriptTransformPipeline().exportTranscript(projection);

    // The turn the result vacated is gone; the call's turn carries both, in
    // order, and the provider's own outcome is preserved rather than replaced
    // by a synthetic failure that did not happen.
    expect(exported.frames).toHaveLength(1);
    expect(exported.frames[0]?.position).toBe(2);
    expect(exported.frames[0]?.segments).toEqual([
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

    const exported = new TranscriptTransformPipeline().exportTranscript(projection);

    expect(exported.frames).toEqual([]);
    expect(exported.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });
});
