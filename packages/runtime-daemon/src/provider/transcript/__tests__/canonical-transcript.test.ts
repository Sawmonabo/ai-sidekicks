// The canonical transcript fold and its transform steps: no turn is lost, reordered or carried
// past its bound, no private reasoning leaves, and every carried tool call stays paired.

import { describe, expect, it } from "vitest";

import { boundProjectionToPosition } from "../canonical-transcript.js";
import {
  SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
  SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT,
  createTranscriptPipelineState,
  foldTurns,
  repairPairingIntegrity,
  stripNonPortableContent,
  transformTranscript,
  type TransformedTranscript,
  type TranscriptPipelineState,
} from "../transform-pipeline.js";
import {
  OTHER_RUN_ID,
  RUN_ID,
  SESSION_ID,
  makeFixture,
  storedEvent,
  type TranscriptFixture,
} from "./transcript-log-test-doubles.js";
import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
} from "../../provider-driver.js";

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

/**
 * One user turn, then an assistant turn with a private reasoning block, a tool call, and that
 * call's result emitted inside the block. Both the strip and the pairing repair act on it.
 */
function seedInterruptedToolFixture(fixture: TranscriptFixture): void {
  // The user row has no message member, as on the read path: the text sits in the encrypted
  // envelope and arrives through the content port like every other body.
  fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
  fixture.contentSource.userTextBySequence.set(1, "run the tests");
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

function segmentsOf(turns: readonly CanonicalTranscriptTurn[]): CanonicalTranscriptSegment[] {
  return turns.flatMap((turn) => [...turn.segments]);
}

// --------------------------------------------------------------------------
// The fold
// --------------------------------------------------------------------------

describe("canonical transcript fold — scope and ordering", () => {
  it("orders turns by the log and separates user turns from assistant turns", () => {
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(projection.turns.map((turn) => turn.position)).toEqual([1, 2]);
    expect(projection.turns[0]?.segments).toEqual([
      { kind: "text", position: 1, text: "run the tests" },
    ]);
    expect(projection.turns[1]?.segments.map((segment) => segment.kind)).toEqual([
      "reasoning",
      "tool_call",
      "tool_result",
      "text",
    ]);
  });

  it("carries an unreadable user turn with an empty body and declares the loss", () => {
    const fixture = makeFixture();
    // Not seeded: the port answers unavailable. The turn is kept, since a dropped one looks like a
    // turn that never happened and declares nothing.
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(2, "on it");

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(projection.turns[0]?.position).toBe(1);
    expect(projection.turns[0]?.segments).toEqual([
      { kind: "text", position: 1, text: "", contentUnavailable: true },
    ]);
    // The assistant turn is intact, so the loss below is the user's alone.
    expect(projection.turns[1]?.segments).toEqual([{ kind: "text", position: 2, text: "on it" }]);

    const transformed = transformTranscript(projection);
    expect(transformed.declaredLosses).toEqual(["turn_content_unavailable"]);
    expect(transformed.turns).toHaveLength(2);
  });

  it("keeps another run's rows out of this run's transcript", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(1, "mine");
    fixture.log.append(storedEvent(2, "user.message", { runId: OTHER_RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(2, "someone else's");
    // A row naming no run cannot be shown to belong to this one, so it is out.
    fixture.log.append(storedEvent(3, "user.message", { actor: "user" }));
    fixture.contentSource.userTextBySequence.set(3, "unscoped");

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]?.segments).toEqual([{ kind: "text", position: 1, text: "mine" }]);
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

  it("splits assistant turns across a readable-but-empty user row", () => {
    const fixture = makeFixture();
    // Exchange 1's tool result names an enclosing block that none of its own blocks carry. Exchange
    // 2 has a private block with that id. Block ids are exchange-scoped, so if the empty user row
    // did not split the turns, exchange 2's block would wrongly withhold exchange 1's result.
    fixture.log.append(
      storedEvent(1, "tool.invoked", { runId: RUN_ID, toolCallId: "call-1", toolName: "probe" }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(1, "{}");
    fixture.log.append(storedEvent(2, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(2, {
      text: "probe output",
      enclosingReasoningBlockId: "block-reused",
    });
    // A zero-length body, not an unreadable one, is still a role boundary.
    fixture.log.append(storedEvent(3, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(3, "");
    fixture.log.append(storedEvent(4, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(4, [
      {
        blockId: "block-reused",
        reasoningKind: "thinking",
        disclosure: "private",
        text: "second exchange's deliberation",
      },
    ]);
    fixture.log.append(storedEvent(5, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(5, "second answer");

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns.map((turn) => turn.role)).toEqual(["assistant", "assistant"]);
    const firstTurnResult = projection.turns[0]?.segments.find(
      (segment) => segment.kind === "tool_result",
    );
    expect(firstTurnResult?.kind === "tool_result" && firstTurnResult.text).toBe("probe output");
    // No segment of the first turn was replaced by a withheld-enclosure stamp.
    expect(
      projection.turns[0]?.segments.some(
        (segment) => segment.kind === "text" && segment.withheldEnclosure !== undefined,
      ),
    ).toBe(false);
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
      position: 2,
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
});

// --------------------------------------------------------------------------
// The ordered pipeline
// --------------------------------------------------------------------------

describe("transform pipeline — the ordered contract", () => {
  it("repairs a tool call whose result the strip removed, rather than dropping or orphaning it", () => {
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    const transformed: TransformedTranscript = transformTranscript(projection);
    const segments = segmentsOf(transformed.turns);

    const calls = segments.filter((segment) => segment.kind === "tool_call");
    const results = segments.filter((segment) => segment.kind === "tool_result");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      kind: "tool_result",
      // The repair mints its stand-in at the call's position.
      position: 3,
      toolCallId: "call-1",
      outcome: "failed",
      provenance: "repaired",
      text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
    });

    // A reader pairs a call with the result that follows it, so a synthetic result appended at
    // the end of the turn would pass the counts above and still rebuild the wrong history.
    const callTurn = transformed.turns.find((turn) =>
      turn.segments.some((segment) => segment.kind === "tool_call"),
    );
    expect(callTurn).toBeDefined();
    const callIndex = callTurn?.segments.findIndex((segment) => segment.kind === "tool_call") ?? -1;
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(callTurn?.segments[callIndex + 1]).toEqual(results[0]);

    // The private block is gone and both losses are declared, in the contract's order.
    expect(segments.some((segment) => segment.kind === "reasoning")).toBe(false);
    expect(transformed.declaredLosses).toEqual([
      "provider_private_reasoning",
      "tool_call_history_repaired",
    ]);
  });

  function projectionWithStrippedResult(): CanonicalTranscriptProjection {
    const fixture = makeFixture();
    seedInterruptedToolFixture(fixture);
    return fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
  }

  it("repairing BEFORE stripping leaves the call unpaired — the defect the order prevents", () => {
    // Repair before strip: the repair sees a paired call and does nothing, then the strip removes
    // the result it paired against. The canonical order repairs this same fixture.
    let state: TranscriptPipelineState = createTranscriptPipelineState(
      projectionWithStrippedResult(),
    );
    for (const step of [foldTurns, repairPairingIntegrity, stripNonPortableContent]) {
      state = step(state);
    }

    const segments = segmentsOf(state.turns);
    expect(segments.filter((segment) => segment.kind === "tool_call")).toHaveLength(1);
    expect(segments.filter((segment) => segment.kind === "tool_result")).toHaveLength(0);
    expect(state.declaredLosses).not.toContain("tool_call_history_repaired");
  });

  it("strips only the result the private block actually enclosed, not an id-alike in another turn", () => {
    const fixture = makeFixture();
    // Both turns cite the same block id: providers restart block numbering per exchange. The second
    // turn's block is a visible summary, not the private one.
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

    const transformed = transformTranscript(projection);
    const results = segmentsOf(transformed.turns).filter(
      (segment) => segment.kind === "tool_result",
    );
    expect(results).toHaveLength(2);

    // The result the private block really enclosed is dropped and its call repaired.
    expect(results[0]).toEqual({
      kind: "tool_result",
      position: 2,
      toolCallId: "call-private",
      outcome: "failed",
      provenance: "repaired",
      text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
    });

    // The visible turn's result stays verbatim. A strip scoped to the whole transcript would drop
    // it on the id alone and the repair would report a failure the provider never produced.
    expect(results[1]).toEqual({
      kind: "tool_result",
      position: 7,
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
        // A redacted sibling kind: a strip keyed on the kind name would keep this block.
        blockId: "block-private-2",
        reasoningKind: "redacted_thinking",
        disclosure: "private",
        text: "opaque",
      },
    ]);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    const transformed = transformTranscript(projection);
    const segments = segmentsOf(transformed.turns);

    expect(segments).toEqual([{ kind: "text", position: 1, text: "checking the failing suite" }]);
    expect(transformed.declaredLosses).toEqual(["provider_private_reasoning"]);
  });

  it("declares no loss for a transcript that lost nothing", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(1, "hello");
    fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(2, "hi");
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(transformTranscript(projection).declaredLosses).toEqual([]);
  });

  it("keeps a turn whose body was unreadable and declares the loss over it", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    // Seeded, so exactly one turn is unreadable.
    fixture.contentSource.userTextBySequence.set(1, "hello");
    // Not seeded: the content source answers unavailable.
    fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    // The turn is kept; a dropped one would leave the export declaring nothing.
    expect(projection.turns).toHaveLength(2);
    expect(projection.turns[1]?.role).toBe("assistant");
    expect(projection.turns[1]?.segments).toEqual([
      { kind: "text", position: 2, text: "", contentUnavailable: true },
    ]);

    const transformed = transformTranscript(projection);
    expect(transformed.declaredLosses).toEqual(["turn_content_unavailable"]);
    expect(transformed.turns).toHaveLength(2);
  });

  it("declares the loss over an unreadable TOOL body, call and result alike", () => {
    const fixture = makeFixture();
    fixture.log.append(
      storedEvent(1, "tool.invoked", { runId: RUN_ID, toolCallId: "call-1", toolName: "inspect" }),
    );
    fixture.log.append(storedEvent(2, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    const segments = projection.turns.flatMap((turn) => [...turn.segments]);
    // The pairing keys survive; a marker segment would destroy the id the repair uses.
    expect(segments).toEqual([
      {
        kind: "tool_call",
        position: 1,
        toolCallId: "call-1",
        toolName: "inspect",
        argumentsJson: "",
        contentUnavailable: true,
      },
      {
        kind: "tool_result",
        position: 2,
        toolCallId: "call-1",
        outcome: "succeeded",
        provenance: "provider",
        text: "",
        enclosingReasoningBlockId: undefined,
        contentUnavailable: true,
      },
    ]);

    expect(transformTranscript(projection).declaredLosses).toContain("turn_content_unavailable");
  });
});

describe("transform pipeline — a result with no call before it", () => {
  it("re-homes a result that stands BEFORE the call it answers, and declares the repair", () => {
    // Both ids are present, so a membership check would pair them and report no loss while the
    // target gets a result for a call it has not yet seen.
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
              position: 1,
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
              position: 2,
              toolCallId: "call-inverted",
              toolName: "inspect",
              argumentsJson: "{}",
            },
          ],
        },
      ],
    };

    const transformed = transformTranscript(projection);

    // The turn the result vacated is gone; the call's turn carries both, in order, with the
    // provider's own outcome rather than a synthetic failure.
    expect(transformed.turns).toHaveLength(1);
    const invertedPairTurns = transformed.turns;
    expect(invertedPairTurns[0]?.position).toBe(2);
    // Each segment keeps its event's position, so a re-homed answer leaves positions descending.
    expect(invertedPairTurns[0]?.segments).toEqual([
      {
        kind: "tool_call",
        position: 2,
        toolCallId: "call-inverted",
        toolName: "inspect",
        argumentsJson: "{}",
      },
      {
        kind: "tool_result",
        position: 1,
        toolCallId: "call-inverted",
        outcome: "succeeded",
        provenance: "provider",
        text: "answered early",
      },
    ]);
    expect(transformed.declaredLosses).toEqual(["tool_call_history_repaired"]);
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
              position: 1,
              toolCallId: "call-from-another-run",
              outcome: "succeeded",
              provenance: "provider",
              text: "orphaned",
            },
          ],
        },
      ],
    };

    const transformed = transformTranscript(projection);

    expect(transformed.turns).toEqual([]);
    expect(transformed.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });
});

// --------------------------------------------------------------------------
// One call, one result, one identifier
// --------------------------------------------------------------------------

describe("transform pipeline — pairing is one-to-one, on identifiers that are unique", () => {
  const OWNER_ARGUMENTS = '{"target":"one"}';
  const DUPLICATE_ARGUMENTS = '{"target":"two"}';

  function callSegment(position: number, argumentsJson: string): CanonicalTranscriptSegment {
    return {
      kind: "tool_call",
      position,
      toolCallId: "call-shared",
      toolName: "inspect",
      argumentsJson,
    };
  }

  function ownerResult(position: number): CanonicalTranscriptSegment {
    return {
      kind: "tool_result",
      position,
      toolCallId: "call-shared",
      outcome: "succeeded",
      provenance: "provider",
      text: "the answer to the first call",
    };
  }

  // A turn's position is its first segment's, as the fold assigns it; derived so a fixture cannot
  // open a turn where no segment came from.
  function projectionOfTurns(
    turnSegments: readonly (readonly CanonicalTranscriptSegment[])[],
  ): CanonicalTranscriptProjection {
    const positions: number[] = turnSegments.flatMap((segments) =>
      segments.map((segment) => segment.position),
    );
    return {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      builtAtPosition: Math.max(...positions),
      turns: turnSegments.map((segments) => ({
        position: segments[0]?.position ?? 0,
        role: "assistant",
        segments,
      })),
    };
  }

  /**
   * Asserts every transformed call has a distinct identifier and exactly one answer that follows
   * it, and no answer names a missing call.
   */
  function expectOneAnswerPerDistinctCall(transformed: TransformedTranscript): void {
    const segments = segmentsOf(transformed.turns);
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
    positions: {
      readonly ownerCall: number;
      readonly ownerResult: number;
      readonly duplicate: number;
    },
  ): readonly CanonicalTranscriptSegment[] {
    return [
      callSegment(positions.ownerCall, OWNER_ARGUMENTS),
      ownerResult(positions.ownerResult),
      {
        kind: "tool_call",
        position: positions.duplicate,
        toolCallId: duplicateToolCallId,
        toolName: "inspect",
        argumentsJson: DUPLICATE_ARGUMENTS,
      },
      {
        kind: "tool_result",
        // A minted answer takes its call's position.
        position: positions.duplicate,
        toolCallId: duplicateToolCallId,
        outcome: "failed",
        provenance: "repaired",
        text: SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT,
      },
    ];
  }

  it("retains the first answer to a call and drops a second one under its identifier", () => {
    // A provider answers a call once; keeping both answers would export a one-to-many pairing with
    // no declared repair.
    const projection = projectionOfTurns([
      [
        callSegment(1, OWNER_ARGUMENTS),
        ownerResult(2),
        {
          kind: "tool_result",
          position: 3,
          toolCallId: "call-shared",
          outcome: "failed",
          provenance: "provider",
          text: "a second answer to a call already answered",
        },
      ],
    ]);

    const transformed = transformTranscript(projection);

    expect(segmentsOf(transformed.turns)).toEqual([
      callSegment(1, OWNER_ARGUMENTS),
      ownerResult(2),
    ]);
    expectOneAnswerPerDistinctCall(transformed);
    expect(transformed.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });

  it("disambiguates a later call reusing an identifier, when the answer sits between them", () => {
    const projection = projectionOfTurns([
      [callSegment(1, OWNER_ARGUMENTS), ownerResult(2), callSegment(3, DUPLICATE_ARGUMENTS)],
    ]);

    const transformed = transformTranscript(projection);

    // The identifier derives from the duplicate's position; its arguments cross unchanged.
    expect(segmentsOf(transformed.turns)).toEqual(
      repairedDuplicateSegments("call-shared-repaired-2", {
        ownerCall: 1,
        ownerResult: 2,
        duplicate: 3,
      }),
    );
    expectOneAnswerPerDistinctCall(transformed);
    expect(transformed.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });

  it("disambiguates a later call reusing an identifier, when the answer follows both", () => {
    // The owner's answer is pulled up beside it, so a target pairing a call with the following
    // result cannot read the duplicate's synthetic failure as the first call's outcome.
    const projection = projectionOfTurns([
      [callSegment(1, OWNER_ARGUMENTS)],
      [callSegment(2, DUPLICATE_ARGUMENTS)],
      [ownerResult(3)],
    ]);

    const transformed = transformTranscript(projection);
    const turns = transformed.turns;

    expect(segmentsOf(turns)).toEqual(
      repairedDuplicateSegments("call-shared-repaired-1", {
        ownerCall: 1,
        ownerResult: 3,
        duplicate: 2,
      }),
    );
    // The turn the answer vacated is empty and gone.
    expect(turns.map((turn) => turn.position)).toEqual([1, 2]);
    expectOneAnswerPerDistinctCall(transformed);
    expect(transformed.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });

  it("derives the same disambiguated identifier on every export of one transcript", () => {
    const projection = projectionOfTurns([
      [callSegment(1, OWNER_ARGUMENTS)],
      [callSegment(2, DUPLICATE_ARGUMENTS)],
      [ownerResult(3)],
    ]);

    // A counter or random value would make the second export unrecognizable to a target that saw
    // the first.
    expect(transformTranscript(projection)).toEqual(transformTranscript(projection));
  });

  it("mints an identifier the transcript does not already spend", () => {
    // The composed name is not reserved, so a provider may have used it; a collision with a real
    // call would recreate the defect.
    const projection = projectionOfTurns([
      [
        callSegment(1, OWNER_ARGUMENTS),
        callSegment(2, DUPLICATE_ARGUMENTS),
        {
          kind: "tool_call",
          position: 3,
          toolCallId: "call-shared-repaired-1",
          toolName: "inspect",
          argumentsJson: '{"target":"three"}',
        },
        ownerResult(4),
      ],
    ]);

    const transformed = transformTranscript(projection);
    const callIds = segmentsOf(transformed.turns)
      .filter((segment) => segment.kind === "tool_call")
      .map((segment) => (segment.kind === "tool_call" ? segment.toolCallId : ""));

    expect(callIds).toEqual(["call-shared", "call-shared-repaired-1-1", "call-shared-repaired-1"]);
    expectOneAnswerPerDistinctCall(transformed);
  });
});

// --------------------------------------------------------------------------
// The bound
// --------------------------------------------------------------------------

/** Four turns of alternating roles: 1 and 3 are the user's, 2 and 4 the assistant's. */
function seedFourTurnFixture(fixture: TranscriptFixture): void {
  fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
  fixture.contentSource.userTextBySequence.set(1, "first question");
  fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
  fixture.contentSource.assistantTextBySequence.set(2, "first answer");
  fixture.log.append(storedEvent(3, "user.message", { runId: RUN_ID, actor: "user" }));
  fixture.contentSource.userTextBySequence.set(3, "second question");
  fixture.log.append(storedEvent(4, "assistant.message", { runId: RUN_ID }));
  fixture.contentSource.assistantTextBySequence.set(4, "second answer");
}

function transformedPositions(transformed: TransformedTranscript): number[] {
  return transformed.turns.map((turn) => turn.position);
}

function transformedText(transformed: TransformedTranscript): string {
  return segmentsOf(transformed.turns)
    .map((segment) => (segment.kind === "text" ? segment.text : ""))
    .join("\n");
}

describe("transform pipeline — a bounded export carries only what the bound admits", () => {
  it("renders no turn past the bound, and the whole projection when there is none", () => {
    const fixture = makeFixture();
    seedFourTurnFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    const bounded: TransformedTranscript = transformTranscript(
      boundProjectionToPosition(projection, 2),
    );
    const whole: TransformedTranscript = transformTranscript(projection);

    expect(transformedPositions(bounded)).toEqual([1, 2]);
    // Checked on rendered content, not only frame count: a bound that filtered positions but left
    // later text in the export would still leak it.
    expect(transformedText(bounded)).toContain("first answer");
    expect(transformedText(bounded)).not.toContain("second question");
    expect(transformedText(bounded)).not.toContain("second answer");

    expect(transformedPositions(whole)).toEqual([1, 2, 3, 4]);
    expect(transformedText(whole)).toContain("second answer");
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
    // The real answer arrives in the next turn, outside the bound below.
    fixture.log.append(storedEvent(3, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(3, { text: "the file contents" });
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    const bounded: TransformedTranscript = transformTranscript(
      boundProjectionToPosition(projection, 1),
    );
    const segments = segmentsOf(bounded.turns);

    // Bounding must precede the repair: after it, the call would pair with the out-of-bound result
    // and an unanswered call would reach the target under no declared loss.
    expect(segments.filter((segment) => segment.kind === "tool_call")).toHaveLength(1);
    expect(segments.filter((segment) => segment.kind === "tool_result")).toEqual([
      {
        kind: "tool_result",
        position: 1,
        toolCallId: "call-1",
        outcome: "failed",
        provenance: "repaired",
        text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
      },
    ]);
    expect(transformedText(bounded)).not.toContain("the file contents");
    expect(bounded.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });

  it("withholds content a turn coalesced from past the bound, not just whole turns", () => {
    const fixture = makeFixture();
    // With no turn marker between them the fold coalesces these rows into one turn positioned at
    // the first. The later row is an unkeyed tool answer, which rides a text segment and survives
    // every later step, so no strip or repair can hide a leak.
    fixture.log.append(storedEvent(5, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(5, "the suite is green");
    fixture.log.append(storedEvent(7, "tool.result", { runId: RUN_ID }));
    fixture.contentSource.toolResultBodyBySequence.set(7, { text: "the leaked follow-up" });
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    // Premise: one turn, opened at 5, holding content from both 5 and 7.
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]?.position).toBe(5);
    expect(projection.turns[0]?.segments.map((segment) => segment.position)).toEqual([5, 7]);

    const bounded = transformTranscript(boundProjectionToPosition(projection, 5));
    const turns = bounded.turns;

    // A bound read off the turn's position would keep the turn whole and carry the position-7 body.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.position).toBe(5);
    expect(turns[0]?.segments.map((segment) => segment.position)).toEqual([5]);
    expect(transformedText(bounded)).toContain("the suite is green");
    expect(transformedText(bounded)).not.toContain("the leaked follow-up");
  });

  it("withholds an in-bound answer whose private block is logged past the bound", () => {
    // The answer is inside the bound and the private block that withholds it is outside. A fold
    // that stopped at the bound would never meet that block, and the body would ship.
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(1, "run the tests");
    fixture.log.append(
      storedEvent(2, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "run_tests",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(2, '{"suite":"unit"}');
    fixture.log.append(storedEvent(3, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(3, {
      text: "42 passed",
      enclosingReasoningBlockId: "block-private-1",
    });
    fixture.log.append(storedEvent(4, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(4, [
      {
        blockId: "block-private-1",
        reasoningKind: "thinking",
        disclosure: "private",
        text: "internal deliberation",
      },
    ]);

    const request = { sessionId: SESSION_ID, runId: RUN_ID };
    const whole = fixture.fold.build(request);
    const foldedToThree = fixture.fold.build({ ...request, boundary: 3 });

    // Premise: the bound keeps the answer and cuts the block that classifies it.
    expect(
      foldedToThree.turns.flatMap((turn) => turn.segments).map((segment) => segment.position),
    ).toEqual([1, 2, 3]);

    expect(boundProjectionToPosition(whole, 3)).toEqual(foldedToThree);

    // The equality above would also hold if both paths shipped the body; this says they withhold.
    expect(transformedToolResultTexts(transformTranscript(foldedToThree))).not.toContain(
      "42 passed",
    );
  });

  it("withholds an over-bound answer whose private block is logged inside the bound", () => {
    // The block is inside the bound and the answer it encloses is outside. The fold reads past the
    // bound, and the over-bound answer must not return on the strength of an in-bound block.
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(1, "run the tests");
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
      storedEvent(3, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "run_tests",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(3, '{"suite":"unit"}');
    fixture.log.append(storedEvent(4, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(4, {
      text: "42 passed",
      enclosingReasoningBlockId: "block-private-1",
    });

    const request = { sessionId: SESSION_ID, runId: RUN_ID };
    const whole = fixture.fold.build(request);
    const foldedToThree = fixture.fold.build({ ...request, boundary: 3 });

    expect(
      foldedToThree.turns.flatMap((turn) => turn.segments).map((segment) => segment.position),
    ).toEqual([1, 2, 3]);
    expect(boundProjectionToPosition(whole, 3)).toEqual(foldedToThree);
    expect(transformedToolResultTexts(transformTranscript(foldedToThree))).not.toContain(
      "42 passed",
    );
  });

  it("repairs a call the bound admits whose answer it does not, inside one folded turn", () => {
    const fixture = makeFixture();
    // Call and answer coalesce into one turn, so the bound must reach inside it to split them.
    fixture.log.append(
      storedEvent(1, "tool.invoked", { runId: RUN_ID, toolCallId: "call-1", toolName: "read" }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(1, '{"path":"notes.md"}');
    fixture.log.append(storedEvent(2, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(2, { text: "the file contents" });
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    expect(projection.turns).toHaveLength(1);

    const bounded = transformTranscript(boundProjectionToPosition(projection, 1));
    const segments = segmentsOf(bounded.turns);

    // The call survives the bound orphaned and the repair answers it with a stand-in at the call's
    // own position, which the bound already admits.
    expect(segments).toEqual([
      {
        kind: "tool_call",
        position: 1,
        toolCallId: "call-1",
        toolName: "read",
        argumentsJson: '{"path":"notes.md"}',
      },
      {
        kind: "tool_result",
        position: 1,
        toolCallId: "call-1",
        outcome: "failed",
        provenance: "repaired",
        text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
      },
    ]);
    expect(transformedText(bounded)).not.toContain("the file contents");
    expect(bounded.declaredLosses).toEqual(["tool_call_history_repaired"]);
  });
});

// --------------------------------------------------------------------------
// Tool rows that name no call identifier
// --------------------------------------------------------------------------

describe("canonical transcript fold — a tool row naming no call identifier", () => {
  it("carries the invocation and its answer as content instead of dropping both", () => {
    const fixture = makeFixture();
    // Neither row names a call identifier.
    fixture.log.append(storedEvent(1, "tool.invoked", { runId: RUN_ID, toolName: "read_file" }));
    fixture.contentSource.toolArgumentsBySequence.set(1, '{"path":"notes.md"}');
    fixture.log.append(storedEvent(2, "tool.result", { runId: RUN_ID }));
    fixture.contentSource.toolResultBodyBySequence.set(2, { text: "the file contents" });

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const transformed: TransformedTranscript = transformTranscript(projection);

    // A silent drop is an empty export declaring nothing; both halves are checked.
    expect(transformed.turns).not.toEqual([]);
    expect(transformed.turns).toHaveLength(1);
    // The exact text a target receives: it must read as tool activity, not assistant prose.
    expect(
      segmentsOf(transformed.turns).map((segment) => (segment.kind === "text" ? segment.text : "")),
    ).toEqual([
      '[tool call read_file] {"path":"notes.md"}',
      "[tool result succeeded] the file contents",
    ]);
    // Nothing was lost, so nothing is declared; the row rides text, so no identifier is minted.
    expect(transformed.declaredLosses).toEqual([]);
    expect(segmentsOf(transformed.turns).map((segment) => segment.kind)).toEqual(["text", "text"]);
  });

  it("names a failed answer as failed rather than borrowing the succeeded wording", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "tool.error", { runId: RUN_ID }));
    fixture.contentSource.toolResultBodyBySequence.set(1, { text: "permission denied" });

    const transformed: TransformedTranscript = transformTranscript(
      fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
    );

    expect(
      segmentsOf(transformed.turns).map((segment) => (segment.kind === "text" ? segment.text : "")),
    ).toEqual(["[tool result failed] permission denied"]);
    expect(transformed.declaredLosses).toEqual([]);
  });

  it("withholds an unkeyed answer inside a private block, keeping the rest of its turn in order", () => {
    const fixture = makeFixture();
    // A text segment carries no enclosure, so rendering the body as text would slip past the
    // strip. The turn close replaces the answer in place; the other segments keep their content
    // and log order.
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
    fixture.log.append(storedEvent(3, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(3, "all green");

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const transformed: TransformedTranscript = transformTranscript(projection);

    // The answer settles to a `withheldEnclosure` marker, not `contentUnavailable`: the body was
    // read, then withheld on purpose.
    expect(projection.turns.flatMap((turn) => turn.segments)).toEqual([
      {
        kind: "reasoning",
        position: 1,
        blockId: "block-1",
        reasoningKind: "thinking",
        disclosure: "private",
        text: "internal deliberation",
      },
      { kind: "text", position: 2, text: "", withheldEnclosure: "private" },
      { kind: "text", position: 3, text: "all green" },
    ]);
    expect(transformedText(transformed)).not.toContain("private notes");
    expect(transformedText(transformed)).not.toContain("internal deliberation");
    expect(transformedText(transformed)).toContain("all green");
    // One loss even though the private block and its marker both reach the strip.
    expect(transformed.declaredLosses).toEqual(["provider_private_reasoning"]);
  });

  it("declares the withheld enclosure across a bound that cuts away the private block", () => {
    const fixture = makeFixture();
    // The answer is logged before the reasoning row that encloses it, so a bound at the answer
    // keeps it while cutting the only sibling that could classify it. The marker keeps the
    // result's position and is the one carrier of the loss the bounded export can still see.
    fixture.log.append(storedEvent(1, "tool.result", { runId: RUN_ID }));
    fixture.contentSource.toolResultBodyBySequence.set(1, {
      text: "private notes",
      enclosingReasoningBlockId: "block-1",
    });
    fixture.log.append(storedEvent(2, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(2, [
      {
        blockId: "block-1",
        reasoningKind: "thinking",
        disclosure: "private",
        text: "internal deliberation",
      },
    ]);

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    // The late-logged block resolves against the early answer, leaving the marker at its position.
    expect(projection.turns.flatMap((turn) => turn.segments)).toEqual([
      { kind: "text", position: 1, text: "", withheldEnclosure: "private" },
      {
        kind: "reasoning",
        position: 2,
        blockId: "block-1",
        reasoningKind: "thinking",
        disclosure: "private",
        text: "internal deliberation",
      },
    ]);

    const transformed: TransformedTranscript = transformTranscript(
      boundProjectionToPosition(projection, 1),
    );

    // The loss is declared even though the private block is outside the bound.
    expect(transformed.declaredLosses).toEqual(["provider_private_reasoning"]);
    expect(transformedText(transformed)).not.toContain("private notes");
    expect(transformedText(transformed)).not.toContain("internal deliberation");
    // The marker never renders: the strip consumed it, and its turn went with it.
    expect(transformed.turns).toEqual([]);
  });

  it("carries an unkeyed answer the provider emitted inside a summary block", () => {
    const fixture = makeFixture();
    // A summary block is history the user already read, so the answer inside it is portable;
    // withholding it would drop the body and declare a loss that did not happen.
    fixture.log.append(storedEvent(1, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(1, [
      {
        blockId: "block-1",
        reasoningKind: "summary",
        disclosure: "summary",
        text: "checking the test suite",
      },
    ]);
    fixture.log.append(storedEvent(2, "tool.result", { runId: RUN_ID }));
    fixture.contentSource.toolResultBodyBySequence.set(2, {
      text: "42 tests passed",
      enclosingReasoningBlockId: "block-1",
    });

    const transformed: TransformedTranscript = transformTranscript(
      fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
    );

    expect(transformedText(transformed)).toContain("[tool result succeeded] 42 tests passed");
    expect(transformed.declaredLosses).toEqual([]);
  });

  it("carries an unkeyed answer logged before the summary block that enclosed it", () => {
    const fixture = makeFixture();
    // The answer is logged before the summary block that enclosed it, which a row-by-row lookup
    // would miss, withholding portable content and declaring a loss.
    fixture.log.append(storedEvent(1, "tool.result", { runId: RUN_ID }));
    fixture.contentSource.toolResultBodyBySequence.set(1, {
      text: "42 tests passed",
      enclosingReasoningBlockId: "block-1",
    });
    fixture.log.append(storedEvent(2, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(2, [
      {
        blockId: "block-1",
        reasoningKind: "summary",
        disclosure: "summary",
        text: "checking the test suite",
      },
    ]);

    const transformed: TransformedTranscript = transformTranscript(
      fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
    );

    expect(transformedText(transformed)).toContain("[tool result succeeded] 42 tests passed");
    expect(transformed.declaredLosses).toEqual([]);
  });

  it("withholds an unkeyed answer citing a block its own turn does not carry", () => {
    const fixture = makeFixture();
    // The summary block is in an earlier turn, so this turn cannot tell the citation's disclosure.
    // Rendering to text would erase the enclosure, so unknown fails closed.
    fixture.log.append(storedEvent(1, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(1, [
      {
        blockId: "block-1",
        reasoningKind: "summary",
        disclosure: "summary",
        text: "checking the test suite",
      },
    ]);
    fixture.log.append(storedEvent(2, "run.turn_started", { runId: RUN_ID }));
    fixture.log.append(storedEvent(3, "tool.result", { runId: RUN_ID }));
    fixture.contentSource.toolResultBodyBySequence.set(3, {
      text: "42 tests passed",
      enclosingReasoningBlockId: "block-1",
    });

    const transformed: TransformedTranscript = transformTranscript(
      fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
    );

    expect(transformedText(transformed)).not.toContain("42 tests passed");
    expect(transformed.declaredLosses).toContain("turn_content_unavailable");
  });

  it("marks a reasoning row whose blocks could not be read", () => {
    const fixture = makeFixture();
    // No blocks seeded means unreadable, not absent; an empty list would let summary reasoning
    // leave the export in silence.
    fixture.log.append(storedEvent(1, "assistant.thinking_update", { runId: RUN_ID }));

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns[0]?.segments).toEqual([
      { kind: "text", position: 1, text: "", contentUnavailable: true },
    ]);
    expect(transformTranscript(projection).declaredLosses).toEqual(["turn_content_unavailable"]);
  });

  it("keeps a reasoning row that carried no blocks apart from one it could not read", () => {
    const fixture = makeFixture();
    // An empty list is a row that carried nothing: no segment and no declared loss.
    fixture.log.append(storedEvent(1, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(1, []);
    fixture.log.append(storedEvent(2, "assistant.message", { runId: RUN_ID }));
    fixture.contentSource.assistantTextBySequence.set(2, "done");

    const transformed: TransformedTranscript = transformTranscript(
      fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID }),
    );

    expect(transformedText(transformed)).toBe("done");
    expect(transformed.declaredLosses).toEqual([]);
  });

  it("marks an unkeyed invocation whose arguments could not be read", () => {
    const fixture = makeFixture();
    // No arguments seeded: the body is unreadable and the fold must not invent one.
    fixture.log.append(storedEvent(1, "tool.invoked", { runId: RUN_ID, toolName: "read_file" }));

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(projection.turns[0]?.segments).toEqual([
      { kind: "text", position: 1, text: "", contentUnavailable: true },
    ]);
    expect(transformTranscript(projection).declaredLosses).toEqual(["turn_content_unavailable"]);
  });
});

// --------------------------------------------------------------------------
// An enclosure the fold could not resolve travels nowhere
// --------------------------------------------------------------------------

// The strip judges a keyed tool result's portability from the reasoning segments beside it in the
// same turn. When that block is unreadable or cut away by a bound, its disclosure is unknowable,
// and keeping the result could export private reasoning's output to a target.

/** The bodies the transformed tool results carry; `transformedText` reads text segments only. */
function transformedToolResultTexts(transformed: TransformedTranscript): string[] {
  return segmentsOf(transformed.turns).flatMap((segment) =>
    segment.kind === "tool_result" ? [segment.text] : [],
  );
}

describe("transform pipeline — a result whose enclosure cannot be resolved is withheld", () => {
  /** The interrupted-tool shape, but the reasoning row is in the log and unreadable. */
  function seedUnreadableEnclosureFixture(fixture: TranscriptFixture): void {
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(1, "run the tests");
    // In the log but not in the content source.
    fixture.log.append(storedEvent(2, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.log.append(
      storedEvent(3, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "run_tests",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(3, '{"suite":"unit"}');
    fixture.log.append(storedEvent(4, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(4, {
      text: "42 passed",
      enclosingReasoningBlockId: "block-private-1",
    });
  }

  it("withholds a result enclosed by reasoning the fold could not read", () => {
    const fixture = makeFixture();
    seedUnreadableEnclosureFixture(fixture);

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const transformed: TransformedTranscript = transformTranscript(projection);

    // The body never reaches the target; its call survives and the pairing repair answers it.
    expect(transformedToolResultTexts(transformed)).not.toContain("42 passed");
    expect(segmentsOf(transformed.turns)).toContainEqual(
      expect.objectContaining({
        kind: "tool_result",
        text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
      }),
    );
    // Declared, so a withheld body is not read as a transcript that dropped nothing.
    expect(transformed.declaredLosses).toContain("turn_content_unavailable");
    // Not reported as private reasoning: the block was never read, so its disclosure is unknown.
    expect(transformed.declaredLosses).not.toContain("provider_private_reasoning");
  });

  /** The private block is logged after the answer it enclosed, and a bound falls between them. */
  function seedLateBlockFixture(fixture: TranscriptFixture): void {
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(1, "run the tests");
    fixture.log.append(
      storedEvent(2, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "run_tests",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(2, '{"suite":"unit"}');
    fixture.log.append(storedEvent(3, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(3, {
      text: "42 passed",
      enclosingReasoningBlockId: "block-private-1",
    });
    fixture.log.append(storedEvent(4, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(4, [
      {
        blockId: "block-private-1",
        reasoningKind: "thinking",
        disclosure: "private",
        text: "internal deliberation",
      },
    ]);
  }

  it("withholds it under a bound that cuts the enclosing block away", () => {
    const fixture = makeFixture();
    seedLateBlockFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    // The bound admits the result but not the block, the only segment that could classify it.
    const bounded: CanonicalTranscriptProjection = boundProjectionToPosition(projection, 3);
    expect(
      bounded.turns
        .flatMap((turn) => turn.segments)
        .some((segment) => segment.kind === "reasoning"),
    ).toBe(false);

    expect(transformedToolResultTexts(transformTranscript(bounded))).not.toContain("42 passed");
  });

  it("keeps a result whose summary enclosure a bound cuts away", () => {
    // A summary block is portable, so the fold records nothing for it and the strip keeps the
    // result even when the bound cuts the block away. Only a withholding resolution needs a
    // carrier that outlives the bound.
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(1, "run the tests");
    fixture.log.append(
      storedEvent(2, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "run_tests",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(2, '{"suite":"unit"}');
    fixture.log.append(storedEvent(3, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(3, {
      text: "42 passed",
      enclosingReasoningBlockId: "block-summary-1",
    });
    fixture.log.append(storedEvent(4, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(4, [
      {
        blockId: "block-summary-1",
        reasoningKind: "thinking",
        disclosure: "summary",
        text: "checking the suite",
      },
    ]);

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const bounded: CanonicalTranscriptProjection = boundProjectionToPosition(projection, 3);

    expect(transformedToolResultTexts(transformTranscript(bounded))).toContain("42 passed");
  });
  it("keeps a result citing a block from another turn", () => {
    // A citation across a turn boundary is not an enclosure, and this turn read its own reasoning
    // in full, so nothing is unknown and nothing is withheld.
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(1, [
      {
        blockId: "block-private-1",
        reasoningKind: "thinking",
        disclosure: "private",
        text: "internal deliberation",
      },
    ]);
    fixture.log.append(storedEvent(2, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(2, "and the tests?");
    fixture.log.append(
      storedEvent(3, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "run_tests",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(3, '{"suite":"unit"}');
    fixture.log.append(storedEvent(4, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(4, {
      text: "42 passed",
      enclosingReasoningBlockId: "block-private-1",
    });

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(transformedToolResultTexts(transformTranscript(projection))).toContain("42 passed");
  });

  /**
   * One block id carried twice in a turn under disagreeing disclosures, with a bound between the
   * answer and both blocks. Block ids need not be unique within a turn, and a last-write-wins
   * resolution would let the later summary overwrite the private stamp.
   */
  function seedDisagreeingDuplicateBlockFixture(fixture: TranscriptFixture): void {
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(1, "run the tests");
    fixture.log.append(
      storedEvent(2, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "run_tests",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(2, '{"suite":"unit"}');
    fixture.log.append(storedEvent(3, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(3, {
      text: "42 passed",
      enclosingReasoningBlockId: "block-1",
    });
    fixture.log.append(storedEvent(4, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(4, [
      {
        blockId: "block-1",
        reasoningKind: "thinking",
        disclosure: "private",
        text: "internal deliberation",
      },
    ]);
    fixture.log.append(storedEvent(5, "assistant.thinking_update", { runId: RUN_ID }));
    fixture.contentSource.reasoningBlocksBySequence.set(5, [
      {
        blockId: "block-1",
        reasoningKind: "thinking",
        disclosure: "summary",
        text: "checking the suite",
      },
    ]);
  }

  it("withholds it when the turn carries that block id twice under disagreeing disclosures", () => {
    const fixture = makeFixture();
    seedDisagreeingDuplicateBlockFixture(fixture);
    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    // Premise: the bound cuts both occurrences, so the fold's stamp is the only thing left that can
    // withhold.
    const bounded: CanonicalTranscriptProjection = boundProjectionToPosition(projection, 3);
    expect(
      bounded.turns
        .flatMap((turn) => turn.segments)
        .some((segment) => segment.kind === "reasoning"),
    ).toBe(false);

    // The result names its enclosure by block id alone, so the disagreement resolves to unknown and
    // the body does not travel.
    expect(transformedToolResultTexts(transformTranscript(bounded))).not.toContain("42 passed");
  });

  it("keeps it when a repeated block id agrees on its disclosure", () => {
    // Occurrences that agree answer the citation identically; withholding on a duplicate id alone
    // would drop portable content.
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(1, "run the tests");
    fixture.log.append(
      storedEvent(2, "tool.invoked", {
        runId: RUN_ID,
        toolCallId: "call-1",
        toolName: "run_tests",
      }),
    );
    fixture.contentSource.toolArgumentsBySequence.set(2, '{"suite":"unit"}');
    fixture.log.append(storedEvent(3, "tool.result", { runId: RUN_ID, toolCallId: "call-1" }));
    fixture.contentSource.toolResultBodyBySequence.set(3, {
      text: "42 passed",
      enclosingReasoningBlockId: "block-1",
    });
    for (const sequence of [4, 5]) {
      fixture.log.append(storedEvent(sequence, "assistant.thinking_update", { runId: RUN_ID }));
      fixture.contentSource.reasoningBlocksBySequence.set(sequence, [
        {
          blockId: "block-1",
          reasoningKind: "thinking",
          disclosure: "summary",
          text: "checking the suite",
        },
      ]);
    }

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
    const bounded: CanonicalTranscriptProjection = boundProjectionToPosition(projection, 3);

    expect(transformedToolResultTexts(transformTranscript(bounded))).toContain("42 passed");
  });
});
