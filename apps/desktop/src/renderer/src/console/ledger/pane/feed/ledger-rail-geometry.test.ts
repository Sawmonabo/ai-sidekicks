// Where the rail puts a mark, and where it puts the thumb.
//
// TWO FRACTIONS OVER ONE ORDERING, and the whole point of this file is that they are
// the same ordering. A mark placed by sequence distance and a thumb placed by row
// index are two axes, and a folded chapter pulls them apart — one header band stands
// for ten sequences — so a visible row's mark can sit outside the thumb that is
// supposed to be pointing at it. The last case here proves that can no longer happen
// and its control shows the shipped pair where it could.
//
// WHICH ROWS THE WINDOW HOLDS is `ledger-visible-window.test.ts`'. This file measures
// placement, and the geometry half of it is driven with no window at all.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LEDGER_OVERSCAN_ROWS } from "../../frame/frame-bounds.js";
import { railViewportBand } from "../../structure/index.js";
import { type ConsoleSessionEvent } from "../../../store/index.js";
import { foldChapterHeaders } from "./ledger-chapter-fold.js";
import { ledgerFixtureStampAt } from "./ledger-feed-logs.test-support.js";
import { useRailGeometry, useVisibleLedgerWindow } from "../window/ledger-visible-window.js";
import {
  EVERY_ROW_QUERY,
  VISIBLE_WINDOW_SESSION_ID,
} from "../window/ledger-visible-window.test-support.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "../window/ledger-window.js";

describe("the rail's two fractions", () => {
  const RAIL_WINDOW_ROW_COUNT = 300;
  const VISIBLE_ROW_COUNT = 5;
  const FIRST_VISIBLE_INDEX = 100;

  it("measures the range the box intersects, not the range it mounts", () => {
    const { result } = renderHook(() =>
      useRailGeometry(
        {
          startIndex: FIRST_VISIBLE_INDEX,
          endIndex: FIRST_VISIBLE_INDEX + VISIBLE_ROW_COUNT - 1,
        },
        RAIL_WINDOW_ROW_COUNT,
      ),
    );
    expect(result.current.extent).toBeCloseTo(VISIBLE_ROW_COUNT / RAIL_WINDOW_ROW_COUNT, 6);
    // One denominator for both readings — the retained row count — which is what
    // makes the thumb the span of the bands the marks are placed in.
    expect(result.current.position).toBeCloseTo(FIRST_VISIBLE_INDEX / RAIL_WINDOW_ROW_COUNT, 6);
  });

  it("negative control: the overscanned mount range gives a different, wrong answer", () => {
    // The mounted range is the visible one widened by the overscan at both edges,
    // which is exactly what the geometry used to be handed. Feeding it here shows
    // the two readings are not the same number, so the case above is discriminating
    // rather than passing over either.
    const { result } = renderHook(() =>
      useRailGeometry(
        {
          startIndex: FIRST_VISIBLE_INDEX - LEDGER_OVERSCAN_ROWS,
          endIndex: FIRST_VISIBLE_INDEX + VISIBLE_ROW_COUNT - 1 + LEDGER_OVERSCAN_ROWS,
        },
        RAIL_WINDOW_ROW_COUNT,
      ),
    );
    expect(result.current.extent).toBeCloseTo(
      (VISIBLE_ROW_COUNT + 2 * LEDGER_OVERSCAN_ROWS) / RAIL_WINDOW_ROW_COUNT,
      6,
    );
    expect(result.current.position).toBeLessThan(FIRST_VISIBLE_INDEX / RAIL_WINDOW_ROW_COUNT);
  });

  it("ends a tail viewport's thumb exactly at the rail's foot", () => {
    // Rows 90 to 99 of 100: the arithmetic that shipped read 90.9% down with 10%
    // of height, and `thumbStyle` clamped the two independently, so the thumb ran
    // off the end of the rail rather than finishing at it.
    const { result } = renderHook(() => useRailGeometry({ startIndex: 90, endIndex: 99 }, 100));
    expect(result.current.position + result.current.extent).toBeCloseTo(1, 12);
  });

  it("negative control: the old top-against-the-last-index form overruns", () => {
    const staleTop = 90 / (100 - 1);
    const { result } = renderHook(() => useRailGeometry({ startIndex: 90, endIndex: 99 }, 100));
    expect(staleTop + result.current.extent).toBeGreaterThan(1);
    expect(result.current.position).toBeLessThan(staleTop);
  });

  it("gives a viewport spanning every row the whole rail", () => {
    const { result } = renderHook(() =>
      useRailGeometry(
        { startIndex: 0, endIndex: RAIL_WINDOW_ROW_COUNT - 1 },
        RAIL_WINDOW_ROW_COUNT,
      ),
    );
    expect(result.current).toStrictEqual({ position: 0, extent: 1 });
  });

  it("negative control: an unmeasured box claims the whole rail rather than the head", () => {
    const { result } = renderHook(() => useRailGeometry(undefined, RAIL_WINDOW_ROW_COUNT));
    expect(result.current).toStrictEqual({ position: 0, extent: 1 });
  });

  it("negative control: an empty window claims the whole rail too", () => {
    const { result } = renderHook(() => useRailGeometry({ startIndex: 0, endIndex: 0 }, 0));
    expect(result.current).toStrictEqual({ position: 0, extent: 1 });
  });
});

describe("the marks and the thumb are one measurement over one ordering", () => {
  const RUN_ID = "run-a";
  const FOLDED_RUN_ROW_COUNT = 10;

  /**
   * A log a folded chapter and a filter both act on.
   *
   * A message, a finished run of ten rows, then two more messages. Folding the run
   * leaves ONE header band standing for ten sequences, which is the shape that
   * pulls row order and sequence order apart — and it is produced by the real fold
   * rather than assembled here, so the ordering the rail is handed is the ordering
   * a mounted feed renders.
   */
  function foldedWindow(): LedgerWindowModel {
    const log: ConsoleSessionEvent[] = [messageEvent(0)];
    for (let position = 0; position < FOLDED_RUN_ROW_COUNT; position += 1) {
      const isLast = position === FOLDED_RUN_ROW_COUNT - 1;
      log.push(runEvent(log.length, isLast ? "run.completed" : "run.running"));
    }
    // One at a time: both arguments of a two-value push are evaluated before
    // either lands, so a shared `log.length` would mint two events on one sequence
    // and one id.
    log.push(messageEvent(log.length));
    log.push(messageEvent(log.length));
    return foldChapterHeaders(deriveLedgerWindow(log, false), new Set<string>());
  }

  function messageEvent(sequence: number): ConsoleSessionEvent {
    return {
      id: `event-${String(sequence)}`,
      sessionId: VISIBLE_WINDOW_SESSION_ID,
      sequence,
      kind: EVERY_ROW_QUERY,
      occurredAt: ledgerFixtureStampAt(sequence),
      payload: {},
    };
  }

  function runEvent(sequence: number, kind: string): ConsoleSessionEvent {
    return {
      id: `event-${String(sequence)}`,
      sessionId: VISIBLE_WINDOW_SESSION_ID,
      sequence,
      kind,
      occurredAt: ledgerFixtureStampAt(sequence),
      payload: { sessionId: VISIBLE_WINDOW_SESSION_ID, runId: RUN_ID },
    };
  }

  /** Every viewport window of `visibleRowCount` rows over an ordering of `rowCount`. */
  function everyViewport(
    rowCount: number,
    visibleRowCount: number,
  ): readonly { readonly startIndex: number; readonly endIndex: number }[] {
    const windows: { startIndex: number; endIndex: number }[] = [];
    for (let startIndex = 0; startIndex + visibleRowCount <= rowCount; startIndex += 1) {
      windows.push({ startIndex, endIndex: startIndex + visibleRowCount - 1 });
    }
    return windows;
  }

  const VISIBLE_ROW_COUNT = 2;

  it("keeps every visible row's mark inside the thumb, at every scroll position", () => {
    const ledgerWindow = foldedWindow();
    const retained = ledgerWindow.viewportRows;
    // The fold really did insert a band no projected row stands behind.
    expect(retained.map((row) => row.key)).toContain(RUN_ID);
    expect(retained.length).toBeGreaterThan(ledgerWindow.rows.length);

    const { result } = renderHook(() => useVisibleLedgerWindow(ledgerWindow, retained, retained));
    const positionByRowId = new Map(
      result.current.railModel.model().ticks.map((tick) => [tick.rowId, tick.position]),
    );
    let markedWindowCount = 0;
    for (const viewport of everyViewport(retained.length, VISIBLE_ROW_COUNT)) {
      const band = railViewportBand(viewport.startIndex, viewport.endIndex, retained.length);
      for (const row of retained.slice(viewport.startIndex, viewport.endIndex + 1)) {
        const position = positionByRowId.get(row.key);
        if (position === undefined) {
          continue;
        }
        markedWindowCount += 1;
        expect(position).toBeGreaterThanOrEqual(band.position);
        expect(position).toBeLessThanOrEqual(band.position + band.extent);
      }
    }
    expect(markedWindowCount).toBeGreaterThan(0);
  });

  it("negative control: the sequence axis and the last-index thumb disagree somewhere", () => {
    // The two derivations that shipped, evaluated over the same folded window: a
    // mark placed by sequence distance and a thumb placed by row index against the
    // last index. At least one scroll position puts a visible row's mark outside
    // the thumb meant to be pointing at it, which is what the case above proves
    // can no longer happen.
    const ledgerWindow = foldedWindow();
    const retained = ledgerWindow.viewportRows;
    const rows = ledgerWindow.rows;
    const firstSequence = rows[0]?.sequence ?? 0;
    const sequenceSpan = (rows[rows.length - 1]?.sequence ?? 0) - firstSequence;
    const bySequence = new Map(
      rows.map((row) => [row.id, (row.sequence - firstSequence) / sequenceSpan]),
    );
    let escapedCount = 0;
    for (const viewport of everyViewport(retained.length, VISIBLE_ROW_COUNT)) {
      const staleTop = viewport.startIndex / Math.max(1, retained.length - 1);
      const staleHeight = VISIBLE_ROW_COUNT / retained.length;
      for (const row of retained.slice(viewport.startIndex, viewport.endIndex + 1)) {
        const position = bySequence.get(row.key);
        if (position === undefined) {
          continue;
        }
        if (position < staleTop || position > staleTop + staleHeight) {
          escapedCount += 1;
        }
      }
    }
    expect(escapedCount).toBeGreaterThan(0);
  });
});
