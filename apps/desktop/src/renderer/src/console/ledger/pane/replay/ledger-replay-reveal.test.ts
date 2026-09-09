// What a replay lets the viewport have at one position — and, for a folded chapter,
// what it must not take away with the rows.
//
// The engine's own behaviour is `replay-model.test.ts`', and what happens to a WALK
// when the projection under it moves is `ledger-replay-window.test.ts`'. This file is
// about the translation from a POSITION to viewport rows, which is where a synthetic
// header keyed by its run id and a revealed set keyed by event ids meet — the one
// question that needs no walk at all, which is why it is driven over a parked engine
// rather than through the replay hook.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../../core/index.js";
import { ReplayEngine, type ReplayPosition } from "../../structure/index.js";
import { useReplayRevealedRows } from "./ledger-replay-reveal.js";
import { CHAPTER_RUN_ID, ONE_ROW_MS, foldedWindow } from "./ledger-replay.test-support.js";
import { type LedgerWindowModel } from "../window/ledger-window.js";

describe("what a replay reveals of a chapter", () => {
  const RECEIPT_ELAPSED_MS = 3 * ONE_ROW_MS;
  const INSIDE_CHAPTER_ELAPSED_MS = 1 * ONE_ROW_MS;

  /**
   * The real engine over that window, parked at one elapsed position.
   *
   * The engine is built exactly as `useLedgerReplay` builds it — from the window's
   * projected rows and their wire instants — so the ids in the position are the ids
   * the production reveal is tested against.
   */
  function positionAt(ledgerWindow: LedgerWindowModel, elapsedMs: number): ReplayPosition {
    const engine = new ReplayEngine({
      clock: new ManualClock(),
      rows: ledgerWindow.rows.map((row) => ({ rowId: row.id, occurredAt: row.timestamp })),
    });
    engine.scrubTo(elapsedMs);
    return engine.position();
  }

  /** The keys the reveal admits, for a window and a position. */
  function revealedKeysAt(ledgerWindow: LedgerWindowModel, elapsedMs: number): readonly string[] {
    const { result } = renderHook(() =>
      useReplayRevealedRows(ledgerWindow, positionAt(ledgerWindow, elapsedMs)),
    );
    return result.current.map((row) => row.key);
  }

  it("renders exactly the unreplayed window at the tail", () => {
    const ledgerWindow = foldedWindow();
    const tailElapsedMs = positionAt(ledgerWindow, Number.MAX_SAFE_INTEGER).spanMs;
    expect(revealedKeysAt(ledgerWindow, tailElapsedMs)).toStrictEqual(
      ledgerWindow.viewportRows.map((row) => row.key),
    );
    // Which includes the header, and the receipt is under it rather than orphaned.
    expect(revealedKeysAt(ledgerWindow, tailElapsedMs)).toContain(CHAPTER_RUN_ID);
  });

  it("admits the header the moment its chapter is reached, receipt attached", () => {
    const ledgerWindow = foldedWindow();
    const revealed = revealedKeysAt(ledgerWindow, RECEIPT_ELAPSED_MS);
    const receiptRowId = ledgerWindow.viewportRows.find(
      (row) => row.parentKey === CHAPTER_RUN_ID,
    )?.key;
    expect(receiptRowId).toBeDefined();
    expect(revealed).toContain(CHAPTER_RUN_ID);
    expect(revealed).toContain(receiptRowId);
    // Header before receipt, so the chapter reads as a chapter rather than as a row
    // that happens to precede one.
    expect(revealed.indexOf(CHAPTER_RUN_ID)).toBeLessThan(revealed.indexOf(receiptRowId ?? ""));
  });

  it("admits neither while the position is still before the chapter", () => {
    const ledgerWindow = foldedWindow();
    const revealed = revealedKeysAt(ledgerWindow, 0);
    const chapterMemberKeys = new Set(
      ledgerWindow.viewportRows
        .filter((row) => row.parentKey === CHAPTER_RUN_ID)
        .map((row) => row.key),
    );
    expect(revealed).not.toContain(CHAPTER_RUN_ID);
    expect(revealed.some((key) => chapterMemberKeys.has(key))).toBe(false);
    expect(revealed).toHaveLength(1);
  });

  it("admits the header of an opened chapter the position is inside", () => {
    // An opened chapter carries its members, so there IS a position inside it — and
    // a member row on screen under no header is the orphan the cap counts as a
    // top-level row.
    const ledgerWindow = foldedWindow([CHAPTER_RUN_ID]);
    const revealed = revealedKeysAt(ledgerWindow, INSIDE_CHAPTER_ELAPSED_MS);
    expect(revealed).toContain(CHAPTER_RUN_ID);
    const revealedMembers = ledgerWindow.viewportRows.filter(
      (row) => row.parentKey === CHAPTER_RUN_ID && revealed.includes(row.key),
    );
    expect(revealedMembers.length).toBeGreaterThan(0);
    // And the chapter is not yet whole: this is a position inside it, not its end.
    expect(revealed.length).toBeLessThan(ledgerWindow.viewportRows.length);
  });

  it("negative control: matching header keys against the revealed ids strips every one", () => {
    // The old predicate, run over the same window at the same position. The engine
    // is built from projected rows, so a run id is in `revealedRowIds` at no
    // position — and this is what left the receipt on screen with no disclosure
    // above it even at the tail.
    const ledgerWindow = foldedWindow();
    const tailPosition = positionAt(ledgerWindow, Number.MAX_SAFE_INTEGER);
    const revealedRowIds = new Set(tailPosition.revealedRowIds);
    const byRevealedIdAlone = ledgerWindow.viewportRows
      .filter((row) => revealedRowIds.has(row.key))
      .map((row) => row.key);
    expect(byRevealedIdAlone).not.toContain(CHAPTER_RUN_ID);
    expect(revealedKeysAt(ledgerWindow, tailPosition.spanMs)).toContain(CHAPTER_RUN_ID);
  });
});
