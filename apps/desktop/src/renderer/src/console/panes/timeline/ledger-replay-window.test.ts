// What a replay lets the viewport have — and, for a folded chapter, what it must
// not take away with the rows.
//
// The engine's own behaviour is `replay-model.test.ts`'; this file is about the
// translation from a position to viewport rows, which is where a synthetic header
// keyed by its run id and a revealed set keyed by event ids meet.

import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../bridge/scenarios/ledger-quiet.js";
import { ManualClock } from "../../core/index.js";
import { ReplayEngine, type ReplayPosition } from "../../ledger/structure/index.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import { foldChapterHeaders } from "./ledger-chapter-fold.js";
import {
  isReplayEngaged,
  useLedgerReplay,
  useReplayRevealedRows,
  type LedgerReplayInputs,
  type LedgerReplayState,
} from "./ledger-replay-window.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "./ledger-window.js";

const SESSION_ID = "session-visible-window";
const CHAPTER_RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";
/** Row instants are one second apart, so an elapsed figure names a row by index. */
const ONE_ROW_MS = 1000;

/**
 * A finished run between two session-scoped rows.
 *
 * The leading general row is what makes "before the chapter" a position at all: a
 * folded chapter's receipt is otherwise the head of the engine's window, and every
 * position would be at or after it.
 *
 * At module scope because two describes need it: one asks what a position reveals of
 * a chapter, and the other what happens when the chapter is disclosed under a walk.
 */
function chapteredLog(): readonly ConsoleSessionEvent[] {
  const at = (index: number): string => new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString();
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
 * The replay hook under a bridge, because the replay reads the console clock.
 *
 * At module scope for `foldedWindow`'s reason: both walk describes mount it, and a
 * second wrapper would be a second answer to which clock a replay runs on.
 */
function mountReplayOver(
  initialProps: LedgerReplayInputs,
): ReturnType<typeof renderHook<LedgerReplayState, LedgerReplayInputs>> {
  const bridge = createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO });
  return renderHook((replayInputs: LedgerReplayInputs) => useLedgerReplay(replayInputs), {
    initialProps,
    wrapper: ({ children }: { readonly children?: React.ReactNode }) =>
      createElement(SidekicksBridgeProvider, { bridge, children }),
  });
}

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

describe("a replay across a projection change", () => {
  const REPLAY_SESSION_ID = "session-replay-walk";

  /** A log of session-scoped rows one second apart, so an index names an instant. */
  function messageLog(eventCount: number): readonly ConsoleSessionEvent[] {
    return Array.from({ length: eventCount }, (_unused, index) => ({
      id: `m${String(index)}`,
      sessionId: REPLAY_SESSION_ID,
      sequence: index,
      kind: "user.message",
      occurredAt: new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
      payload: {},
    }));
  }

  function windowOver(eventCount: number): LedgerWindowModel {
    return deriveLedgerWindow(messageLog(eventCount), false);
  }

  const STARTING_EVENT_COUNT = 4;
  /** The id the projection gives the fifth event — the one admitted mid-walk. */
  const ADMITTED_ROW_ID = `${REPLAY_SESSION_ID}:${String(STARTING_EVENT_COUNT)}`;

  /** The hook over a log that grows, which is what every case here changes. */
  function mountReplay(): ReturnType<typeof renderHook<LedgerReplayState, LedgerReplayInputs>> {
    return mountReplayOver(bothWindowsOver(STARTING_EVENT_COUNT));
  }

  /**
   * One window standing as both the log and what the viewport draws.
   *
   * Right for every case about an ADMITTED EVENT: an unfiltered ledger with no
   * finished chapter folds nothing away, so the two windows hold the same rows and a
   * case about the log's growth needs no third value.
   */
  function bothWindowsOver(eventCount: number): LedgerReplayInputs {
    const ledgerWindow = windowOver(eventCount);
    return { ledgerWindow, loadedWindow: ledgerWindow };
  }

  /** Every row id the position reveals when scrubbed to the very end of the walk. */
  function revealedAtEndOfWalk(replay: ReturnType<typeof mountReplay>): readonly string[] {
    act(() => {
      replay.result.current.scrub(Number.MAX_SAFE_INTEGER);
    });
    // Read AFTER the act: a scrub publishes a new position, so the reading held
    // before it is the one this assertion is not about.
    return replay.result.current.position.revealedRowIds;
  }

  it("keeps playing across an admitted event, and the new row waits out the walk", () => {
    // THE DEFECT: the engine was keyed on the window's identity, so the next event
    // the session emitted disposed the playing engine, published an idle position,
    // and revealed the whole window — mid-replay, with nobody having touched a
    // control.
    const replay = mountReplay();
    act(() => {
      replay.result.current.play();
    });
    expect(replay.result.current.position.state).toBe("playing");

    act(() => {
      replay.rerender(bothWindowsOver(STARTING_EVENT_COUNT + 1));
    });

    expect(replay.result.current.position.state).toBe("playing");
    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(1);
    // A walk is over a fixed set, so the row is not reachable by scrubbing — which
    // is why it is counted rather than left to look like a row still ahead.
    expect(revealedAtEndOfWalk(replay)).not.toContain(ADMITTED_ROW_ID);
  });

  it("holds a paused walk at its position across an admitted event", () => {
    const replay = mountReplay();
    act(() => {
      replay.result.current.scrub(1000);
    });
    expect(replay.result.current.position.state).toBe("paused");
    const pausedElapsedMs = replay.result.current.position.elapsedMs;

    act(() => {
      replay.rerender(bothWindowsOver(STARTING_EVENT_COUNT + 1));
    });

    expect(replay.result.current.position.state).toBe("paused");
    expect(replay.result.current.position.elapsedMs).toBe(pausedElapsedMs);
    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(1);
  });

  it("survives a projection rebuilt over the same log", () => {
    // A filter change and a chapter disclosure both hand the feed a fresh model
    // built from rows that did not move. Under the identity key that was a restart;
    // here it is nothing at all, which is what the count says.
    const replay = mountReplay();
    act(() => {
      replay.result.current.play();
    });

    act(() => {
      replay.rerender(bothWindowsOver(STARTING_EVENT_COUNT));
    });

    expect(replay.result.current.position.state).toBe("playing");
    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(0);
  });

  it("ends the walk over the window as it now stands", () => {
    const replay = mountReplay();
    act(() => {
      replay.result.current.play();
    });
    act(() => {
      replay.rerender(bothWindowsOver(STARTING_EVENT_COUNT + 1));
    });
    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(1);

    act(() => {
      replay.result.current.end();
    });

    expect(replay.result.current.position.state).toBe("idle");
    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(0);
    expect(revealedAtEndOfWalk(replay)).toContain(ADMITTED_ROW_ID);
  });

  it("negative control: an unengaged replay walks whatever the log now holds", () => {
    // Without this the freeze could be permanent, which would leave a ledger nobody
    // had replayed showing the window it happened to mount with.
    const replay = mountReplay();

    act(() => {
      replay.rerender(bothWindowsOver(STARTING_EVENT_COUNT + 1));
    });

    expect(replay.result.current.position.state).toBe("idle");
    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(0);
    expect(revealedAtEndOfWalk(replay)).toContain(ADMITTED_ROW_ID);
  });
});

describe("a replay across a fold or a filter change", () => {
  /**
   * The chapter's own message row — in the loaded log, out of the shut window.
   *
   * The row the disclosure is FOR, so it is what both claims here are about: it must
   * not be counted as an arrival, and it must be reachable once the chapter opens.
   */
  const CHAPTER_MEMBER_ROW_ID = `${SESSION_ID}:2`;

  /**
   * The three windows one disclosure moves between, over ONE loaded log.
   *
   * The loaded window is minted once and handed to both arms by identity, which is
   * the whole instrument: a fold change is exactly the case where the log did not
   * move, and two projections of the same events would make it look like one that
   * did.
   */
  function chapterDisclosure(): {
    readonly loadedWindow: LedgerWindowModel;
    readonly shut: LedgerWindowModel;
    readonly open: LedgerWindowModel;
  } {
    const loadedWindow = deriveLedgerWindow(chapteredLog(), false);
    return {
      loadedWindow,
      shut: foldChapterHeaders(loadedWindow, new Set<string>()),
      open: foldChapterHeaders(loadedWindow, new Set([CHAPTER_RUN_ID])),
    };
  }

  it("counts no arrival when a chapter is disclosed under a walk", () => {
    // THE DEFECT: the walk was frozen over the FOLDED window, so opening a chapter
    // put its members in the window and in no walk — and the ledger announced that
    // the session had moved on and N entries had arrived, which it had not and they
    // had not.
    const { loadedWindow, shut, open } = chapterDisclosure();
    const replay = mountReplayOver({ ledgerWindow: shut, loadedWindow });
    act(() => {
      replay.result.current.scrub(Number.MAX_SAFE_INTEGER);
    });

    act(() => {
      replay.rerender({ ledgerWindow: open, loadedWindow });
    });

    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(0);
  });

  it("reveals the members of a chapter disclosed at the end of the walk", () => {
    // The same defect's other half: at the end of the walk the header is admitted,
    // so the disclosure is live — and pressing it opened a chapter whose rows the
    // engine had never heard of, so the reveal dropped every one of them and the
    // chapter opened onto nothing.
    const { loadedWindow, shut, open } = chapterDisclosure();
    const replay = mountReplayOver({ ledgerWindow: shut, loadedWindow });
    act(() => {
      replay.result.current.scrub(Number.MAX_SAFE_INTEGER);
    });
    expect(replay.result.current.position.revealedRowIds).not.toContain(CHAPTER_MEMBER_ROW_ID);

    act(() => {
      replay.rerender({ ledgerWindow: open, loadedWindow });
    });

    expect(replay.result.current.position.revealedRowIds).toContain(CHAPTER_MEMBER_ROW_ID);
    // And the walk is still a walk: the position it was at is the position it is at.
    expect(isReplayEngaged(replay.result.current.position.state)).toBe(true);
  });

  it("carries a playing walk across the disclosure at the position it held", () => {
    const { loadedWindow, shut, open } = chapterDisclosure();
    const replay = mountReplayOver({ ledgerWindow: shut, loadedWindow });
    act(() => {
      replay.result.current.scrub(2 * ONE_ROW_MS);
      replay.result.current.play();
    });
    const elapsedBeforeDisclosure = replay.result.current.position.elapsedMs;

    act(() => {
      replay.rerender({ ledgerWindow: open, loadedWindow });
    });

    expect(replay.result.current.position.state).toBe("playing");
    expect(replay.result.current.position.elapsedMs).toBe(elapsedBeforeDisclosure);
  });

  it("negative control: a walk still freezes out a row the log admitted", () => {
    // Without this the fix could have been "follow the window", which would have
    // re-minted on every admitted event too — and a replay would be interrupted by
    // the session at the one moment nobody is looking at the dock.
    const { loadedWindow, shut } = chapterDisclosure();
    const replay = mountReplayOver({ ledgerWindow: shut, loadedWindow });
    act(() => {
      replay.result.current.scrub(ONE_ROW_MS);
    });
    const grownLoadedWindow = deriveLedgerWindow(
      [
        ...chapteredLog(),
        {
          id: "e5",
          sessionId: SESSION_ID,
          sequence: 5,
          kind: "user.message",
          occurredAt: new Date(Date.UTC(2026, 0, 1, 11, 0, 5)).toISOString(),
          payload: {},
        },
      ],
      false,
    );

    act(() => {
      replay.rerender({
        ledgerWindow: foldChapterHeaders(grownLoadedWindow, new Set<string>()),
        loadedWindow: grownLoadedWindow,
      });
    });

    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(1);
    expect(replay.result.current.position.elapsedMs).toBe(ONE_ROW_MS);
  });
});
