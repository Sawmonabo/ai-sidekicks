// The canonical transcript fold and its transform: no logged row is silently lost, no private
// reasoning or content past the bound leaves, and every carried tool call keeps exactly one answer.

import { describe, expect, it } from "vitest";

import {
  boundProjectionToPosition,
  type TranscriptReasoningBlock,
} from "../canonical-transcript.js";
import {
  SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
  SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT,
  transformTranscript,
  type TransformedTranscript,
} from "../transform-pipeline.js";
import {
  OTHER_RUN_ID,
  RUN_ID,
  SESSION_ID,
  makeFixture,
  storedEvent,
} from "./transcript-log-test-doubles.js";
import type {
  CanonicalTranscriptProjection,
  CanonicalTranscriptSegment,
  CanonicalTranscriptTurn,
} from "../../provider-driver.js";

// Fixtures

/** One row of this run's log; a row whose body is omitted is one the content port cannot read. */
type LogRow =
  | { readonly kind: "user" | "assistant"; readonly text?: string }
  | { readonly kind: "reasoning"; readonly blocks?: readonly TranscriptReasoningBlock[] }
  | { readonly kind: "turn-start" }
  | {
      readonly kind: "call";
      readonly toolCallId?: string;
      readonly toolName: string;
      readonly argumentsJson?: string;
    }
  | {
      readonly kind: "result";
      readonly toolCallId?: string;
      readonly failed?: boolean;
      readonly text?: string;
      readonly enclosingReasoningBlockId?: string;
    };

/** Logs `rows` at sequences 1, 2, 3… and folds them, bounded to `boundary` when one is given. */
function foldLog(rows: readonly LogRow[], boundary?: number): CanonicalTranscriptProjection {
  const fixture = makeFixture();
  rows.forEach((row, index) => {
    const sequence = index + 1;
    const ownRun = { runId: RUN_ID };
    switch (row.kind) {
      case "user":
        fixture.log.append(storedEvent(sequence, "user.message", { ...ownRun, actor: "user" }));
        if (row.text !== undefined)
          fixture.contentSource.userTextBySequence.set(sequence, row.text);
        return;
      case "assistant":
        fixture.log.append(storedEvent(sequence, "assistant.message", ownRun));
        if (row.text !== undefined) {
          fixture.contentSource.assistantTextBySequence.set(sequence, row.text);
        }
        return;
      case "reasoning":
        fixture.log.append(storedEvent(sequence, "assistant.thinking_update", ownRun));
        if (row.blocks !== undefined) {
          fixture.contentSource.reasoningBlocksBySequence.set(sequence, row.blocks);
        }
        return;
      case "turn-start":
        fixture.log.append(storedEvent(sequence, "run.turn_started", ownRun));
        return;
      case "call":
        fixture.log.append(
          storedEvent(sequence, "tool.invoked", {
            ...ownRun,
            toolName: row.toolName,
            ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
          }),
        );
        if (row.argumentsJson !== undefined) {
          fixture.contentSource.toolArgumentsBySequence.set(sequence, row.argumentsJson);
        }
        return;
      case "result":
        fixture.log.append(
          storedEvent(sequence, row.failed === true ? "tool.error" : "tool.result", {
            ...ownRun,
            ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
          }),
        );
        if (row.text !== undefined) {
          fixture.contentSource.toolResultBodyBySequence.set(sequence, {
            text: row.text,
            enclosingReasoningBlockId: row.enclosingReasoningBlockId,
          });
        }
        return;
    }
  });
  const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });
  return boundary === undefined ? projection : boundProjectionToPosition(projection, boundary);
}

function privateBlock(blockId: string): TranscriptReasoningBlock {
  return {
    blockId,
    reasoningKind: "thinking",
    disclosure: "private",
    text: "internal deliberation",
  };
}

function summaryBlock(blockId: string): TranscriptReasoningBlock {
  return { blockId, reasoningKind: "thinking", disclosure: "summary", text: "checking the suite" };
}

type ToolCallSegment = Extract<CanonicalTranscriptSegment, { kind: "tool_call" }>;
type ToolResultSegment = Extract<CanonicalTranscriptSegment, { kind: "tool_result" }>;

function segmentsOf(turns: readonly CanonicalTranscriptTurn[]): CanonicalTranscriptSegment[] {
  return turns.flatMap((turn) => [...turn.segments]);
}

/** Every body the transformed transcript would hand a target, whatever segment carries it. */
function everyTextIn(transformed: TransformedTranscript): string {
  return segmentsOf(transformed.turns)
    .map((segment) => {
      switch (segment.kind) {
        case "tool_call":
          return segment.argumentsJson;
        default:
          return segment.text;
      }
    })
    .join("\n");
}

function toolCall(position: number, toolCallId: string, argumentsJson = "{}"): ToolCallSegment {
  return { kind: "tool_call", position, toolCallId, toolName: "inspect", argumentsJson };
}

function providerResult(position: number, toolCallId: string, text: string): ToolResultSegment {
  return {
    kind: "tool_result",
    position,
    toolCallId,
    outcome: "succeeded",
    provenance: "provider",
    text,
  };
}

/** The stand-in the pairing repair mints, at its call's position. */
function repairedResult(position: number, toolCallId: string, text: string): ToolResultSegment {
  return {
    kind: "tool_result",
    position,
    toolCallId,
    outcome: "failed",
    provenance: "repaired",
    text,
  };
}

// The fold

describe("canonical transcript fold", () => {
  it("keeps another run's rows, and rows naming no run, out of this run's transcript", () => {
    const fixture = makeFixture();
    fixture.log.append(storedEvent(1, "user.message", { runId: RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(1, "mine");
    fixture.log.append(storedEvent(2, "user.message", { runId: OTHER_RUN_ID, actor: "user" }));
    fixture.contentSource.userTextBySequence.set(2, "someone else's");
    fixture.log.append(storedEvent(3, "user.message", { actor: "user" }));
    fixture.contentSource.userTextBySequence.set(3, "unscoped");

    const projection = fixture.fold.build({ sessionId: SESSION_ID, runId: RUN_ID });

    expect(segmentsOf(projection.turns)).toEqual([{ kind: "text", position: 1, text: "mine" }]);
  });

  it("carries every row as what it was, or keeps its place and declares it unreadable", () => {
    // A dropped row reads to the target as a turn that never happened and declares nothing; a
    // failed tool rendered as succeeded rewrites history.
    const cases: readonly {
      readonly name: string;
      readonly rows: readonly LogRow[];
      readonly roles: readonly ("user" | "assistant")[];
      readonly segments: readonly CanonicalTranscriptSegment[];
      readonly declaredLosses: readonly string[];
    }[] = [
      {
        name: "an unreadable user turn",
        rows: [{ kind: "user" }, { kind: "assistant", text: "on it" }],
        roles: ["user", "assistant"],
        segments: [
          { kind: "text", position: 1, text: "", contentUnavailable: true },
          { kind: "text", position: 2, text: "on it" },
        ],
        declaredLosses: ["turn_content_unavailable"],
      },
      {
        name: "an unreadable assistant turn",
        rows: [{ kind: "user", text: "hello" }, { kind: "assistant" }],
        roles: ["user", "assistant"],
        segments: [
          { kind: "text", position: 1, text: "hello" },
          { kind: "text", position: 2, text: "", contentUnavailable: true },
        ],
        declaredLosses: ["turn_content_unavailable"],
      },
      {
        // The pairing keys survive; a marker segment in their place would orphan the pair.
        name: "an unreadable tool call and result",
        rows: [
          { kind: "call", toolCallId: "call-1", toolName: "inspect" },
          { kind: "result", toolCallId: "call-1" },
        ],
        roles: ["assistant"],
        segments: [
          { ...toolCall(1, "call-1", ""), contentUnavailable: true },
          { ...providerResult(2, "call-1", ""), contentUnavailable: true },
        ],
        declaredLosses: ["turn_content_unavailable"],
      },
      {
        name: "a reasoning row whose blocks could not be read",
        rows: [{ kind: "reasoning" }],
        roles: ["assistant"],
        segments: [{ kind: "text", position: 1, text: "", contentUnavailable: true }],
        declaredLosses: ["turn_content_unavailable"],
      },
      {
        name: "an unkeyed invocation whose arguments could not be read",
        rows: [{ kind: "call", toolName: "read_file" }],
        roles: ["assistant"],
        segments: [{ kind: "text", position: 1, text: "", contentUnavailable: true }],
        declaredLosses: ["turn_content_unavailable"],
      },
      {
        // Rows naming no call identifier ride text that reads as tool activity, not prose.
        name: "an unkeyed invocation and its answer",
        rows: [
          { kind: "call", toolName: "read_file", argumentsJson: '{"path":"notes.md"}' },
          { kind: "result", text: "the file contents" },
        ],
        roles: ["assistant"],
        segments: [
          { kind: "text", position: 1, text: '[tool call read_file] {"path":"notes.md"}' },
          { kind: "text", position: 2, text: "[tool result succeeded] the file contents" },
        ],
        declaredLosses: [],
      },
      {
        name: "an unkeyed failed answer",
        rows: [{ kind: "result", failed: true, text: "permission denied" }],
        roles: ["assistant"],
        segments: [{ kind: "text", position: 1, text: "[tool result failed] permission denied" }],
        declaredLosses: [],
      },
      {
        name: "a keyed failed answer",
        rows: [
          { kind: "call", toolCallId: "call-1", toolName: "inspect", argumentsJson: "{}" },
          { kind: "result", toolCallId: "call-1", failed: true, text: "no such file" },
        ],
        roles: ["assistant"],
        segments: [
          toolCall(1, "call-1"),
          { ...providerResult(2, "call-1", "no such file"), outcome: "failed" },
        ],
        declaredLosses: [],
      },
    ];

    for (const rowCase of cases) {
      const transformed = transformTranscript(foldLog(rowCase.rows));
      expect(
        transformed.turns.map((turn) => turn.role),
        rowCase.name,
      ).toEqual(rowCase.roles);
      expect(segmentsOf(transformed.turns), rowCase.name).toEqual(rowCase.segments);
      expect(transformed.declaredLosses, rowCase.name).toEqual(rowCase.declaredLosses);
    }
  });
});

// Private reasoning

describe("transform pipeline — private reasoning never leaves", () => {
  it(
    "strips private reasoning by its disclosure " +
      "and answers the call whose result went with it",
    () => {
      const transformed = transformTranscript(
        foldLog([
          { kind: "user", text: "run the tests" },
          {
            kind: "reasoning",
            blocks: [
              privateBlock("block-private-1"),
              // A strip keyed on the kind name would keep this block.
              {
                blockId: "block-private-2",
                reasoningKind: "redacted_thinking",
                disclosure: "private",
                text: "opaque",
              },
            ],
          },
          {
            kind: "call",
            toolCallId: "call-1",
            toolName: "inspect",
            argumentsJson: '{"suite":"unit"}',
          },
          {
            kind: "result",
            toolCallId: "call-1",
            text: "42 passed",
            enclosingReasoningBlockId: "block-private-1",
          },
          { kind: "assistant", text: "all green" },
        ]),
      );

      // The stand-in sits right after its call: a reader pairs a call with the result that follows.
      expect(segmentsOf(transformed.turns)).toEqual([
        { kind: "text", position: 1, text: "run the tests" },
        toolCall(3, "call-1", '{"suite":"unit"}'),
        repairedResult(3, "call-1", SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT),
        { kind: "text", position: 5, text: "all green" },
      ]);
      expect(transformed.declaredLosses).toEqual([
        "provider_private_reasoning",
        "tool_call_history_repaired",
      ]);
    },
  );

  it(
    "withholds a tool result whose enclosure is " + "private or cannot be known, and declares why",
    () => {
      const user: LogRow = { kind: "user", text: "run the tests" };
      const call: LogRow = {
        kind: "call",
        toolCallId: "call-1",
        toolName: "inspect",
        argumentsJson: "{}",
      };
      const keyedResult = (blockId: string): LogRow => ({
        kind: "result",
        toolCallId: "call-1",
        text: "42 passed",
        enclosingReasoningBlockId: blockId,
      });
      const unkeyedResult = (blockId: string): LogRow => ({
        kind: "result",
        text: "42 passed",
        enclosingReasoningBlockId: blockId,
      });

      const cases: readonly {
        readonly name: string;
        readonly rows: readonly LogRow[];
        readonly boundary?: number;
        readonly declaredLosses: readonly string[];
      }[] = [
        {
          name: "a keyed result whose turn's reasoning could not be read",
          rows: [user, { kind: "reasoning" }, call, keyedResult("block-private-1")],
          declaredLosses: ["tool_call_history_repaired", "turn_content_unavailable"],
        },
        {
          // A fold that stopped at the bound would never meet the block that withholds the answer.
          name: "a keyed result inside the bound, its private block logged past it",
          rows: [
            user,
            call,
            keyedResult("block-private-1"),
            { kind: "reasoning", blocks: [privateBlock("block-private-1")] },
          ],
          boundary: 3,
          declaredLosses: ["provider_private_reasoning", "tool_call_history_repaired"],
        },
        {
          name: "a keyed result past the bound, its private block inside it",
          rows: [
            user,
            { kind: "reasoning", blocks: [privateBlock("block-private-1")] },
            call,
            keyedResult("block-private-1"),
          ],
          boundary: 3,
          declaredLosses: ["provider_private_reasoning", "tool_call_history_repaired"],
        },
        {
          // Last write wins would let the later summary overwrite the private stamp.
          name: "a keyed result citing one block id carried twice under disagreeing disclosures",
          rows: [
            user,
            call,
            keyedResult("block-1"),
            { kind: "reasoning", blocks: [privateBlock("block-1")] },
            { kind: "reasoning", blocks: [summaryBlock("block-1")] },
          ],
          boundary: 3,
          declaredLosses: ["tool_call_history_repaired", "turn_content_unavailable"],
        },
        {
          name: "an unkeyed answer inside a private block",
          rows: [
            { kind: "reasoning", blocks: [privateBlock("block-1")] },
            unkeyedResult("block-1"),
            { kind: "assistant", text: "all green" },
          ],
          declaredLosses: ["provider_private_reasoning"],
        },
        {
          name: "an unkeyed answer logged before its private block, the bound between them",
          rows: [
            unkeyedResult("block-1"),
            { kind: "reasoning", blocks: [privateBlock("block-1")] },
          ],
          boundary: 1,
          declaredLosses: ["provider_private_reasoning"],
        },
        {
          // Its own turn cannot tell the citation's disclosure, so unknown fails closed.
          name: "an unkeyed answer citing a block only an earlier turn carries",
          rows: [
            { kind: "reasoning", blocks: [summaryBlock("block-1")] },
            { kind: "turn-start" },
            unkeyedResult("block-1"),
          ],
          declaredLosses: ["turn_content_unavailable"],
        },
      ];

      for (const enclosureCase of cases) {
        const transformed = transformTranscript(
          foldLog(enclosureCase.rows, enclosureCase.boundary),
        );
        expect(everyTextIn(transformed), enclosureCase.name).not.toContain("42 passed");
        expect(everyTextIn(transformed), enclosureCase.name).not.toContain("internal deliberation");
        expect(transformed.declaredLosses, enclosureCase.name).toEqual(
          enclosureCase.declaredLosses,
        );
      }
    },
  );
});

// Pairing

describe("transform pipeline — every carried call has exactly one answer, after it", () => {
  const OWNER_ARGUMENTS = '{"target":"one"}';
  const DUPLICATE_ARGUMENTS = '{"target":"two"}';
  const OWNER_ANSWER = "the answer to the first call";

  // A turn's position is its first segment's, as the fold assigns it.
  function projectionOfTurns(
    turnSegments: readonly (readonly CanonicalTranscriptSegment[])[],
  ): CanonicalTranscriptProjection {
    const positions: number[] = turnSegments.flatMap((segments) =>
      segments.map((segment) => segment.position),
    );
    return {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      builtAtPosition: Math.max(0, ...positions),
      turns: turnSegments.map((segments) => ({
        position: segments[0]?.position ?? 0,
        role: "assistant",
        segments,
      })),
    };
  }

  /**
   * Every call identifier is distinct and has exactly one answer after it; no answer is orphaned.
   */
  function expectOneAnswerPerDistinctCall(transformed: TransformedTranscript, name: string): void {
    const segments = segmentsOf(transformed.turns);
    const callIds = segments.flatMap((segment) =>
      segment.kind === "tool_call" ? [segment.toolCallId] : [],
    );
    expect(new Set(callIds).size, name).toBe(callIds.length);
    for (const callId of callIds) {
      const callIndex = segments.findIndex(
        (segment) => segment.kind === "tool_call" && segment.toolCallId === callId,
      );
      const answerIndices = segments.flatMap((segment, index) =>
        segment.kind === "tool_result" && segment.toolCallId === callId ? [index] : [],
      );
      expect(answerIndices, name).toHaveLength(1);
      expect(answerIndices[0], name).toBeGreaterThan(callIndex);
    }
    const resultIds = segments.flatMap((segment) =>
      segment.kind === "tool_result" ? [segment.toolCallId] : [],
    );
    expect([...resultIds].sort(), name).toEqual([...callIds].sort());
  }

  it("repairs every pairing a provider would reject, the same way on every export", () => {
    const cases: readonly {
      readonly name: string;
      readonly turns: readonly (readonly CanonicalTranscriptSegment[])[];
      readonly segments: readonly CanonicalTranscriptSegment[];
      readonly turnPositions: readonly number[];
    }[] = [
      {
        // Both ids are present, so a membership check would pair them and declare nothing.
        name: "a result standing before its call",
        turns: [
          [providerResult(1, "call-inverted", "answered early")],
          [toolCall(2, "call-inverted")],
        ],
        segments: [
          toolCall(2, "call-inverted"),
          providerResult(1, "call-inverted", "answered early"),
        ],
        turnPositions: [2],
      },
      {
        name: "a result whose call is absent",
        turns: [[providerResult(1, "call-from-another-run", "orphaned")]],
        segments: [],
        turnPositions: [],
      },
      {
        name: "a second answer to an answered call",
        turns: [
          [
            toolCall(1, "call-shared", OWNER_ARGUMENTS),
            providerResult(2, "call-shared", OWNER_ANSWER),
            { ...providerResult(3, "call-shared", "a second answer"), outcome: "failed" },
          ],
        ],
        segments: [
          toolCall(1, "call-shared", OWNER_ARGUMENTS),
          providerResult(2, "call-shared", OWNER_ANSWER),
        ],
        turnPositions: [1],
      },
      {
        // The duplicate's identifier derives from its position; its arguments cross unchanged.
        name: "a later call reusing an identifier, answered between them",
        turns: [
          [
            toolCall(1, "call-shared", OWNER_ARGUMENTS),
            providerResult(2, "call-shared", OWNER_ANSWER),
            toolCall(3, "call-shared", DUPLICATE_ARGUMENTS),
          ],
        ],
        segments: [
          toolCall(1, "call-shared", OWNER_ARGUMENTS),
          providerResult(2, "call-shared", OWNER_ANSWER),
          toolCall(3, "call-shared-repaired-2", DUPLICATE_ARGUMENTS),
          repairedResult(3, "call-shared-repaired-2", SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT),
        ],
        turnPositions: [1],
      },
      {
        // The owner's answer is pulled up beside it, so the duplicate's stand-in cannot read as
        // the first call's outcome; the turn it vacated is gone.
        name: "a later call reusing an identifier, answered after both",
        turns: [
          [toolCall(1, "call-shared", OWNER_ARGUMENTS)],
          [toolCall(2, "call-shared", DUPLICATE_ARGUMENTS)],
          [providerResult(3, "call-shared", OWNER_ANSWER)],
        ],
        segments: [
          toolCall(1, "call-shared", OWNER_ARGUMENTS),
          providerResult(3, "call-shared", OWNER_ANSWER),
          toolCall(2, "call-shared-repaired-1", DUPLICATE_ARGUMENTS),
          repairedResult(2, "call-shared-repaired-1", SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT),
        ],
        turnPositions: [1, 2],
      },
      {
        // The composed name is not reserved, so a provider may already have spent it.
        name: "a disambiguated identifier the transcript already spends",
        turns: [
          [
            toolCall(1, "call-shared", OWNER_ARGUMENTS),
            toolCall(2, "call-shared", DUPLICATE_ARGUMENTS),
            toolCall(3, "call-shared-repaired-1", '{"target":"three"}'),
            providerResult(4, "call-shared", OWNER_ANSWER),
          ],
        ],
        segments: [
          toolCall(1, "call-shared", OWNER_ARGUMENTS),
          providerResult(4, "call-shared", OWNER_ANSWER),
          toolCall(2, "call-shared-repaired-1-1", DUPLICATE_ARGUMENTS),
          repairedResult(
            2,
            "call-shared-repaired-1-1",
            SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT,
          ),
          toolCall(3, "call-shared-repaired-1", '{"target":"three"}'),
          repairedResult(3, "call-shared-repaired-1", SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT),
        ],
        turnPositions: [1],
      },
    ];

    for (const pairingCase of cases) {
      const projection = projectionOfTurns(pairingCase.turns);
      const transformed = transformTranscript(projection);
      expect(segmentsOf(transformed.turns), pairingCase.name).toEqual(pairingCase.segments);
      expect(
        transformed.turns.map((turn) => turn.position),
        pairingCase.name,
      ).toEqual(pairingCase.turnPositions);
      expectOneAnswerPerDistinctCall(transformed, pairingCase.name);
      expect(transformed.declaredLosses, pairingCase.name).toEqual(["tool_call_history_repaired"]);
      // A counter or random value would make a second export unrecognizable to a target that saw
      // the first.
      expect(transformTranscript(projection), pairingCase.name).toEqual(transformed);
    }
  });
});

// The bound

describe("transform pipeline — a bounded export carries nothing logged past the bound", () => {
  it(
    "cuts inside a turn, and bounds before the " +
      "repair so an admitted call is answered in bound",
    () => {
      const cases: readonly {
        readonly name: string;
        readonly rows: readonly LogRow[];
        readonly boundary: number;
        /** How many turns the whole log folds to, so a case cannot pass on a split it never had. */
        readonly unboundedTurnCount: number;
        readonly segments: readonly CanonicalTranscriptSegment[];
        readonly declaredLosses: readonly string[];
      }[] = [
        {
          name: "whole turns past the bound",
          rows: [
            { kind: "user", text: "first question" },
            { kind: "assistant", text: "first answer" },
            { kind: "user", text: "second question" },
            { kind: "assistant", text: "second answer" },
          ],
          boundary: 2,
          unboundedTurnCount: 4,
          segments: [
            { kind: "text", position: 1, text: "first question" },
            { kind: "text", position: 2, text: "first answer" },
          ],
          declaredLosses: [],
        },
        {
          // A bound read off the turn's own position would keep the turn whole.
          name: "content a turn coalesced from past the bound",
          rows: [
            { kind: "assistant", text: "the suite is green" },
            { kind: "result", text: "the leaked follow-up" },
          ],
          boundary: 1,
          unboundedTurnCount: 1,
          segments: [{ kind: "text", position: 1, text: "the suite is green" }],
          declaredLosses: [],
        },
        {
          name: "a call whose answer arrives in the next turn",
          rows: [
            { kind: "call", toolCallId: "call-1", toolName: "inspect", argumentsJson: "{}" },
            { kind: "turn-start" },
            { kind: "result", toolCallId: "call-1", text: "the file contents" },
          ],
          boundary: 1,
          unboundedTurnCount: 2,
          segments: [
            toolCall(1, "call-1"),
            repairedResult(1, "call-1", SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT),
          ],
          declaredLosses: ["tool_call_history_repaired"],
        },
        {
          name: "a call and its answer coalesced into one turn",
          rows: [
            { kind: "call", toolCallId: "call-1", toolName: "inspect", argumentsJson: "{}" },
            { kind: "result", toolCallId: "call-1", text: "the file contents" },
          ],
          boundary: 1,
          unboundedTurnCount: 1,
          segments: [
            toolCall(1, "call-1"),
            repairedResult(1, "call-1", SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT),
          ],
          declaredLosses: ["tool_call_history_repaired"],
        },
      ];

      for (const boundCase of cases) {
        expect(foldLog(boundCase.rows).turns, boundCase.name).toHaveLength(
          boundCase.unboundedTurnCount,
        );
        const bounded = transformTranscript(foldLog(boundCase.rows, boundCase.boundary));
        expect(segmentsOf(bounded.turns), boundCase.name).toEqual(boundCase.segments);
        expect(bounded.declaredLosses, boundCase.name).toEqual(boundCase.declaredLosses);
      }
    },
  );
});
