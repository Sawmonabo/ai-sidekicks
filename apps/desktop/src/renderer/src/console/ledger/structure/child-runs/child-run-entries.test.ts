// The child-run and handoff derivations, over rows the contract could actually send.
//
// Every case reads the DERIVATION rather than a rendered line, because these are the
// two questions the feed asks per row and the rows are the only input: which rows
// carry a child run, which rows are handoffs, and which of them draws the card.

import { describe, expect, it } from "vitest";

import {
  type ChildRunSummary,
  type NodeId,
  type RunId,
  type TimelineRow,
} from "@ai-sidekicks/contracts";

import { generalRow, rollbackBoundaryRow, runRow } from "../timeline-rows.test-support.js";
import {
  ChildRunIndex,
  HANDOFF_WIRE_TYPES,
  deriveChildRunEntries,
  deriveHandoffEntries,
} from "./child-run-entries.js";
import { RAIL_TICK_BINDINGS } from "../rail/rail-ticks.js";

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

function rowCarryingChildRun(id: string, sequence: number, summary: ChildRunSummary): TimelineRow {
  return {
    ...runRow({ id, sequence, type: "run.started", runId: "run-parent", position: sequence }),
    childRunSummary: summary,
  } as TimelineRow;
}

describe("the handoff wire vocabulary — one table, two renderers", () => {
  it("reads the rail's own handoff tick binding rather than restating it", () => {
    expect(HANDOFF_WIRE_TYPES).toBe(RAIL_TICK_BINDINGS.handoff.wireTypes);
  });
});

describe("child-run entries — one card per child, at the row that first named it", () => {
  it("carries the summary, the actor and the timestamp off the row", () => {
    const entries = deriveChildRunEntries([
      rowCarryingChildRun("r1", 1, completeSummary("run-child", 4)),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary.eventCount).toBe(4);
    expect(entries[0]?.rowId).toBe("r1");
  });

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
        state: "succeeded",
        producingNodeId: "node-b" as NodeId,
        completeness: { state: "incomplete", cause: "compacted", observedAt: OBSERVED_AT },
      }),
    ]);
    expect(entries).toHaveLength(1);
    // The anchor is the first row's — the card stays where a reader left it — and
    // every figure on it is the second row's.
    expect(entries[0]?.rowId).toBe("r1");
    expect(entries[0]?.summary.eventCount).toBe(9);
    expect(entries[0]?.summary.state).toBe("succeeded");
    expect(entries[0]?.summary.producingNodeId).toBe("node-b");
    expect(entries[0]?.summary.completeness).toEqual({
      state: "incomplete",
      cause: "compacted",
      observedAt: OBSERVED_AT,
    });
  });

  it("negative control: a child summarized once keeps the only summary it has", () => {
    // Without this, a fold that took the LAST row's summary unconditionally would pass
    // the case above while dropping the summary of a child nothing re-summarized.
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
      } as TimelineRow,
    ]);
    expect(entries.map((entry) => entry.rowId)).toEqual(["g1"]);
  });

  it("produces nothing for a window whose rows carry no child run", () => {
    expect(
      deriveChildRunEntries([
        runRow({ id: "r1", sequence: 1, type: "run.started", runId: "run-a", position: 1 }),
      ]),
    ).toEqual([]);
  });
});

describe("handoff entries — the four members, each read as itself", () => {
  it("reads every member the projection carried", () => {
    const entries = deriveHandoffEntries([
      runRow({
        id: "h1",
        sequence: 1,
        type: "agent.attached",
        runId: "run-a",
        position: 1,
        payload: {
          fromActor: "participant-ana",
          toActor: "agent-reviewer",
          reason: "review requested",
          channelId: "channel-main",
        },
      }),
    ]);
    expect(entries[0]).toMatchObject({
      wireType: "agent.attached",
      fromActor: "participant-ana",
      toActor: "agent-reviewer",
      reason: "review requested",
      channelId: "channel-main",
    });
  });

  it("leaves an absent reason absent rather than filling one in", () => {
    const entries = deriveHandoffEntries([
      runRow({
        id: "h1",
        sequence: 1,
        type: "agent.detached",
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
          payload: { fromActor: "participant-ana", toActor: "agent-reviewer" },
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
    } as TimelineRow;
    expect(deriveHandoffEntries([row])[0]?.childRunId).toBe("run-from-summary");
  });

  it("reads no member off the typed rollback-boundary payload", () => {
    const entries = deriveHandoffEntries([
      {
        ...rollbackBoundaryRow({ id: "rb", sequence: 1, runId: "run-a", position: 3 }),
        type: "agent.attached",
      } as TimelineRow,
    ]);
    expect(entries[0]?.fromActor).toBeUndefined();
  });
});

describe("the index — one pass, two lookups", () => {
  it("keys both derivations by the row the feed is drawing", () => {
    const index = new ChildRunIndex([
      rowCarryingChildRun("child", 1, completeSummary("run-child", 3)),
      runRow({
        id: "handoff",
        sequence: 2,
        type: "agent.attached",
        runId: "run-parent",
        position: 2,
        payload: { toActor: "agent-reviewer" },
      }),
    ]);
    expect(index.childRunEntryByRowId().get("child")?.summary.runId).toBe("run-child");
    expect(index.handoffEntryByRowId().get("handoff")?.toActor).toBe("agent-reviewer");
    expect(index.handoffEntryByRowId().has("child")).toBe(false);
  });
});
