// What happens to a walk when the FOLD or the FILTER under it moves.
//
// Split from `ledger-replay-window.test.ts` when the two subjects together passed the
// length at which this package splits a file. That one is about a log that GREW —
// which arrivals a walk freezes out and what it counts — and this one is about a
// projection that MOVED over a log that did not, which is the other half of the same
// rule and the half a disclosure exercises. What one POSITION reveals of a folded
// chapter is `ledger-replay-reveal.test.ts`', and what the engine leaves armed on a
// pass that never reached the screen is `ledger-replay-engine-lifetime.test.tsx`'.

import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { ReplayControls, type ReplayPosition } from "../../structure/index.js";
import { type ConsoleSessionEvent } from "../../../store/index.js";
import { foldChapterHeaders } from "../feed/model/ledger-chapter-fold.js";
import { ledgerFixtureStampAt } from "../feed/ledger-feed-logs.test-support.js";
import { isReplayEngaged } from "./ledger-replay-reveal.js";
import {
  CHAPTER_RUN_ID,
  CHAPTERED_SESSION_ID,
  ONE_ROW_MS,
  chapteredLog,
  mountReplayOver,
} from "./ledger-replay.test-support.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "../window/ledger-window.js";

/**
 * What the replay dock's primary control offers at one position.
 *
 * The REAL control rather than a reading of the state beside it: what a person is
 * offered at the end of a walk is the claim, and the state is only how the dock
 * decides it. A case that asserted the state alone would pass over a dock that
 * labelled `at-tail` as a resume.
 */
function primaryDockOffer(position: ReplayPosition): string {
  const { container } = render(
    createElement(ReplayControls, {
      position,
      isRevealed: true,
      onPlay: () => undefined,
      onPause: () => undefined,
      onSpeedChange: () => undefined,
      onScrub: () => undefined,
      onJumpToNextSeam: () => undefined,
      onReplayFromRowInView: () => undefined,
    }),
  );
  const primary = container.querySelector(".meridian-replay__primary");
  return primary?.getAttribute("aria-label") ?? "";
}

describe("a replay across a fold or a filter change", () => {
  /**
   * The chapter's own message row — in the loaded log, out of the shut window.
   *
   * The row the disclosure is FOR, so it is what both claims here are about: it must
   * not be counted as an arrival, and it must be reachable once the chapter opens.
   */
  const CHAPTER_MEMBER_ROW_ID = "e2";

  /**
   * The three windows one disclosure moves between, over ONE loaded log.
   *
   * The loaded window is minted once and handed to both arms by identity, which is
   * the whole instrument: a fold change is exactly the case where the log did not
   * move, and two projections of the same events would make it look like one that
   * did.
   */
  function disclosureOver(log: readonly ConsoleSessionEvent[]): {
    readonly loadedWindow: LedgerWindowModel;
    readonly shut: LedgerWindowModel;
    readonly open: LedgerWindowModel;
  } {
    const loadedWindow = deriveLedgerWindow(log, false);
    return {
      loadedWindow,
      shut: foldChapterHeaders(loadedWindow, new Set<string>()).window,
      open: foldChapterHeaders(loadedWindow, new Set([CHAPTER_RUN_ID])).window,
    };
  }

  function chapterDisclosure(): ReturnType<typeof disclosureOver> {
    return disclosureOver(chapteredLog());
  }

  /** The same log after the session admitted one more row, folded the same way. */
  function disclosureAfterAdmitting(
    admittedEvent: ConsoleSessionEvent,
  ): ReturnType<typeof disclosureOver> {
    return disclosureOver([...chapteredLog(), admittedEvent]);
  }

  /** A row admitted mid-walk that belongs to no chapter, so every fold shows it. */
  const ADMITTED_SESSION_EVENT: ConsoleSessionEvent = {
    id: "e5",
    sessionId: CHAPTERED_SESSION_ID,
    sequence: 5,
    kind: "user.message",
    occurredAt: ledgerFixtureStampAt(5),
    payload: {},
  };

  /** A row admitted mid-walk INSIDE the folded chapter, so the shut window hides it. */
  const ADMITTED_CHAPTER_EVENT: ConsoleSessionEvent = {
    id: "e5",
    sessionId: CHAPTERED_SESSION_ID,
    sequence: 5,
    kind: "assistant.message",
    occurredAt: ledgerFixtureStampAt(5),
    payload: { sessionId: CHAPTERED_SESSION_ID, runId: CHAPTER_RUN_ID },
  };

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

  it("leaves a walk disclosed at the tail still at the tail", () => {
    // THE REGRESSION THIS CLOSES. The re-minted engine could only be scrubbed to the
    // position the replaced one held, and `at-tail` was reachable only by ADVANCING
    // into it — so disclosing a chapter while following the tail settled `paused`,
    // and the dock offered to resume a walk with nothing left to play.
    const { loadedWindow, shut, open } = chapterDisclosure();
    const replay = mountReplayOver({ ledgerWindow: shut, loadedWindow });
    act(() => {
      replay.result.current.scrub(Number.MAX_SAFE_INTEGER);
    });
    expect(replay.result.current.position.state).toBe("at-tail");

    act(() => {
      replay.rerender({ ledgerWindow: open, loadedWindow });
    });

    expect(replay.result.current.position.state).toBe("at-tail");
    expect(primaryDockOffer(replay.result.current.position)).toBe("Replay from the beginning");
  });

  it("negative control: a walk paused mid-log re-mints paused where it was", () => {
    // Without this the fix could be "always settle at the tail", which would tell
    // somebody parked halfway through a session that there was nothing left to play.
    const { loadedWindow, shut, open } = chapterDisclosure();
    const replay = mountReplayOver({ ledgerWindow: shut, loadedWindow });
    act(() => {
      replay.result.current.scrub(ONE_ROW_MS);
    });
    expect(replay.result.current.position.state).toBe("paused");

    act(() => {
      replay.rerender({ ledgerWindow: open, loadedWindow });
    });

    expect(replay.result.current.position.state).toBe("paused");
    expect(replay.result.current.position.elapsedMs).toBe(ONE_ROW_MS);
    expect(primaryDockOffer(replay.result.current.position)).toBe("Resume the replay");
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
    const grown = disclosureAfterAdmitting(ADMITTED_SESSION_EVENT);

    act(() => {
      replay.rerender({ ledgerWindow: grown.shut, loadedWindow: grown.loadedWindow });
    });

    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(1);
    expect(replay.result.current.position.elapsedMs).toBe(ONE_ROW_MS);
  });

  it("still opens a chapter after the session has admitted a row", () => {
    // THE DEFECT: the walk's frozen log made "has the log moved" true for the rest
    // of the walk, and the guard that keeps an arrival out of the walk was written
    // against that same reading — so one admitted row permanently blocked every
    // later fold and filter change from rebuilding the walk's rows, and a chapter
    // opened after it disclosed nothing.
    const { loadedWindow, shut } = chapterDisclosure();
    const replay = mountReplayOver({ ledgerWindow: shut, loadedWindow });
    act(() => {
      replay.result.current.scrub(Number.MAX_SAFE_INTEGER);
    });
    const grown = disclosureAfterAdmitting(ADMITTED_SESSION_EVENT);
    act(() => {
      replay.rerender({ ledgerWindow: grown.shut, loadedWindow: grown.loadedWindow });
    });
    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(1);

    act(() => {
      replay.rerender({ ledgerWindow: grown.open, loadedWindow: grown.loadedWindow });
    });

    expect(replay.result.current.position.revealedRowIds).toContain(CHAPTER_MEMBER_ROW_ID);
    // And the walk is still the walk it was: the admitted row is no more reachable
    // through the disclosure than it was before it.
    expect(replay.result.current.position.revealedRowIds).not.toContain(ADMITTED_SESSION_EVENT.id);
    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(1);
  });

  it("counts a row the fold hid as an arrival, because the log admitted it", () => {
    // THE DEFECT: the count walked the FOLDED window, so a row admitted into a shut
    // chapter — or hidden by the facet bar — was in the loaded log and in no window
    // the count could see. The notice and its exit never appeared, and the walk went
    // on looking complete over a session that had moved on.
    const { loadedWindow, shut } = chapterDisclosure();
    const replay = mountReplayOver({ ledgerWindow: shut, loadedWindow });
    act(() => {
      replay.result.current.scrub(ONE_ROW_MS);
    });
    const grown = disclosureAfterAdmitting(ADMITTED_CHAPTER_EVENT);
    // The instrument, asserted rather than assumed: the fold really does keep this
    // row out of the window the viewport draws.
    expect(grown.loadedWindow.rows.map((row) => row.id)).toContain(ADMITTED_CHAPTER_EVENT.id);
    expect(grown.shut.rows.map((row) => row.id)).not.toContain(ADMITTED_CHAPTER_EVENT.id);

    act(() => {
      replay.rerender({ ledgerWindow: grown.shut, loadedWindow: grown.loadedWindow });
    });

    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(1);
    // And the window-scoped count stays zero, because the feed subtracts it from the
    // rows replay is withholding — which is a set this arrival is not in.
    expect(replay.result.current.rowsAdmittedIntoThisWindowSinceReplayBegan).toBe(0);
  });

  it("negative control: an arrival the window does hold is counted on both readings", () => {
    // Without this the split could be "the window count is always zero", which would
    // silently stop the feed subtracting the arrivals replay really is withholding.
    const { loadedWindow, shut } = chapterDisclosure();
    const replay = mountReplayOver({ ledgerWindow: shut, loadedWindow });
    act(() => {
      replay.result.current.scrub(ONE_ROW_MS);
    });
    const grown = disclosureAfterAdmitting(ADMITTED_SESSION_EVENT);

    act(() => {
      replay.rerender({ ledgerWindow: grown.shut, loadedWindow: grown.loadedWindow });
    });

    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(1);
    expect(replay.result.current.rowsAdmittedIntoThisWindowSinceReplayBegan).toBe(1);
  });
});
