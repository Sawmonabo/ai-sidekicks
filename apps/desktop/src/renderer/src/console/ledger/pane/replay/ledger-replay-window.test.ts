// What happens to a walk when the LOG under it grows.
//
// The subject is `useLedgerReplay`'s frozen set: which arrivals a walk freezes out,
// which it counts, and what the one exit that reaches them does. What happens when
// the FOLD or the FILTER moves over a log that did not is
// `ledger-replay-window.fold.test.ts`', what one POSITION reveals of a folded chapter
// is `ledger-replay-reveal.test.ts`', and what the engine leaves armed on a pass that
// never reached the screen is `ledger-replay-engine-lifetime.test.tsx`'.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type ConsoleSessionEvent } from "../../../store/index.js";
import { ledgerFixtureStampAt } from "../feed/ledger-feed-logs.test-support.js";
import { type LedgerReplayInputs, type LedgerReplayState } from "./ledger-replay-window.js";
import { ONE_ROW_MS, mountReplayOver } from "./ledger-replay.test-support.js";
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

  /**
   * A log of session-scoped rows one second apart, from one index up to another.
   *
   * A SPAN RATHER THAN A COUNT, because one case below needs a log that does not begin
   * at the session's own head: "Load earlier" prepends rows the window never held, and
   * a builder that always started at zero could not produce the window it prepends to.
   */
  function messageLogSpanning(
    firstIndex: number,
    lastIndexExclusive: number,
  ): readonly ConsoleSessionEvent[] {
    return Array.from({ length: lastIndexExclusive - firstIndex }, (_unused, offset) => {
      const index = firstIndex + offset;
      return {
        id: messageEventId(index),
        sessionId: REPLAY_SESSION_ID,
        sequence: index,
        kind: "user.message",
        occurredAt: ledgerFixtureStampAt(index),
        payload: {},
      };
    });
  }

  function windowOver(eventCount: number): LedgerWindowModel {
    return deriveLedgerWindow(messageLogSpanning(0, eventCount), false);
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

  /** Both windows over one span of the log — the shape a page read leaves behind. */
  function bothWindowsSpanning(firstIndex: number, lastIndexExclusive: number): LedgerReplayInputs {
    const ledgerWindow = deriveLedgerWindow(
      messageLogSpanning(firstIndex, lastIndexExclusive),
      false,
    );
    return { ledgerWindow, loadedWindow: ledgerWindow };
  }

  /** How many rows one press of "Load earlier" prepends — a page, not a row. */
  const EARLIER_PAGE_ROW_COUNT = 3;

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

  it("counts an earlier page as no arrival, and a row past the tail as one", () => {
    // THE DEFECT: an arrival was every id the frozen log did not hold, so pressing
    // "Load earlier" mid-walk reported the rows the person had just asked for as
    // entries the session had emitted since. The notice said the session had moved on
    // and offered to abandon the walk to reach rows OLDER than everything in it.
    const replay = mountReplayOver(
      bothWindowsSpanning(EARLIER_PAGE_ROW_COUNT, EARLIER_PAGE_ROW_COUNT + STARTING_EVENT_COUNT),
    );
    act(() => {
      replay.result.current.play();
    });

    act(() => {
      replay.rerender(bothWindowsSpanning(0, EARLIER_PAGE_ROW_COUNT + STARTING_EVENT_COUNT));
    });

    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(0);
    expect(replay.result.current.rowsAdmittedIntoThisWindowSinceReplayBegan).toBe(0);

    act(() => {
      replay.rerender(bothWindowsSpanning(0, EARLIER_PAGE_ROW_COUNT + STARTING_EVENT_COUNT + 1));
    });

    // The tail still moves the count, which is what keeps the fix a NARROWING: freezing
    // an earlier page out must not freeze out the arrivals the notice exists for.
    expect(replay.result.current.rowsAdmittedSinceReplayBegan).toBe(1);
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
