// What a replay lets the viewport have — and, for a folded chapter, what it must
// not take away with the rows.
//
// The engine's own behaviour is `replay-model.test.ts`'; this file is about the
// translation from a position to viewport rows, which is where a synthetic header
// keyed by its run id and a revealed set keyed by event ids meet.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { ReplayEngine, type ReplayPosition } from "../../ledger/structure/index.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import { foldChapterHeaders } from "./ledger-chapter-fold.js";
import { useReplayRevealedRows } from "./ledger-replay-window.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "./ledger-window.js";

const SESSION_ID = "session-visible-window";

describe("what a replay reveals of a chapter", () => {
  const CHAPTER_RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";
  /** Row instants are one second apart, so an elapsed figure names a row by index. */
  const ONE_ROW_MS = 1000;
  const RECEIPT_ELAPSED_MS = 3 * ONE_ROW_MS;
  const INSIDE_CHAPTER_ELAPSED_MS = 1 * ONE_ROW_MS;

  /**
   * A finished run between two session-scoped rows.
   *
   * The leading general row is what makes "before the chapter" a position at all: a
   * folded chapter's receipt is otherwise the head of the engine's window, and every
   * position would be at or after it.
   */
  function chapteredLog(): readonly ConsoleSessionEvent[] {
    const at = (index: number): string =>
      new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString();
    const runPayload = { sessionId: SESSION_ID, runId: CHAPTER_RUN_ID };
    return [
      {
        id: "e0",
        sessionId: SESSION_ID,
        sequence: 0,
        kind: "user.message",
        occurredAt: at(0),
        payload: {},
      },
      {
        id: "e1",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "run.running",
        occurredAt: at(1),
        payload: runPayload,
      },
      {
        id: "e2",
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "assistant.message",
        occurredAt: at(2),
        payload: runPayload,
      },
      {
        id: "e3",
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "run.completed",
        occurredAt: at(3),
        payload: runPayload,
      },
      {
        id: "e4",
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "user.message",
        occurredAt: at(4),
        payload: {},
      },
    ];
  }

  /** That log, folded — shut by default, or with the chapter a person opened. */
  function foldedWindow(openedRunIds: readonly string[] = []): LedgerWindowModel {
    return foldChapterHeaders(deriveLedgerWindow(chapteredLog(), false), new Set(openedRunIds));
  }

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
