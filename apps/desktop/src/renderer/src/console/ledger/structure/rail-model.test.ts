// The rail's model — the three §5.4 rules, and the ways each one fails quietly.
//
// A rail that invented ticks still paints. A rail that spent amber on an ordinary
// mark still paints. A rail that drew a complete map of a truncated window still
// paints. So each rule below is asserted positively and then again negatively,
// against the case that would pass if the rule had been dropped.

import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  ProvenanceRailModel,
  RAIL_TICK_BINDINGS,
  RAIL_TICK_KINDS,
  RAIL_TICK_TONES,
  railTickKindsWithoutRegisteredWire,
} from "./rail-model.js";
import { generalRow, rollbackBoundaryRow, runRow } from "./row-fixtures.js";
import { LedgerSeamIndex } from "./seams.js";

function railOver(rows: readonly TimelineRow[], hasEarlierRows = false): ProvenanceRailModel {
  return new ProvenanceRailModel({ rows, hasEarlierRows });
}

/** One row of every kind the rail draws a mark for, plus two it must ignore. */
function storyWindow(): readonly TimelineRow[] {
  return [
    generalRow({
      id: "m1",
      sequence: 1,
      type: "user.message",
      category: "interactive_request",
      actor: "person-one",
    }),
    runRow({
      id: "ap",
      sequence: 2,
      type: "approval.requested",
      category: "approval_flow",
      runId: "run-a",
      position: 1,
    }),
    runRow({
      id: "te",
      sequence: 3,
      type: "tool.error",
      category: "tool_activity",
      runId: "run-a",
      position: 2,
    }),
    runRow({
      id: "ha",
      sequence: 4,
      type: "agent.attached",
      category: "membership_change",
      runId: "run-a",
      position: 3,
    }),
    runRow({ id: "pk", sequence: 5, type: "run.paused", runId: "run-a", position: 4 }),
    rollbackBoundaryRow({ id: "rb", sequence: 6, runId: "run-a", position: 5, targetPosition: 1 }),
    runRow({
      id: "cp",
      sequence: 7,
      type: "usage.context_compacted",
      category: "usage_telemetry",
      runId: "run-a",
      position: 6,
    }),
    runRow({
      id: "ar",
      sequence: 8,
      type: "artifact.published",
      category: "artifact_publication",
      runId: "run-a",
      position: 7,
    }),
    // Two rows the rail marks nothing for.
    runRow({
      id: "ok",
      sequence: 9,
      type: "approval.approved",
      category: "approval_flow",
      runId: "run-a",
      position: 8,
    }),
    runRow({ id: "rr", sequence: 10, type: "run.running", runId: "run-a", position: 9 }),
  ];
}

describe("rail — the tick table is closed and total", () => {
  it("carries one binding per kind, keyed by the kind it names", () => {
    expect(RAIL_TICK_KINDS).toHaveLength(10);
    for (const kind of RAIL_TICK_KINDS) {
      const binding = RAIL_TICK_BINDINGS[kind];
      expect(binding.kind).toBe(kind);
      expect(RAIL_TICK_TONES).toContain(binding.tone);
      // Every kind is produced by something: a direct wire type or a seam kind.
      expect(binding.wireTypes.length + binding.seamKinds.length).toBeGreaterThan(0);
    }
  });

  it("spends amber on the one pending-human mark and red on the one failure", () => {
    const attention = RAIL_TICK_KINDS.filter(
      (kind) => RAIL_TICK_BINDINGS[kind].tone === "attention",
    );
    const failure = RAIL_TICK_KINDS.filter((kind) => RAIL_TICK_BINDINGS[kind].tone === "failure");
    expect(attention).toStrictEqual(["approval"]);
    expect(failure).toStrictEqual(["tool-error"]);
  });

  it("negative control: no seam-derived kind is coloured", () => {
    // A rewind, a compaction, and a switch are history, not attention. A table
    // that had spent amber on them would still render — in a rail where nothing
    // stands out because everything does.
    for (const kind of [
      "rollback-epoch",
      "compaction",
      "provider-switch",
      "park",
      "resume",
    ] as const) {
      expect(RAIL_TICK_BINDINGS[kind].tone).toBe("actor");
    }
  });

  it("reads seam-derived kinds through seam kinds, never by repeating wire types", () => {
    // The drift guard: a second copy of the seam vocabulary here would go stale
    // silently. These five carry no wire types of their own at all.
    for (const kind of [
      "park",
      "resume",
      "rollback-epoch",
      "compaction",
      "provider-switch",
    ] as const) {
      expect(RAIL_TICK_BINDINGS[kind].wireTypes).toStrictEqual([]);
      expect(RAIL_TICK_BINDINGS[kind].seamKinds.length).toBeGreaterThan(0);
    }
  });
});

describe("rail — ticks come from rows in the window and from nowhere else", () => {
  it("marks each row the design names, in log order", () => {
    const { ticks } = railOver(storyWindow()).model();
    expect(ticks.map((tick) => tick.kind)).toStrictEqual([
      "participant-message",
      "approval",
      "tool-error",
      "handoff",
      "park",
      "rollback-epoch",
      "compaction",
      "artifact-publication",
    ]);
  });

  it("negative control: a settled approval and an ordinary run row make no mark", () => {
    // The rail marks where a person was NEEDED. A decided approval needs nobody,
    // and a rail that marked it would put an amber tick on work already done.
    const rowIds = railOver(storyWindow())
      .model()
      .ticks.map((tick) => tick.rowId);
    expect(rowIds).not.toContain("ok");
    expect(rowIds).not.toContain("rr");
  });

  it("never invents a tick for a row it was not handed", () => {
    const rows = storyWindow();
    const windowRowIds = new Set(rows.map((row) => row.id));
    const { ticks } = railOver(rows).model();
    expect(ticks.length).toBeLessThanOrEqual(rows.length);
    for (const tick of ticks) {
      expect(windowRowIds.has(tick.rowId)).toBe(true);
    }
  });

  it("negative control: an empty window produces no marks at all", () => {
    const { ticks, clip } = railOver([]).model();
    expect(ticks).toStrictEqual([]);
    expect(clip.earliestLoadedSequence).toBeUndefined();
    expect(clip.latestLoadedSequence).toBeUndefined();
  });

  it("carries the row's own summary for the preview, wire-verbatim", () => {
    const { ticks } = railOver([
      generalRow({
        id: "m1",
        sequence: 1,
        type: "user.message",
        category: "interactive_request",
        summary: "asked for the deploy plan",
      }),
    ]).model();
    expect(ticks[0]?.summary).toBe("asked for the deploy plan");
  });

  it("places the head at 0 and the tail at 1", () => {
    const { ticks } = railOver(storyWindow()).model();
    expect(ticks[0]?.position).toBe(0);
    expect(ticks[ticks.length - 1]?.position).toBeCloseTo(7 / 9);
  });

  it("negative control: a single-row window is one mark at the tail, not a division by zero", () => {
    const { ticks } = railOver([
      generalRow({ id: "m1", sequence: 4, type: "user.message", category: "interactive_request" }),
    ]).model();
    expect(ticks[0]?.position).toBe(1);
    expect(Number.isFinite(ticks[0]?.position ?? Number.NaN)).toBe(true);
  });
});

describe("rail — clip honesty is a required answer, not an inferred one", () => {
  it("reports an unloaded extent when the caller says there is one", () => {
    expect(railOver(storyWindow(), true).model().clip).toStrictEqual({
      hasUnloadedExtent: true,
      earliestLoadedSequence: 1,
      latestLoadedSequence: 10,
    });
  });

  it("negative control: a complete window reports none", () => {
    // Inferred from the row count this would be wrong in both directions — a
    // dotted segment on a complete log, or none on a truncated one.
    expect(railOver(storyWindow(), false).model().clip.hasUnloadedExtent).toBe(false);
  });
});

describe("rail — the walks, and the memo", () => {
  it("computes its model once and answers from it", () => {
    const model = railOver(storyWindow());
    expect(model.model()).toBe(model.model());
  });

  it("walks forward and back within a kind", () => {
    const model = railOver([
      ...storyWindow(),
      runRow({
        id: "te2",
        sequence: 11,
        type: "tool.error",
        category: "tool_activity",
        runId: "run-a",
        position: 10,
      }),
    ]);
    expect(model.tickOfKind("tool-error", 0, "next")?.rowId).toBe("te");
    expect(model.tickOfKind("tool-error", 3, "next")?.rowId).toBe("te2");
    expect(model.tickOfKind("tool-error", 12, "previous")?.rowId).toBe("te2");
    expect(model.tickOfKind("tool-error", 11, "previous")?.rowId).toBe("te");
  });

  it("negative control: the walk stops at the ends rather than wrapping", () => {
    // The rail shows no counter, so a silent wrap would be a jump with nothing on
    // screen explaining it. The find field wraps for exactly the opposite reason.
    const model = railOver(storyWindow());
    expect(model.tickOfKind("tool-error", 3, "next")).toBeUndefined();
    expect(model.tickOfKind("tool-error", 3, "previous")).toBeUndefined();
  });

  it("finds the tick nearest a rail position", () => {
    const model = railOver(storyWindow());
    expect(model.tickNearest(0)?.rowId).toBe("m1");
    expect(model.tickNearest(1)?.rowId).toBe("ar");
  });

  it("negative control: an empty rail has no nearest tick", () => {
    expect(railOver([]).tickNearest(0.5)).toBeUndefined();
  });
});

describe("rail — the legend reports what the daemon cannot yet emit", () => {
  it("names only the kinds whose every wire type is unregistered", () => {
    // A legend listing ten kinds while the daemon can produce eight is a legend
    // that lies about the session. `park` is deliberately absent — `run.paused`
    // IS registered, so that mark works today.
    expect(railTickKindsWithoutRegisteredWire(new LedgerSeamIndex())).toStrictEqual([
      "resume",
      "provider-switch",
    ]);
  });

  it("negative control: the marks that do work are not reported missing", () => {
    const missing = railTickKindsWithoutRegisteredWire(new LedgerSeamIndex());
    for (const kind of [
      "participant-message",
      "approval",
      "tool-error",
      "handoff",
      "park",
      "rollback-epoch",
      "compaction",
      "artifact-publication",
    ] as const) {
      expect(missing).not.toContain(kind);
    }
  });

  it("forwards the seam classifier's own report rather than deriving a second one", () => {
    const seamIndex = new LedgerSeamIndex();
    expect(railOver([], false).unregisteredWireTypes()).toStrictEqual(
      seamIndex.unregisteredWireTypes(),
    );
  });
});
