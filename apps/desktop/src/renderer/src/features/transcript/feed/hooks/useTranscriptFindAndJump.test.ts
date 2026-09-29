// The wiring between a jump's answer and the acts that reach the row it names.
//
// WHAT IS ONLY TRUE HERE. `ledger-jump.test.ts` asks which act each absence DESERVES over
// a window. It cannot see the seam between that answer and the fold: which act actually
// opens the chapter holding the row, and which it must leave alone. Both halves are failure
// modes a mounted feed hides — an act that opens nothing scrolls nowhere and looks like a
// slow render, and an act that closes an open chapter takes the rest of a run off screen
// while landing on its row.
//
// THE FIXTURE IS ONE FINISHED RUN, so a row inside it is held by the chapter fold whenever
// the reader has not opened that chapter.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type LedgerChapter } from "@renderer/console/ledger/structure/index.js";
import { useVisibleLedgerWindow } from "../../window/hooks/useVisibleTranscriptWindow.js";
import { deriveLedgerWindow } from "@renderer/console/ledger/pane/window/ledger-window.js";
import { foldChapterHeaders } from "@renderer/console/ledger/pane/feed/model/ledger-chapter-fold.js";
import { foldedMessageChapterLog } from "../../run-group-logs.test-support.js";
import { TERMINAL_RUN_ID } from "../../transcript-logs.test-support.js";
import { useLedgerFindAndJump, type LedgerFindAndJump } from "./useTranscriptFindAndJump.js";

/** The loaded projection of the finished run, before any fold. */
const UNFURLED_WINDOW = deriveLedgerWindow(foldedMessageChapterLog(), false);

/** Every act the seam can perform, recorded in the order it performed them. */
interface RecordedActs {
  readonly performed: string[];
  readonly toggleChapter: (chapter: LedgerChapter) => void;
  readonly jumpToRow: (rowId: string) => void;
}

function recordingActs(): RecordedActs {
  const performed: string[] = [];
  return {
    performed,
    toggleChapter: (chapter: LedgerChapter) => performed.push(`toggle-chapter:${chapter.runId}`),
    jumpToRow: (rowId: string) => performed.push(`jump:${rowId}`),
  };
}

/**
 * The seam over a ledger folded by the chapters `openedTerminalRunIds` leaves shut,
 * asked about `query`.
 *
 * The fold is computed once outside the render, because the window is an identity a
 * memo inside the seam keys on — re-folding per render would exercise the memos rather
 * than the wiring.
 */
function askAbout(
  query: string,
  acts: RecordedActs,
  openedTerminalRunIds: ReadonlySet<string>,
): LedgerFindAndJump {
  const chapterFold = foldChapterHeaders(UNFURLED_WINDOW, openedTerminalRunIds);
  const { result } = renderHook(() => {
    const visible = useVisibleLedgerWindow(chapterFold.window, chapterFold.window.viewportRows);
    return useLedgerFindAndJump({
      unfurledWindow: UNFURLED_WINDOW,
      narrowedWindow: UNFURLED_WINDOW,
      foldedWindow: chapterFold.window,
      filteredAwayRows: [],
      foldedAwayRows: chapterFold.removedRows,
      visible,
      openedTerminalRunIds,
      toggleChapter: acts.toggleChapter,
      setFilter: () => undefined,
      jumpToRow: acts.jumpToRow,
      focusLedgerSurface: () => undefined,
    });
  });
  act(() => {
    result.current.find.setQuery(query);
  });
  return result.current;
}

describe("the act a folded chapter's row reaches", () => {
  const OPENED_CHAPTER = new Set([TERMINAL_RUN_ID]);

  it("derives a chapter that folds rows away, or every case below is vacuous", () => {
    expect(UNFURLED_WINDOW.chapterByHeaderKey.has(TERMINAL_RUN_ID)).toBe(true);
    expect(
      foldChapterHeaders(UNFURLED_WINDOW, new Set<string>()).removedRows.length,
    ).toBeGreaterThan(0);
  });

  it("opens the shut chapter holding the row", () => {
    const acts = recordingActs();
    const foldedRowId =
      foldChapterHeaders(UNFURLED_WINDOW, new Set<string>()).removedRows[0]?.id ?? "";

    const seam = askAbout(foldedRowId, acts, new Set<string>());
    expect(seam.outcome?.status).toBe("folded-into-chapter");
    expect(seam.reach?.label).toBe("Open that chapter and go to it");

    seam.reach?.perform();
    expect(acts.performed).toStrictEqual([`toggle-chapter:${TERMINAL_RUN_ID}`]);
  });

  it("negative control: a row on screen is offered no act at all", () => {
    // Without this the case above would pass over a resolver that answered for every
    // outcome, which would put a chapter-opening button beside a row already in view.
    const acts = recordingActs();
    const visibleRowId =
      foldChapterHeaders(UNFURLED_WINDOW, OPENED_CHAPTER).window.rows[0]?.id ?? "";

    const seam = askAbout(visibleRowId, acts, OPENED_CHAPTER);
    expect(seam.outcome?.status).toBe("found");
    expect(seam.reach).toBeUndefined();
    expect(acts.performed).toStrictEqual([]);
  });
});
