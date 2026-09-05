// The chapter fold, driven with no store and no React — what it admits per row.
//
// `LedgerFeedRows.test.tsx` proves the fold reaches the screen; this file proves what
// it selects, which the mounted feed cannot show at this size: the cases below need a
// run longer than the chapter cap, and a virtualized feed mounts a range rather than
// a window whatever the fold admitted.

import type { TimelineRow } from "@ai-sidekicks/contracts";
import { act, renderHook } from "@testing-library/react";
import { createElement, useCallback, useState } from "react";
import { describe, expect, it } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../../bridge/scenarios/ledger-quiet.js";
import {
  CHAPTER_VISIBLE_ROW_CAP,
  ChapterCollapseState,
  type LedgerChapter,
} from "../../structure/index.js";
import { type ConsoleSessionEvent } from "../../../store/index.js";
import {
  chapterRowIdsWithinCap,
  foldChapterHeaders,
  narrowChapterToAdmittedRows,
  useChapterDisclosure,
  type LedgerChapterDisclosure,
} from "./ledger-chapter-fold.js";
import { ledgerFixtureStampAt } from "./ledger-feed-logs.test-support.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "../window/ledger-window.js";

const SESSION_ID = "session-chapter-cap";
const RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";
const ROWS_PAST_THE_CAP = 5;

/**
 * One finished run of `memberCount` rows, the last of which is its terminal.
 *
 * A single chapter and nothing else, so every figure below is that chapter's: a
 * session-scoped row beside it would be counted by the fold's top-level arm and the
 * cap's arithmetic would stop being readable from the totals.
 */
function oneRunLog(memberCount: number): readonly ConsoleSessionEvent[] {
  const payload = { sessionId: SESSION_ID, runId: RUN_ID };
  return Array.from({ length: memberCount }, (_unused, index) => ({
    id: `event-${String(index)}`,
    sessionId: SESSION_ID,
    sequence: index,
    kind: index === memberCount - 1 ? "run.completed" : "assistant.message",
    occurredAt: ledgerFixtureStampAt(index),
    payload,
  }));
}

/** That log, folded, with the chapter open or shut. */
function foldedOverOneRun(memberCount: number, isOpen: boolean): LedgerWindowModel {
  return foldChapterHeaders(
    deriveLedgerWindow(oneRunLog(memberCount), false),
    new Set(isOpen ? [RUN_ID] : []),
  );
}

/** The chapter's rows in the viewport, which is every row hanging off its header. */
function renderedMemberKeys(model: LedgerWindowModel): readonly string[] {
  return model.viewportRows.filter((row) => row.parentKey === RUN_ID).map((row) => row.key);
}

describe("an opened chapter admits the cap's own window and no more", () => {
  const OVER_CAP_MEMBER_COUNT = CHAPTER_VISIBLE_ROW_CAP + ROWS_PAST_THE_CAP;

  it("renders exactly the cap when a run longer than it is opened", () => {
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, true);
    expect(renderedMemberKeys(model)).toHaveLength(CHAPTER_VISIBLE_ROW_CAP);
    // And the body lookup agrees, so nothing can draw a row the cap kept out.
    expect(model.rows).toHaveLength(CHAPTER_VISIBLE_ROW_CAP);
  });

  it("keeps the newest rows and clips the run's older head", () => {
    // Newest and not oldest because the chapter body clips behind a TOP-edge fade.
    // Reading it the other way round would fade a long run's newest work out of view
    // and leave its opening on screen.
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, true);
    const everyMemberId = deriveLedgerWindow(oneRunLog(OVER_CAP_MEMBER_COUNT), false).rows.map(
      (row: TimelineRow) => row.id,
    );
    const rendered = new Set(renderedMemberKeys(model));
    for (const clippedId of everyMemberId.slice(0, ROWS_PAST_THE_CAP)) {
      expect(rendered.has(clippedId)).toBe(false);
    }
    for (const keptId of everyMemberId.slice(ROWS_PAST_THE_CAP)) {
      expect(rendered.has(keptId)).toBe(true);
    }
  });

  it("reports as clipped exactly what it did not render", () => {
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, true);
    const chapter = model.chapterByHeaderKey.get(RUN_ID);
    expect(chapter?.clippedRowCount).toBe(ROWS_PAST_THE_CAP);
    expect((chapter?.rowCount ?? 0) - renderedMemberKeys(model).length).toBe(
      chapter?.clippedRowCount,
    );
  });

  it("opens a chapter under the cap whole", () => {
    const memberCount = CHAPTER_VISIBLE_ROW_CAP - 1;
    const model = foldedOverOneRun(memberCount, true);
    expect(renderedMemberKeys(model)).toHaveLength(memberCount);
    expect(model.chapterByHeaderKey.get(RUN_ID)?.clippedRowCount).toBe(0);
  });

  it("negative control: the same chapter shut still renders its receipt alone", () => {
    // Without this every case above would pass over a fold that had stopped
    // admitting anything, which is a chapter nobody can open at all.
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, false);
    expect(renderedMemberKeys(model)).toHaveLength(1);
    expect(model.rows[0]?.type).toBe("run.completed");
  });

  it("negative control: the cap's selector returns a short chapter by identity", () => {
    // Without this the selection above could have been written as an unconditional
    // slice, which allocates a second array for every chapter in every fold.
    const shortRowIds = ["a", "b", "c"];
    expect(chapterRowIdsWithinCap(shortRowIds)).toBe(shortRowIds);
    expect(
      chapterRowIdsWithinCap(
        Array.from({ length: CHAPTER_VISIBLE_ROW_CAP + 1 }, (_u, i) => `r${String(i)}`),
      ),
    ).toHaveLength(CHAPTER_VISIBLE_ROW_CAP);
  });
});

describe("a chapter re-sealed over the rows a narrowing admitted", () => {
  const MEMBER_COUNT = 6;

  /** The chapter as the fold sealed it, before any narrowing. */
  function wholeChapter(): NonNullable<ReturnType<typeof chapterOf>> {
    const chapter = chapterOf(deriveLedgerWindow(oneRunLog(MEMBER_COUNT), false));
    if (chapter === undefined) {
      throw new Error("the fold produced no chapter for a finished run");
    }
    return chapter;
  }

  function chapterOf(model: LedgerWindowModel) {
    return model.chapterByHeaderKey.get(RUN_ID);
  }

  it("re-counts membership and carries the run's own facts through untouched", () => {
    const chapter = wholeChapter();
    const admitted = new Set(chapter.rowIds.slice(0, 2));
    const narrowed = narrowChapterToAdmittedRows(chapter, admitted);
    expect(narrowed?.rowCount).toBe(2);
    expect(narrowed?.rowIds).toStrictEqual([...admitted]);
    // Lifecycle and the terminal are facts about the SESSION. Re-deriving them over
    // the admitted rows would turn a finished run live the moment a narrowing
    // excluded its `run.completed` row, and rule 7 would then keep it open forever.
    expect(narrowed?.lifecycle).toBe("terminal");
    expect(narrowed?.terminalEventType).toBe(chapter.terminalEventType);
    expect(narrowed?.terminalRowId).toBe(chapter.terminalRowId);
  });

  it("answers undefined for a chapter the narrowing admits no row of", () => {
    expect(narrowChapterToAdmittedRows(wholeChapter(), new Set<string>())).toBeUndefined();
  });

  it("negative control: a narrowing that took nothing returns the chapter by identity", () => {
    const chapter = wholeChapter();
    expect(narrowChapterToAdmittedRows(chapter, new Set(chapter.rowIds))).toBe(chapter);
  });
});

/**
 * A finished chapter to press the disclosure on.
 *
 * Derived through the real projection rather than written out, so the object the
 * toggle is handed is the one the fold produces — a hand-built chapter would let a
 * disclosure that keyed on the wrong member pass.
 */
function terminalChapter(): LedgerChapter {
  const chapter = deriveLedgerWindow(oneRunLog(3), false).chapterByHeaderKey.get(RUN_ID);
  if (chapter === undefined) {
    throw new Error("the fixture log produced no terminal chapter");
  }
  return chapter;
}

/**
 * The arrangement this hook replaced: both halves held for the life of the MOUNT.
 *
 * Not a stand-in — it drives the real `ChapterCollapseState` and publishes its real
 * opened set, and differs in the one thing these cases are about: what the holder is
 * keyed on.
 */
function useMountScopedChapterDisclosure(): LedgerChapterDisclosure {
  const [collapseState] = useState(() => new ChapterCollapseState());
  const [openedTerminalRunIds, setOpenedTerminalRunIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const publish = useCallback(() => {
    setOpenedTerminalRunIds(new Set(collapseState.openedTerminalRunIds));
  }, [collapseState]);
  const toggle = useCallback(
    (chapter: LedgerChapter) => {
      if (collapseState.isOpen(chapter)) {
        collapseState.close(chapter);
      } else {
        collapseState.open(chapter);
      }
      publish();
    },
    [collapseState, publish],
  );
  return { openedTerminalRunIds, toggle, collapseAllTerminal: () => undefined };
}

describe("the chapter disclosure follows the session the pane is a log of", () => {
  const OTHER_SESSION_ID = "session-the-reader-moved-to";

  /**
   * One disclosure under a bridge, over a session the caller can move.
   *
   * The pane is not remounted between the two sessions, which is the whole case: the
   * shell opens session stores and never closes them, so navigating between two open
   * sessions re-renders this position rather than unmounting it.
   */
  function mountDisclosureOver(
    useDisclosure: (sessionId: string) => LedgerChapterDisclosure,
  ): ReturnType<typeof renderHook<LedgerChapterDisclosure, { readonly sessionId: string }>> {
    const bridge = createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO });
    return renderHook((props: { readonly sessionId: string }) => useDisclosure(props.sessionId), {
      initialProps: { sessionId: SESSION_ID },
      wrapper: ({ children }: { readonly children?: React.ReactNode }) =>
        createElement(SidekicksBridgeProvider, { bridge, children }),
    });
  }

  it("opens the next session's chapters fresh, whatever was opened in the last", () => {
    const disclosure = mountDisclosureOver(useChapterDisclosure);
    act(() => {
      disclosure.result.current.toggle(terminalChapter());
    });
    expect([...disclosure.result.current.openedTerminalRunIds]).toStrictEqual([RUN_ID]);

    act(() => {
      disclosure.rerender({ sessionId: OTHER_SESSION_ID });
    });

    // A run id is a fact about the session that minted it, so carrying this set
    // across opens a chapter of B by a decision made in A and folds every other one.
    expect([...disclosure.result.current.openedTerminalRunIds]).toStrictEqual([]);
  });

  it("holds a session's own disclosure across a re-render at that same session", () => {
    // The negative control on the SCOPE: without it the fix could be "reset on every
    // render", which would fold a chapter the moment any row arrived.
    const disclosure = mountDisclosureOver(useChapterDisclosure);
    act(() => {
      disclosure.result.current.toggle(terminalChapter());
    });

    act(() => {
      disclosure.rerender({ sessionId: SESSION_ID });
    });

    expect([...disclosure.result.current.openedTerminalRunIds]).toStrictEqual([RUN_ID]);
  });

  it("negative control: a mount-scoped holder carries the last session's disclosure", () => {
    const disclosure = mountDisclosureOver(useMountScopedChapterDisclosure);
    act(() => {
      disclosure.result.current.toggle(terminalChapter());
    });

    act(() => {
      disclosure.rerender({ sessionId: OTHER_SESSION_ID });
    });

    // The defect, stated as a case: session B renders with session A's decisions.
    expect([...disclosure.result.current.openedTerminalRunIds]).toStrictEqual([RUN_ID]);
  });
});
