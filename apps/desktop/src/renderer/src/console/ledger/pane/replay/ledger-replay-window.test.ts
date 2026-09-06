// What happens to a walk when the projection under it moves.
//
// The subject is `useLedgerReplay`'s frozen set: which changes a walk survives, which
// it counts as arrivals, and which re-mint the engine at the position the replaced
// one held. What one POSITION reveals of a folded chapter is
// `ledger-replay-reveal.test.ts`', and what the engine leaves armed on a pass that
// never reached the screen is `ledger-replay-engine-lifetime.test.tsx`'.

import { act, render, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { ReplayControls, type ReplayPosition } from "../../structure/index.js";
import { type ConsoleSessionEvent } from "../../../store/index.js";
import { foldChapterHeaders } from "../feed/ledger-chapter-fold.js";
import { ledgerFixtureStampAt } from "../feed/ledger-feed-logs.test-support.js";
import { isReplayEngaged } from "./ledger-replay-reveal.js";
import { type LedgerReplayInputs, type LedgerReplayState } from "./ledger-replay-window.js";
import {
  CHAPTER_RUN_ID,
  CHAPTERED_SESSION_ID,
  ONE_ROW_MS,
  chapteredLog,
  mountReplayOver,
} from "./ledger-replay.test-support.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "../window/ledger-window.js";

describe("a replay across a projection change", () => {
  const REPLAY_SESSION_ID = "session-replay-walk";

  /**
   * The id one message in this log carries, and the id its row therefore carries.
   *
   * Written once, because the projection copies the event's id verbatim and both the
   * log builder and the assertions below name the same row.
   */
  function messageEventId(index: number): string {
    return `m${String(index)}`;
  }

  /** A log of session-scoped rows one second apart, so an index names an instant. */
  function messageLog(eventCount: number): readonly ConsoleSessionEvent[] {
    return Array.from({ length: eventCount }, (_unused, index) => ({
      id: messageEventId(index),
      sessionId: REPLAY_SESSION_ID,
      sequence: index,
      kind: "user.message",
      occurredAt: ledgerFixtureStampAt(index),
      payload: {},
    }));
  }

  function windowOver(eventCount: number): LedgerWindowModel {
    return deriveLedgerWindow(messageLog(eventCount), false);
  }

  const STARTING_EVENT_COUNT = 4;
  /** The id the fifth event carries — the one admitted mid-walk. */
  const ADMITTED_ROW_ID = messageEventId(STARTING_EVENT_COUNT);

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
      replay.result.current.scrub(ONE_ROW_MS);
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
    const grownLoadedWindow = deriveLedgerWindow(
      [
        ...chapteredLog(),
        {
          id: "e5",
          sessionId: CHAPTERED_SESSION_ID,
          sequence: 5,
          kind: "user.message",
          occurredAt: ledgerFixtureStampAt(5),
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
