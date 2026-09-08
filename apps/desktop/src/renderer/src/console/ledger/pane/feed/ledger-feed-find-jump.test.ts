// The wiring between a jump's answer and the acts that reach the row it names.
//
// WHAT IS ONLY TRUE HERE. `ledger-jump.test.ts` asks which act each absence DESERVES over
// a window, and `ledger-superseded-fold.test.ts` asks what the band fold removes. Neither
// can see the seam between them: which of this ledger's folds an act actually opens, and
// which it must leave alone. Both halves of that are failure modes a mounted feed hides —
// an act that opens nothing scrolls nowhere and looks like a slow render, and an act that
// closes an open chapter takes the rest of a run off screen while landing on its row.
//
// THE FIXTURE IS ONE RUN THAT WAS REWOUND AND THEN FINISHED, so both folds are live over
// one window and a row can be held by either. That overlap is the whole subject: a reader
// who opened the chapter and folded the band has a row missing for a reason only one of
// the two acts reaches.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type LedgerChapter } from "../../structure/index.js";
import { LedgerRowRetention } from "../window/ledger-row-retention.js";
import { useVisibleLedgerWindow } from "../window/ledger-visible-window.js";
import { deriveLedgerWindow, type LedgerPipelineStage } from "../window/ledger-window.js";
import { foldChapterHeaders } from "./ledger-chapter-fold.js";
import { rewoundTerminalChapterLog } from "./ledger-chapter-logs.test-support.js";
import { TERMINAL_RUN_ID } from "./ledger-feed-logs.test-support.js";
import { foldSupersededBands } from "./ledger-superseded-fold.js";
import { useLedgerFindAndJump, type LedgerFindAndJump } from "./ledger-feed-find-jump.js";

/** The loaded projection of the rewound run, before any fold. */
const UNFURLED_WINDOW = deriveLedgerWindow(rewoundTerminalChapterLog(), false);

/** Every act the seam can perform, recorded in the order it performed them. */
interface RecordedActs {
  readonly performed: string[];
  readonly toggleChapter: (chapter: LedgerChapter) => void;
  readonly openSupersededBandOfRow: (bandKey: string) => void;
  readonly jumpToRow: (rowId: string) => void;
}

function recordingActs(): RecordedActs {
  const performed: string[] = [];
  return {
    performed,
    toggleChapter: (chapter: LedgerChapter) => performed.push(`toggle-chapter:${chapter.runId}`),
    openSupersededBandOfRow: (bandKey: string) => performed.push(`open-band:${bandKey}`),
    jumpToRow: (rowId: string) => performed.push(`jump:${rowId}`),
  };
}

/** The two folds this ledger has applied, and the rows each of them took. */
interface FoldedLedger {
  readonly chapterFold: LedgerPipelineStage;
  readonly bandFold: LedgerPipelineStage;
}

function foldLedger(
  openedTerminalRunIds: ReadonlySet<string>,
  foldedBandKeys: ReadonlySet<string>,
): FoldedLedger {
  const chapterFold = foldChapterHeaders(UNFURLED_WINDOW, openedTerminalRunIds);
  const bandFold = foldSupersededBands(
    chapterFold.window,
    foldedBandKeys,
    new LedgerRowRetention(),
  );
  return { chapterFold, bandFold };
}

/** Every band this window derives, by the key its header carries. */
function bandKeys(): readonly string[] {
  return [...UNFURLED_WINDOW.supersededBandByHeaderKey.keys()];
}

/**
 * The seam over a ledger whose chapter is open and whose one band is folded, asked
 * about `query`.
 *
 * The folds are computed once outside the render, because every window below is an
 * identity a memo inside the seam keys on — re-folding per render would exercise the
 * memos rather than the wiring.
 */
function askAbout(
  query: string,
  acts: RecordedActs,
  openedTerminalRunIds: ReadonlySet<string>,
  foldedBandKeys: ReadonlySet<string>,
): LedgerFindAndJump {
  const { chapterFold, bandFold } = foldLedger(openedTerminalRunIds, foldedBandKeys);
  const { result } = renderHook(() => {
    const visible = useVisibleLedgerWindow(
      bandFold.window,
      bandFold.window.viewportRows,
      bandFold.window.viewportRows,
    );
    return useLedgerFindAndJump({
      unfurledWindow: UNFURLED_WINDOW,
      narrowedWindow: UNFURLED_WINDOW,
      foldedWindow: bandFold.window,
      filteredAwayRows: [],
      foldedAwayRows: chapterFold.removedRows,
      bandFoldedAwayRows: bandFold.removedRows,
      visible,
      openedTerminalRunIds,
      toggleChapter: acts.toggleChapter,
      openSupersededBandOfRow: acts.openSupersededBandOfRow,
      setFilter: () => undefined,
      endReplay: () => undefined,
      jumpToRow: acts.jumpToRow,
      focusLedgerSurface: () => undefined,
    });
  });
  act(() => {
    result.current.find.setQuery(query);
  });
  return result.current;
}

describe("the act a folded band's row reaches", () => {
  const OPENED_CHAPTER = new Set([TERMINAL_RUN_ID]);

  it("derives one chapter and one band from the fixture, or every case below is vacuous", () => {
    expect(UNFURLED_WINDOW.chapterByHeaderKey.has(TERMINAL_RUN_ID)).toBe(true);
    expect(bandKeys()).toHaveLength(1);
    const { bandFold } = foldLedger(OPENED_CHAPTER, new Set(bandKeys()));
    expect(bandFold.removedRows.length).toBeGreaterThan(0);
  });

  it("offers the band's own act and shows the band, leaving the open chapter alone", () => {
    // THE DEFECT, END TO END. The row is missing because a band fold took it, the
    // classification calls that a fold, and the act resolver answered "no chapter is
    // holding it, so nothing reaches it" — printing a sentence with no way out over an
    // act that had been wired the whole time.
    const acts = recordingActs();
    const { bandFold } = foldLedger(OPENED_CHAPTER, new Set(bandKeys()));
    const foldedRowId = bandFold.removedRows[0]?.id ?? "";
    const [bandKey = ""] = bandKeys();

    const seam = askAbout(foldedRowId, acts, OPENED_CHAPTER, new Set(bandKeys()));
    expect(seam.outcome?.status).toBe("folded-into-chapter");
    expect(seam.reach?.label).toBe("Show that rewound band and go to it");

    seam.reach?.perform();
    // The band opens, and the chapter this reader already opened is not toggled shut —
    // which is what a toggle called unconditionally would do, taking the rest of the
    // finished run off screen on the way to one of its rows.
    expect(acts.performed).toStrictEqual([`open-band:${bandKey}`]);
  });

  it("opens the shut chapter instead when that is the fold holding the row", () => {
    // The outer fold answers first: a row inside a shut chapter is held by the chapter
    // whether or not a band inside it is folded too.
    const acts = recordingActs();
    const { bandFold } = foldLedger(OPENED_CHAPTER, new Set(bandKeys()));
    const foldedRowId = bandFold.removedRows[0]?.id ?? "";

    const seam = askAbout(foldedRowId, acts, new Set<string>(), new Set(bandKeys()));
    expect(seam.reach?.label).toBe("Open that chapter and go to it");

    seam.reach?.perform();
    // Both folds are holding this row, so the act opens both — an act that opened only
    // the chapter would scroll the ledger to a row still folded away.
    expect(acts.performed).toStrictEqual([
      `open-band:${bandKeys()[0] ?? ""}`,
      `toggle-chapter:${TERMINAL_RUN_ID}`,
    ]);
  });

  it("negative control: a row on screen is offered no act at all", () => {
    // Without this the cases above would pass over a resolver that answered for every
    // outcome, which would put a fold-opening button beside a row already in view.
    const acts = recordingActs();
    const { bandFold } = foldLedger(OPENED_CHAPTER, new Set<string>());
    const visibleRowId = bandFold.window.rows[0]?.id ?? "";

    const seam = askAbout(visibleRowId, acts, OPENED_CHAPTER, new Set<string>());
    expect(seam.outcome?.status).toBe("found");
    expect(seam.reach).toBeUndefined();
    expect(acts.performed).toStrictEqual([]);
  });
});
