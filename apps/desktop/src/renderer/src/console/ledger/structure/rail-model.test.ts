// The rail's model — its three rules, and the ways each one fails quietly.
//
// A rail that invented ticks still paints. A rail that spent amber on an ordinary
// mark still paints. A rail that drew a complete map of a truncated window still
// paints. So each rule below is asserted positively and then again negatively,
// against the case that would pass if the rule had been dropped.

import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { RAIL_THUMB_MIN_EXTENT } from "./structure-bounds.js";
import {
  clampRailViewportBand,
  ProvenanceRailModel,
  RAIL_TICK_BINDINGS,
  RAIL_TICK_KINDS,
  RAIL_TICK_TONES,
  railRowBandCentre,
  railTickKindsWithoutRegisteredWire,
  railViewportBand,
} from "./rail-model.js";
import { generalRow, rollbackBoundaryRow, runRow } from "./timeline-rows.test-support.js";
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

  it("places each mark at the centre of its row's band", () => {
    const rows = storyWindow();
    const { ticks } = railOver(rows).model();
    for (const tick of ticks) {
      const rowIndex = rows.findIndex((row) => row.id === tick.rowId);
      expect(tick.position).toBeCloseTo(railRowBandCentre(rowIndex, rows.length), 12);
    }
  });

  it("negative control: sequence distance places the same marks somewhere else", () => {
    // The axis that shipped. `storyWindow` runs one row per sequence, so this is
    // the FRIENDLIEST case sequence placement gets — and the two answers still
    // differ on every mark, because one measures across the span of sequences and
    // the other across the bands of rendered rows.
    const rows = storyWindow();
    const firstSequence = rows[0]?.sequence ?? 0;
    const sequenceSpan = (rows[rows.length - 1]?.sequence ?? 0) - firstSequence;
    for (const tick of railOver(rows).model().ticks) {
      const bySequenceDistance = (tick.sequence - firstSequence) / sequenceSpan;
      expect(tick.position).not.toBeCloseTo(bySequenceDistance, 6);
    }
  });

  it("negative control: a single-row window is one mark in the middle, not a division by zero", () => {
    // The one band covers the whole rail, so its centre is the middle of it —
    // which is exactly where the thumb over that same one band is centred.
    const { ticks } = railOver([
      generalRow({ id: "m1", sequence: 4, type: "user.message", category: "interactive_request" }),
    ]).model();
    expect(ticks[0]?.position).toBe(0.5);
    expect(Number.isFinite(ticks[0]?.position ?? Number.NaN)).toBe(true);
  });
});

describe("rail — the marks and the thumb read one row ordering", () => {
  /**
   * The retained viewport ordering the feed renders, with a folded chapter's
   * synthetic header at its head.
   *
   * The header's shape is the fold's own — one row keyed by the run id, standing
   * for a chapter and carrying no projected row — so the rail sees exactly what a
   * mounted feed hands it.
   */
  const CHAPTER_HEADER_KEY = "run-a";

  function railOverOrdering(
    rows: readonly TimelineRow[],
    retainedRowKeys: readonly string[],
  ): ProvenanceRailModel {
    return new ProvenanceRailModel({ rows, retainedRowKeys, hasEarlierRows: false });
  }

  /**
   * The two visible rows the cases below compare on, and why these two.
   *
   * With one header band ahead of the log, band index and row index differ by one
   * everywhere — so the divergence between the two axes is widest near the head,
   * where the header's band has already pushed the marks down while sequence
   * distance has not moved them at all. Bands 3 and 4 are the first window where
   * that gap is larger than the window itself.
   */
  const FIRST_VISIBLE_BAND = 3;
  const LAST_VISIBLE_BAND = 4;

  it("puts every mark of a viewport's rows inside that viewport's thumb", () => {
    const rows = storyWindow();
    const retainedRowKeys = [CHAPTER_HEADER_KEY, ...rows.map((row) => row.id)];
    const { ticks } = railOverOrdering(rows, retainedRowKeys).model();
    const band = railViewportBand(FIRST_VISIBLE_BAND, LAST_VISIBLE_BAND, retainedRowKeys.length);
    const visibleRowIds = new Set(retainedRowKeys.slice(FIRST_VISIBLE_BAND, LAST_VISIBLE_BAND + 1));
    const visibleTicks = ticks.filter((tick) => visibleRowIds.has(tick.rowId));
    expect(visibleTicks.length).toBeGreaterThan(0);
    for (const tick of visibleTicks) {
      expect(tick.position).toBeGreaterThanOrEqual(band.position);
      expect(tick.position).toBeLessThanOrEqual(band.position + band.extent);
    }
  });

  it("negative control: sequence placement puts one of those marks above the thumb", () => {
    // The two derivations that shipped, on the same window: marks by sequence
    // distance, thumb top by row index against the last index. A visible row's
    // mark lands above the thumb that is supposed to be identifying it — and the
    // stale top is used rather than the band's, so the comparison is not made
    // easier by the fix it exists to justify.
    const rows = storyWindow();
    const retainedRowKeys = [CHAPTER_HEADER_KEY, ...rows.map((row) => row.id)];
    const staleTop = FIRST_VISIBLE_BAND / (retainedRowKeys.length - 1);
    const firstSequence = rows[0]?.sequence ?? 0;
    const sequenceSpan = (rows[rows.length - 1]?.sequence ?? 0) - firstSequence;
    const visibleRowIds = new Set(retainedRowKeys.slice(FIRST_VISIBLE_BAND, LAST_VISIBLE_BAND + 1));
    const escaped = rows
      .filter((row) => visibleRowIds.has(row.id))
      .map((row) => (row.sequence - firstSequence) / sequenceSpan)
      .filter((position) => position < staleTop);
    expect(escaped.length).toBeGreaterThan(0);
  });

  it("shifts the marks by exactly the bands a chapter header takes", () => {
    const rows = storyWindow();
    const withoutHeader = railOverOrdering(
      rows,
      rows.map((row) => row.id),
    )
      .model()
      .ticks.map((tick) => tick.position);
    const withHeader = railOverOrdering(rows, [CHAPTER_HEADER_KEY, ...rows.map((row) => row.id)])
      .model()
      .ticks.map((tick) => tick.position);
    expect(withHeader).toHaveLength(withoutHeader.length);
    // One more band, and every mark one band further down: the same arithmetic the
    // thumb over that ordering performs, so the two move together.
    for (const [index, position] of withHeader.entries()) {
      expect(position).toBeCloseTo(railRowBandCentre(index + 1, rows.length + 1), 12);
    }
    expect(withHeader[0]).not.toBeCloseTo(withoutHeader[0] ?? Number.NaN, 6);
  });

  it("places no mark for a row the retained ordering does not hold", () => {
    // A row the feed is not rendering has no band. Marking it anyway would offer a
    // jump to a row the viewport cannot scroll to.
    const rows = storyWindow();
    const retainedRowKeys = rows.slice(2).map((row) => row.id);
    const { ticks } = railOverOrdering(rows, retainedRowKeys).model();
    const retained = new Set(retainedRowKeys);
    for (const tick of ticks) {
      expect(retained.has(tick.rowId)).toBe(true);
    }
    expect(ticks.map((tick) => tick.rowId)).not.toContain("m1");
  });
});

describe("rail — the row-band model places both readings", () => {
  const WINDOW_ROW_COUNT = 100;
  const TAIL_FIRST_INDEX = 90;

  it("ends the tail viewport's thumb exactly at the rail's foot", () => {
    // The defect in one line: `firstIndex / (rowCount - 1)` plus
    // `visibleCount / rowCount` is 90.9% down plus 10% of height, and the thumb
    // hung over the end of the rail.
    const band = railViewportBand(TAIL_FIRST_INDEX, WINDOW_ROW_COUNT - 1, WINDOW_ROW_COUNT);
    expect(band.position).toBeCloseTo(0.9, 12);
    expect(band.extent).toBeCloseTo(0.1, 12);
    expect(band.position + band.extent).toBeCloseTo(1, 12);
  });

  it("negative control: the two-denominator arithmetic runs past the foot", () => {
    // Without this the case above would pass over any formula that happened to
    // land at the tail. This is what the geometry computed before, evaluated on
    // the same viewport: it overruns, which is why one denominator is the rule.
    const staleTop = TAIL_FIRST_INDEX / (WINDOW_ROW_COUNT - 1);
    const staleHeight = (WINDOW_ROW_COUNT - TAIL_FIRST_INDEX) / WINDOW_ROW_COUNT;
    expect(staleTop + staleHeight).toBeGreaterThan(1);
  });

  it("leaves a mid-window thumb where the bands put it, clamping nothing", () => {
    const band = railViewportBand(40, 44, WINDOW_ROW_COUNT);
    expect(band.position).toBeCloseTo(40 / WINDOW_ROW_COUNT, 12);
    expect(band.extent).toBeCloseTo(5 / WINDOW_ROW_COUNT, 12);
  });

  it("gives a viewport spanning every row the whole rail", () => {
    expect(railViewportBand(0, WINDOW_ROW_COUNT - 1, WINDOW_ROW_COUNT)).toStrictEqual({
      position: 0,
      extent: 1,
    });
  });

  it("pays the minimum height out of the top rather than out of the rail", () => {
    // One row of ten thousand is half a pixel of thumb, so the floor applies — and
    // the floor is taken off the TOP at the foot of the rail, never added past it.
    const band = railViewportBand(9999, 9999, 10_000);
    expect(band.extent).toBe(RAIL_THUMB_MIN_EXTENT);
    expect(band.position).toBeCloseTo(1 - RAIL_THUMB_MIN_EXTENT, 12);
  });

  it("negative control: clamping the pair independently admits a thumb past the foot", () => {
    // The clamp that shipped bounded top and height into [0, 1] separately, which
    // accepts this pair unchanged. One clamp over the pair is what rejects it.
    const overrunning = { position: 0.909, extent: 0.1 };
    expect(Math.min(1, overrunning.position) + Math.min(1, overrunning.extent)).toBeGreaterThan(1);
    const clamped = clampRailViewportBand(overrunning);
    expect(clamped.position + clamped.extent).toBeCloseTo(1, 12);
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
