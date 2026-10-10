// The measurement table's residuals as arithmetic, with no DOM: a shim answering zero for every
// rect would make each claim pass vacuously. The library's own answers are asserted in
// `controller.test.ts` and `chokepoint.test.ts`, and what reaches the table from an observed row
// in `virtualizer-options.test.ts`.

import { describe, expect, it } from "vitest";

import { RememberedRowHeights } from "#renderer/store/session/remembered-row-heights.js";
import { ROW_HEIGHT_SEED_REM, type RowHeightKind } from "../rows/height-kind.js";
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
