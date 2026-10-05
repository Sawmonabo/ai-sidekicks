// The child-run and handoff derivations, read directly rather than through a rendered line:
// which rows carry a child run, which are handoffs, and which of them draws the card.

import { describe, expect, it } from "vitest";

import type { ChildRunSummary } from "@ai-sidekicks/contracts/transcript/child-run-summary";
import type { RunId } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row/row";

import { generalRow, runRow } from "../transcript-event-rows.test-support.js";
import { deriveChildRunEntries, deriveHandoffEntries } from "./child-run-entries.js";

/** When a later observation saw the child's transcript lose entries. */
const OBSERVED_AT = "2026-09-02T10:04:00.000Z";

/** A complete child-run summary, which the shared fixture builder does not offer. */
function completeSummary(childRunId: string, eventCount: number): ChildRunSummary {
  return {
    runId: childRunId as RunId,
    parentRunId: "run-parent" as RunId,
    state: "running",
    eventCount,
    completeness: { state: "complete" },
  };
}

function rowCarryingChildRun(
  id: string,
  sequence: number,
  summary: ChildRunSummary,
): TranscriptEventRow {
  return {
    ...runRow({ id, sequence, type: "run.started", runId: "run-parent", position: sequence }),
    childRunSummary: summary,
  } as TranscriptEventRow;
}

describe("child-run entries — one card per child, at the row that first named it", () => {
  it("anchors a re-summarized child at its first row and records the later ones", () => {
    const entries = deriveChildRunEntries([
      rowCarryingChildRun("r1", 1, completeSummary("run-child", 1)),
      rowCarryingChildRun("r2", 2, completeSummary("run-child", 7)),
      rowCarryingChildRun("r3", 3, completeSummary("run-child", 9)),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.rowId).toBe("r1");
    expect(entries[0]?.resummarizedRowIds).toEqual(["r2", "r3"]);
  });

  it("shows the LATEST observation of a child, still anchored at its first row", () => {
    const entries = deriveChildRunEntries([
      rowCarryingChildRun("r1", 1, completeSummary("run-child", 1)),
      rowCarryingChildRun("r2", 2, {
        ...completeSummary("run-child", 9),
        state: "completed",
        completeness: {
          state: "incomplete",
          cause: "detail_fetch_failed",
          observedAt: OBSERVED_AT,
        },
      }),
    ]);
    expect(entries).toHaveLength(1);
    // The anchor is the first row's; every figure on the card is the second row's.
    expect(entries[0]?.rowId).toBe("r1");
    expect(entries[0]?.summary.eventCount).toBe(9);
    expect(entries[0]?.summary.state).toBe("completed");
    expect(entries[0]?.summary.completeness).toEqual({
      state: "incomplete",
      cause: "detail_fetch_failed",
      observedAt: OBSERVED_AT,
    });
  });

  it("a child summarized once keeps the only summary it has", () => {
    // A fold that took the last row's summary unconditionally would pass the case above while
    // dropping a child nothing re-summarized.
    const entries = deriveChildRunEntries([
      rowCarryingChildRun("r1", 1, completeSummary("run-child", 4)),
      rowCarryingChildRun("r2", 2, completeSummary("run-other", 2)),
    ]);
    expect(entries.map((entry) => entry.summary.eventCount)).toEqual([4, 2]);
    expect(entries.map((entry) => entry.resummarizedRowIds)).toEqual([[], []]);
  });

  it("admits a child summarized onto a non-run row, which carries no attribution", () => {
    const entries = deriveChildRunEntries([
      {
        ...generalRow({ id: "g1", sequence: 1, type: "session.note" }),
        childRunSummary: completeSummary("run-child", 2),
      } as TranscriptEventRow,
    ]);
    expect(entries.map((entry) => entry.rowId)).toEqual(["g1"]);
  });
});

describe("handoff entries — the three members, each read as itself", () => {
  it("reads every member the projection carried", () => {
    const entries = deriveHandoffEntries([
      runRow({
        id: "h1",
        sequence: 1,
        type: "subagent.started",
        runId: "run-a",
        position: 1,
        payload: {
          fromActor: "user-ana",
          toActor: "agent-reviewer",
          reason: "review requested",
        },
      }),
    ]);
    expect(entries[0]).toMatchObject({
      wireType: "subagent.started",
      fromActor: "user-ana",
      toActor: "agent-reviewer",
      reason: "review requested",
    });
  });

  it("leaves an absent reason absent rather than filling one in", () => {
    const entries = deriveHandoffEntries([
      runRow({
        id: "h1",
        sequence: 1,
        type: "subagent.started",
        runId: "run-a",
        position: 1,
        actor: "agent-reviewer",
        payload: { fromActor: "agent-reviewer" },
      }),
    ]);
    expect(entries[0]?.reason).toBeUndefined();
    expect(entries[0]?.toActor).toBeUndefined();
  });

  it("does not admit a row that carries handoff members under another type", () => {
    expect(
      deriveHandoffEntries([
        runRow({
          id: "r1",
          sequence: 1,
          type: "user.message",
          runId: "run-a",
          position: 1,
          payload: { fromActor: "user-ana", toActor: "agent-reviewer" },
        }),
      ]),
    ).toEqual([]);
  });

  it("draws one handoff per subagent, at the row that started it", () => {
    const identity = { provider: "claude", subagentId: "sub-1" };
    const entries = deriveHandoffEntries([
      runRow({
        id: "start",
        sequence: 1,
        type: "subagent.started",
        runId: "run-a",
        position: 1,
        payload: { ...identity, toActor: "agent-reviewer" },
      }),
      runRow({
        id: "done",
        sequence: 2,
        type: "subagent.completed",
        runId: "run-a",
        position: 2,
        payload: { ...identity, toActor: "agent-reviewer" },
      }),
    ]);
    expect(entries.map((entry) => entry.rowId)).toEqual(["start"]);
  });

  it("takes the child run from the parsed summary before the free-form payload", () => {
    const row = {
      ...runRow({
        id: "h1",
        sequence: 1,
        type: "subagent.started",
        runId: "run-a",
        position: 1,
        payload: { childRunId: "run-from-payload" },
      }),
      childRunSummary: completeSummary("run-from-summary", 1),
    } as TranscriptEventRow;
    expect(deriveHandoffEntries([row])[0]?.childRunId).toBe("run-from-summary");
  });
});
