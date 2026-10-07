// Superseded turns as the transcript projection reads them from a scratch log: a cut supersedes the
// turns above its point, marks stay scoped to the epoch each cut rewound and run down the lineage
// to a later, lower cut, a tool row ranks by the turn its call opened in whenever it is delivered,
// and an undo of the files alone marks nothing. Rows are seeded straight into the log, since the
// rollback and turn-boundary events have no registered payload to append through.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EventCategory, EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  TranscriptEventRow,
  TranscriptRunStamp,
} from "@ai-sidekicks/contracts/transcript/row";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { prepareSessionEventReads } from "../../../events/session/read.js";
import { TranscriptProjector } from "../../../transcript/projector.js";
import { insertStoredEvent } from "../../__fixtures__/stored-event.js";
import { prepareSupersededTurns } from "../superseded.js";

const SESSION_ID = "0190f9b0-1c2d-7e3f-8a4b-5c6d7e8f9a01" as SessionId;
const RUN_ID = "0190f9b0-1c2d-7e3f-8a4b-5c6d7e8f9b01" as RunId;
const OTHER_RUN_ID = "0190f9b0-1c2d-7e3f-8a4b-5c6d7e8f9b02" as RunId;

interface LogEntry {
  readonly category: EventCategory;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function turnStarted(runId: RunId): LogEntry {
  return {
    category: "run_lifecycle",
    type: "run.turn_started",
    payload: { sessionId: SESSION_ID, runId, runVersion: 1 },
  };
}

function turnsStarted(runId: RunId, count: number): LogEntry[] {
  return Array.from({ length: count }, () => turnStarted(runId));
}

function rolledBack(runId: RunId, targetPosition: number): LogEntry {
  return {
    category: "run_lifecycle",
    type: "run.rolled_back",
    payload: { sessionId: SESSION_ID, runId, runVersion: 2, targetPosition },
  };
}

function assistantMessage(runId: RunId): LogEntry {
  return {
    category: "assistant_output",
    type: "assistant.message",
    payload: { sessionId: SESSION_ID, runId },
  };
}

function toolRow(
  type: "tool.invoked" | "tool.result",
  toolCallId: string,
  lateSource?: { readonly sourceEpoch: number; readonly sourcePosition: number },
): LogEntry {
  return {
    category: "tool_activity",
    type,
    payload: { sessionId: SESSION_ID, runId: RUN_ID, toolName: "Read", toolCallId, ...lateSource },
  };
}

function filesAloneRestored(): LogEntry {
  return {
    category: "session_lifecycle",
    type: "session.restore_finished",
    payload: {
      sessionId: SESSION_ID,
      target: { kind: "message", anchorCursor: encodeEventCursor(10) },
      result: {
        outcome: "restore-finished",
        requested: "files",
        restored: "files",
        files: { restoredFileCount: 2, restoredLineCount: 14, skipped: [] },
      },
    },
  };
}

let scratch: ScratchDatabase;
let logLength: number;

beforeEach(async () => {
  scratch = await openScratchDatabase();
  logLength = 0;
});

afterEach(async () => {
  await scratch.close();
});

async function appendToLog(entries: readonly LogEntry[]): Promise<void> {
  for (const entry of entries) {
    const sequence = logLength;
    logLength += 1;
    await insertStoredEvent(scratch.writer, {
      id: `event-${String(sequence)}`,
      sessionId: SESSION_ID,
      sequence,
      occurredAt: "2026-10-07T12:00:00.000Z",
      monotonicNs: BigInt(sequence),
      category: entry.category,
      type: entry.type,
      actor: null,
      payload: entry.payload,
      correlationId: null,
      causationId: null,
      version: "1.0",
    });
  }
}

function readLog(): EventEnvelope[] {
  return prepareSessionEventReads(scratch.reader).readWindow(SESSION_ID, 0, logLength - 1);
}

// Each projection is a fresh projector, as a rebuild is.
function project(events: readonly EventEnvelope[] = readLog()): TranscriptEventRow[] {
  return new TranscriptProjector(scratch.reader).projectWindow(SESSION_ID, events);
}

// The run's rows of `type` as `epoch:position`, followed by `>point` when superseded.
function marksOf(rows: readonly TranscriptEventRow[], runId: RunId, type: string): string[] {
  return rows.flatMap((row) => {
    if (row.kind === "general" || row.runId !== runId || row.type !== type) {
      return [];
    }
    const mark = `${String(row.epoch)}:${String(row.position)}`;
    return [
      row.superseded === undefined ? mark : `${mark}>${String(row.superseded.targetPosition)}`,
    ];
  });
}

function expectedMarks(epoch: number, from: number, to: number, point?: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => {
    const mark = `${String(epoch)}:${String(from + offset)}`;
    return point === undefined ? mark : `${mark}>${String(point)}`;
  });
}

function stampOfRow(row: TranscriptEventRow): TranscriptRunStamp | undefined {
  if (row.kind === "general") {
    return undefined;
  }
  const stamp = { position: row.position, epoch: row.epoch };
  return row.superseded === undefined ? stamp : { ...stamp, superseded: row.superseded };
}

// A fresh projector over the whole log, one over the log from `windowStart` on, and a live
// stamper fed every event all attribute each event as `rows` does.
function expectEveryReaderAlike(rows: readonly TranscriptEventRow[], windowStart: number): void {
  const events = readLog();
  expect(project(events)).toEqual(rows);
  expect(project(events.slice(windowStart))).toEqual(rows.slice(windowStart));
  const stamp = new TranscriptProjector(scratch.reader).createLiveStamper(SESSION_ID);
  expect(events.map((event) => stamp(event))).toEqual(rows.map(stampOfRow));
}

describe("superseded turns in the transcript projection", () => {
  it("supersedes the turns above a cut's point, keeps its prefix current, and marks nothing for an undo of the files alone", async () => {
    await appendToLog([
      ...turnsStarted(RUN_ID, 10).flatMap((turn) => [turn, assistantMessage(RUN_ID)]),
      filesAloneRestored(),
    ]);
    const beforeCut = project();
    expect(marksOf(beforeCut, RUN_ID, "run.turn_started")).toEqual(expectedMarks(0, 1, 10));
    expect(marksOf(beforeCut, RUN_ID, "assistant.message")).toEqual(expectedMarks(0, 1, 10));

    await appendToLog([rolledBack(RUN_ID, 5)]);
    const afterCut = project();
    const cutMarks = [...expectedMarks(0, 1, 5), ...expectedMarks(0, 6, 10, 5)];
    expect(marksOf(afterCut, RUN_ID, "run.turn_started")).toEqual(cutMarks);
    expect(marksOf(afterCut, RUN_ID, "assistant.message")).toEqual(cutMarks);
    expect(marksOf(afterCut, RUN_ID, "run.rolled_back")).toEqual(["0:5"]);
  });

  it("scopes each cut's marks to the epoch it rewound and runs a later, lower cut down the lineage", async () => {
    await appendToLog([
      // 10 -> 5, re-executed to 7, then 7 -> 6.
      ...turnsStarted(RUN_ID, 10),
      rolledBack(RUN_ID, 5),
      ...turnsStarted(RUN_ID, 2),
      rolledBack(RUN_ID, 6),
      // 10 -> 5, re-executed to 7, then 7 -> 3.
      ...turnsStarted(OTHER_RUN_ID, 10),
      rolledBack(OTHER_RUN_ID, 5),
      ...turnsStarted(OTHER_RUN_ID, 2),
      rolledBack(OTHER_RUN_ID, 3),
    ]);
    const rows = project();

    expect(marksOf(rows, RUN_ID, "run.turn_started")).toEqual([
      ...expectedMarks(0, 1, 5),
      ...expectedMarks(0, 6, 10, 5),
      "1:6",
      "1:7>6",
    ]);
    expect(marksOf(rows, RUN_ID, "run.rolled_back")).toEqual(["0:5", "1:6"]);
    expect(marksOf(rows, OTHER_RUN_ID, "run.turn_started")).toEqual([
      ...expectedMarks(0, 1, 3),
      ...expectedMarks(0, 4, 10, 3),
      "1:6>3",
      "1:7>3",
    ]);
    expect(marksOf(rows, OTHER_RUN_ID, "run.rolled_back")).toEqual(["0:5>3", "1:3"]);

    const supersededTurns = prepareSupersededTurns(scratch.reader);
    expect(supersededTurns(SESSION_ID, RUN_ID)).toEqual({
      runId: RUN_ID,
      cuts: [
        { sourceEpoch: 0, point: 5 },
        { sourceEpoch: 1, point: 6 },
      ],
    });
    expect(supersededTurns(SESSION_ID, OTHER_RUN_ID)).toEqual({
      runId: OTHER_RUN_ID,
      cuts: [
        { sourceEpoch: 0, point: 3 },
        { sourceEpoch: 1, point: 3 },
      ],
    });

    // From the first re-executed turn, so the window seeds the run from its rollback.
    expectEveryReaderAlike(rows, 11);
  });

  it("ranks a tool row by the turn its call opened in, delivered in time or stamped late", async () => {
    await appendToLog([
      ...turnsStarted(RUN_ID, 4),
      toolRow("tool.invoked", "call-opened-in-turn-4"),
      ...turnsStarted(RUN_ID, 4),
      toolRow("tool.result", "call-opened-in-turn-4"),
      toolRow("tool.invoked", "call-opened-in-turn-8"),
      toolRow("tool.result", "call-opened-in-turn-8"),
      ...turnsStarted(RUN_ID, 2),
      rolledBack(RUN_ID, 5),
      toolRow("tool.result", "call-delivered-late", { sourceEpoch: 0, sourcePosition: 4 }),
      toolRow("tool.result", "call-straggling", { sourceEpoch: 0, sourcePosition: 9 }),
      turnStarted(RUN_ID),
    ]);
    const rows = project();

    expect(marksOf(rows, RUN_ID, "tool.invoked")).toEqual(["0:4", "0:8>5"]);
    expect(marksOf(rows, RUN_ID, "tool.result")).toEqual(["0:4", "0:8>5", "0:4", "0:9>5"]);
    expect(marksOf(rows, RUN_ID, "run.turn_started").at(-1)).toBe("1:6");

    // From the in-time result, so the window reads its call's opening from the log.
    expectEveryReaderAlike(rows, 9);
  });
});
