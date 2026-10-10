// The measurement table's residuals as arithmetic, with no DOM: a shim answering zero for every
// rect would make each claim pass vacuously. The library's own answers are asserted in
// `controller.test.ts` and `chokepoint.test.ts`, and what reaches the table from an observed row
// in `virtualizer-options.test.ts`.

import { describe, expect, it } from "vitest";

import { RememberedRowHeights } from "#renderer/store/session/remembered-row-heights.js";
import { ROW_HEIGHT_SEED_REM, cutCallHeightPx, type RowHeightKind } from "../rows/height-kind.js";
import { RowMeasurementTable } from "./row-measurement-table.js";

/** The root font size the table converts seeds at until a display is declared. */
const INITIAL_ROOT_FONT_SIZE_PX = 16;

function keys(count: number, prefix = "row"): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}-${String(index)}`);
}

/** A key's kind is its prefix: `user-3` is a user message, anything else an agent message. */
function kindOfPrefixedKey(rowKey: string): RowHeightKind {
  return rowKey.startsWith("user-") ? "user-message" : "agent-message";
}

describe("the measurement table — accepting a height", () => {
  it("refuses an observation that is not a height, and keeps what it had", () => {
    // An unlaid-out element reports zero; taking it collapses every offset below onto one pixel.
    const table = new RowMeasurementTable();
    const estimatePx = table.heightOf("row-0");
    expect(table.acceptedHeight("row-0", 0)).toBe(estimatePx);
    expect(table.acceptedHeight("row-0", Number.NaN)).toBe(estimatePx);
    table.acceptedHeight("row-0", 240);
    expect(table.acceptedHeight("row-0", 0)).toBe(240);
  });

  it("bounds the remembered heights, letting the least recently measured go", () => {
    const table = new RowMeasurementTable({ rememberedHeights: new RememberedRowHeights(3) });
    for (const rowKey of keys(6)) {
      table.acceptedHeight(rowKey, 200);
    }
    expect(table.rememberedHeightOf("row-2")).toBeUndefined();
    expect(table.rememberedHeightOf("row-3")).toBe(200);
    expect(table.rememberedHeightOf("row-5")).toBe(200);
  });
});

describe("the measurement table — a kind's estimate", () => {
  it("follows the median of its own kind's measurements, once published", () => {
    // A mean would let one tall reply drag every unmeasured row of its kind; a sample shared
    // across kinds would estimate a one-line message at a reply's height.
    const table = new RowMeasurementTable({ heightKindOf: kindOfPrefixedKey });
    const agentSeedPx = ROW_HEIGHT_SEED_REM["agent-message"] * INITIAL_ROOT_FONT_SIZE_PX;
    const userSeedPx = ROW_HEIGHT_SEED_REM["user-message"] * INITIAL_ROOT_FONT_SIZE_PX;
    for (const [rowKey, heightPx] of [
      ["user-0", 50],
      ["user-1", 60],
      ["user-2", 130],
    ] as const) {
      table.acceptedHeight(rowKey, heightPx);
    }
    // Rows already laid out keep the estimate they were laid out at until it is published.
    expect(table.heightOf("user-unmeasured")).toBe(userSeedPx);

    table.publishEstimates();
    expect(table.heightOf("user-unmeasured")).toBe(60);
    expect(table.heightOf("agent-unmeasured")).toBe(agentSeedPx);

    // A row measured again counts once, at its new height: 200, 60 and 130 leave 130 between.
    table.acceptedHeight("user-0", 200);
    table.publishEstimates();
    expect(table.heightOf("user-unmeasured")).toBe(130);
    expect(table.heightOf("agent-unmeasured")).toBe(agentSeedPx);
  });
});

describe("the measurement table — a row still revealing", () => {
  it("holds its growth out of its kind's estimate, and samples it once when it settles", () => {
    // With few rows measured, each step of a reply streaming in would move the median and have
    // the viewport lay every row out again.
    const revealingRowKeys = new Set(["agent-live"]);
    const table = new RowMeasurementTable({
      heightKindOf: kindOfPrefixedKey,
      isRowRevealing: (rowKey) => revealingRowKeys.has(rowKey),
    });
    table.acceptedHeight("agent-a", 160);
    table.acceptedHeight("agent-b", 300);
    expect(table.publishEstimates()).toBe(true);
    expect(table.heightOf("agent-unmeasured")).toBe(160);

    // Its own heights are remembered, so it lays out where it stands. Its first height equals
    // agent-b's, which it never put in the sample and so must not take out.
    table.acceptedHeight("agent-live", 300);
    expect(table.acceptedHeight("agent-live", 400)).toBe(400);
    expect(table.heightOf("agent-live")).toBe(400);
    expect(table.publishEstimates()).toBe(false);
    expect(table.heightOf("agent-unmeasured")).toBe(160);

    // Settled, it joins at its last height, once: a later height replaces it.
    revealingRowKeys.delete("agent-live");
    expect(table.publishEstimates()).toBe(true);
    expect(table.heightOf("agent-unmeasured")).toBe(300);
    expect(table.publishEstimates()).toBe(false);
    table.acceptedHeight("agent-live", 500);
    expect(table.publishEstimates()).toBe(false);
    expect(table.heightOf("agent-unmeasured")).toBe(300);
  });
});

describe("the measurement table — a line of height on body length", () => {
  /** A row reports the body length its key ends in, `agent-a-200`; `agent-a` reports none. */
  function bodyLengthOfSuffixedKey(rowKey: string): number | undefined {
    const bodyLength = Number(rowKey.slice(rowKey.lastIndexOf("-") + 1));
    return Number.isNaN(bodyLength) ? undefined : bodyLength;
  }

  function lineTable(): RowMeasurementTable {
    return new RowMeasurementTable({
      heightKindOf: kindOfPrefixedKey,
      bodyLengthOf: bodyLengthOfSuffixedKey,
    });
  }

  it("estimates an unmeasured row on its kind's line, once published, never below the floor", () => {
    // One height per kind cannot fit: a reply's height follows its body, which its kind does not
    // say. Heights 100 + 0.5 px per byte, measured at three lengths.
    const table = lineTable();
    const agentSeedPx = ROW_HEIGHT_SEED_REM["agent-message"] * INITIAL_ROOT_FONT_SIZE_PX;
    table.acceptedHeight("agent-a-200", 200);
    table.acceptedHeight("agent-b-400", 300);
    table.acceptedHeight("agent-c-600", 400);
    // Rows already laid out keep the estimate they were laid out at until it is published.
    expect(table.heightOf("agent-unmeasured-1000")).toBe(agentSeedPx);

    expect(table.publishEstimates()).toBe(true);
    expect(table.heightOf("agent-unmeasured-1000")).toBe(600);
    // Below the shortest measured row the line would go under it; the kind's smallest height holds.
    expect(table.heightOf("agent-unmeasured-0")).toBe(200);
    // A row of the kind that reports no length takes the kind's median.
    expect(table.heightOf("agent-unmeasured")).toBe(300);
    // Nothing measured since, so nothing moves and the caller has nothing to re-lay out.
    expect(table.publishEstimates()).toBe(false);
  });

  it("falls back to the median over equal lengths or a slope that is negative", () => {
    // A line through one length has no slope, and a longer body is never a shorter row.
    const equalLengths = lineTable();
    equalLengths.acceptedHeight("agent-a-300", 120);
    equalLengths.acceptedHeight("agent-b-300", 180);
    equalLengths.acceptedHeight("agent-c-300", 240);
    equalLengths.publishEstimates();
    expect(equalLengths.heightOf("agent-unmeasured-5000")).toBe(180);

    const negativeSlope = lineTable();
    negativeSlope.acceptedHeight("agent-a-100", 300);
    negativeSlope.acceptedHeight("agent-b-900", 100);
    negativeSlope.acceptedHeight("agent-c-500", 200);
    negativeSlope.publishEstimates();
    expect(negativeSlope.heightOf("agent-unmeasured-5000")).toBe(200);
  });

  it("estimates an open call no taller than it draws with its output cut, once published", () => {
    // A call's output is cut at a share of the visible flow, so a longer body past the cut draws
    // no taller; on its line alone, a long call read above the reader would land far too tall.
    let viewportHeightPx: number | undefined;
    const table = new RowMeasurementTable({
      heightKindOf: () => "tool-call-expanded",
      bodyLengthOf: bodyLengthOfSuffixedKey,
      viewportHeightPx: () => viewportHeightPx,
    });
    table.acceptedHeight("call-a-200", 200);
    table.acceptedHeight("call-b-400", 300);
    table.acceptedHeight("call-c-600", 400);
    // Before the flow is measured there is no cut to cap at, so the line stands.
    table.publishEstimates();
    expect(table.heightOf("call-unmeasured-100000")).toBe(50_100);

    viewportHeightPx = 800;
    const cutAt800Px = cutCallHeightPx(800, INITIAL_ROOT_FONT_SIZE_PX);
    expect(cutAt800Px).toBeGreaterThan(200);
    // Laid out rows keep their estimate until it is published, and the cap is a move.
    expect(table.heightOf("call-unmeasured-100000")).toBe(50_100);
    expect(table.publishEstimates()).toBe(true);
    expect(table.heightOf("call-unmeasured-100000")).toBe(cutAt800Px);
    expect(table.estimatedHeightOf("call-new", "tool-call-expanded", 100_000)).toBe(cutAt800Px);
    // A call short of the cut keeps its line.
    expect(table.heightOf("call-unmeasured-0")).toBe(200);
    expect(table.smallestEstimatePx).toBeLessThanOrEqual(cutAt800Px);

    // A taller flow cuts lower, once published.
    viewportHeightPx = 1_600;
    expect(table.publishEstimates()).toBe(true);
    expect(table.heightOf("call-unmeasured-100000")).toBe(
      cutCallHeightPx(1_600, INITIAL_ROOT_FONT_SIZE_PX),
    );
  });

  it("estimates a call whose output was opened whole no shorter than its cut, and past it", () => {
    // Only an output taller than its cut can be opened, and it then draws whole: held to an open
    // call's cap, a long opened output read above the reader would land far too short.
    let viewportHeightPx: number | undefined = undefined;
    const table = new RowMeasurementTable({
      heightKindOf: () => "tool-call-output-opened",
      bodyLengthOf: bodyLengthOfSuffixedKey,
      viewportHeightPx: () => viewportHeightPx,
    });
    table.acceptedHeight("call-a-200", 200);
    table.acceptedHeight("call-b-400", 300);
    table.acceptedHeight("call-c-600", 400);
    // Before the flow is measured there is no cut to hold to, so the line stands.
    table.publishEstimates();
    expect(table.heightOf("call-unmeasured-0")).toBe(200);

    viewportHeightPx = 800;
    const cutAt800Px = cutCallHeightPx(800, INITIAL_ROOT_FONT_SIZE_PX);
    expect(cutAt800Px).toBeGreaterThan(200);
    expect(table.publishEstimates()).toBe(true);
    expect(table.heightOf("call-unmeasured-0")).toBe(cutAt800Px);
    expect(table.estimatedHeightOf("call-new", "tool-call-output-opened", 0)).toBe(cutAt800Px);
    expect(table.heightOf("call-unmeasured-100000")).toBe(50_100);
  });
});

describe("the measurement table — the idle trim", () => {
  it("forgets every remembered height but the rows named", () => {
    const table = new RowMeasurementTable();
    for (const rowKey of ["row-a", "row-b", "row-c"]) {
      table.acceptedHeight(rowKey, 40);
    }
    table.forgetAllExcept(["row-b"]);
    expect(table.rememberedHeightOf("row-a")).toBeUndefined();
    expect(table.rememberedHeightOf("row-c")).toBeUndefined();
    expect(table.rememberedHeightOf("row-b")).toBe(40);
  });
});
