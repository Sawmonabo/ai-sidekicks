// The acts the feed publishes, driven with no render at all.
//
// Every case below invokes an act and watches what it reached. That is the whole
// property: the palette and the cast bar both resolve their target at press time,
// so the only thing that can be wrong is which of the feed's own callbacks an act
// runs — and none of them needs a DOM to check.
//
// The two REFUSING acts are the reason this file exists in the shape it does. A
// no-op and a refusal are indistinguishable from a component test: nothing moves
// either way. Here the refusal is read off the frame's own act-refusal channel, so
// a press that quietly did nothing fails.

import { afterEach, describe, expect, it } from "vitest";

import { type ConsoleRefusal } from "../../core/index.js";
import { publishConsoleActRefusalSink } from "../../frame/command-surface.js";
import { REPLAY_STATES, emptyFindResult, type ReplayState } from "../../ledger/structure/index.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import {
  LEDGER_NO_FILTER_SURFACE_REFUSAL,
  LEDGER_NO_OPENED_CHAPTER_REFUSAL,
  buildActorFollowHandler,
  buildLedgerStructureActs,
  type LedgerFeedActInputs,
} from "./ledger-feed-acts.js";
import { type LedgerFindState, type LedgerReplayState } from "./ledger-feed-model.js";
import { deriveLedgerWindow } from "./ledger-window.js";

const SESSION_ID = "session-ledger-feed-acts";
const LOG_EVENT_COUNT = 6;

/** What one case watched happen, in the order it happened. */
type ActTrace = string[];

/** The row a stubbed walk lands on, so a jump can be told from a walk that found nothing. */
const WALKED_ROW_ID = "row-the-walk-found";

/**
 * A find state whose members record rather than derive.
 *
 * `useLedgerFind`'s real behaviour is `ledger-feed-model.test.ts`'; what matters
 * here is which member an act calls, which a recording stand-in answers and a real
 * hook would only obscure.
 */
function recordingFindState(trace: ActTrace, walkedRowId?: string): LedgerFindState {
  return {
    isOpen: false,
    query: "",
    result: emptyFindResult(0, false),
    beyondWindowMatchCount: 0,
    notYetReplayedMatchCount: 0,
    currentMatchIndex: -1,
    setQuery: () => {
      trace.push("setQuery");
    },
    open: () => {
      trace.push("open");
    },
    openRequestCount: 0,
    close: () => {
      trace.push("close");
    },
    step: (direction) => {
      trace.push(`step:${direction}`);
      return walkedRowId === undefined
        ? undefined
        : { index: 0, match: { rowId: walkedRowId, sequence: 0, matchedIn: "summary" } };
    },
  };
}

/** A replay state parked in one of the four arms, recording what it was asked to do. */
function recordingReplayState(state: ReplayState, trace: ActTrace): LedgerReplayState {
  return {
    position: {
      state,
      speed: 1,
      granularity: "turn",
      elapsedMs: 0,
      spanMs: 0,
      positionIso: undefined,
      revealedRowIds: [],
    },
    isRevealed: false,
    reveal: () => {
      trace.push("reveal");
    },
    conceal: () => {
      trace.push("conceal");
    },
    play: () => {
      trace.push("play");
    },
    pause: () => {
      trace.push("pause");
    },
    setSpeed: () => {
      trace.push("setSpeed");
    },
    scrub: () => {
      trace.push("scrub");
    },
    jumpToNextSeam: () => {
      trace.push("jumpToNextSeam");
    },
  };
}

/** One window's act inputs, with every seam recording into `trace`. */
function actInputs(
  trace: ActTrace,
  options: { readonly replayState?: ReplayState; readonly walkedRowId?: string } = {},
): LedgerFeedActInputs {
  return {
    find: recordingFindState(trace, options.walkedRowId),
    replay: recordingReplayState(options.replayState ?? "idle", trace),
    jumpToRow: (rowId) => {
      trace.push(`jumpToRow:${rowId}`);
    },
    jumpToTail: () => {
      trace.push("jumpToTail");
    },
  };
}

/** Every refusal raised on the frame's channel for the length of one case. */
function collectRaisedRefusals(): {
  readonly raised: ConsoleRefusal[];
  readonly withdraw: () => void;
} {
  const raised: ConsoleRefusal[] = [];
  const withdraw = publishConsoleActRefusalSink((refusal) => {
    raised.push(refusal);
  });
  return { raised, withdraw };
}

describe("the ledger's acts — what each one reaches", () => {
  it("opens the find field without touching its query", () => {
    const trace: ActTrace = [];
    buildLedgerStructureActs(actInputs(trace)).openFind();
    expect(trace).toStrictEqual(["open"]);
  });

  it("walks the matches and scrolls to each one it lands on", () => {
    const trace: ActTrace = [];
    const acts = buildLedgerStructureActs(actInputs(trace, { walkedRowId: WALKED_ROW_ID }));
    acts.stepFindNext();
    acts.stepFindPrevious();
    expect(trace).toStrictEqual([
      "step:next",
      `jumpToRow:${WALKED_ROW_ID}`,
      "step:previous",
      `jumpToRow:${WALKED_ROW_ID}`,
    ]);
  });

  it("negative control: a walk that found nothing scrolls nowhere", () => {
    // Without this the case above would pass over an act that jumped on every
    // press — which, with no match to land on, is a scroll to a row id nobody
    // produced and a reader moved for no reason.
    const trace: ActTrace = [];
    buildLedgerStructureActs(actInputs(trace)).stepFindNext();
    expect(trace).toStrictEqual(["step:next"]);
  });

  it("scrolls to the tail through the ledger's own scroll writer", () => {
    const trace: ActTrace = [];
    buildLedgerStructureActs(actInputs(trace)).scrollToTail();
    expect(trace).toStrictEqual(["jumpToTail"]);
  });

  it("reveals the dock before jumping to the next seam", () => {
    // The jump scrubs, and a scrub promotes an idle engine to `paused`, which
    // withholds rows. Without the reveal that happened behind a hidden dock.
    const trace: ActTrace = [];
    buildLedgerStructureActs(actInputs(trace)).jumpToNextSeam();
    expect(trace).toStrictEqual(["reveal", "jumpToNextSeam"]);
  });

  it("reveals the dock on every arm that starts or resumes, and on none that pauses", () => {
    // The four-state union read through one discriminator: `paused` and `at-tail`
    // both resume and `idle` starts, so a second boolean would have been a second
    // record of the same fact. The reveal rides the resuming arms only — the pause
    // arm is its own negative control, since a pause is reachable only from a
    // playing engine whose dock is already up.
    for (const state of REPLAY_STATES) {
      const trace: ActTrace = [];
      buildLedgerStructureActs(actInputs(trace, { replayState: state })).toggleReplay();
      expect(trace).toStrictEqual(state === "playing" ? ["pause"] : ["reveal", "play"]);
    }
  });

  it("fires nothing merely by being built", () => {
    const trace: ActTrace = [];
    buildLedgerStructureActs(actInputs(trace));
    expect(trace).toStrictEqual([]);
  });
});

describe("the ledger's acts — the two that refuse", () => {
  let withdrawSink: (() => void) | undefined;

  afterEach(() => {
    withdrawSink?.();
    withdrawSink = undefined;
  });

  it("says why there is nothing to unfilter", () => {
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    buildLedgerStructureActs(actInputs([])).clearFilters();
    expect(raised).toStrictEqual([LEDGER_NO_FILTER_SURFACE_REFUSAL]);
    expect(raised[0]?.code).toBe("ledger.no_filter_surface");
    expect(raised[0]?.origin).toBe("ledger");
  });

  it("says why there is no finished chapter left to fold", () => {
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    buildLedgerStructureActs(actInputs([])).collapseAllTerminalChapters();
    expect(raised).toStrictEqual([LEDGER_NO_OPENED_CHAPTER_REFUSAL]);
    expect(raised[0]?.code).toBe("ledger.no_opened_chapter");
  });

  it("negative control: the acts that CAN act raise nothing", () => {
    // Without this the two cases above would pass over a build that answered every
    // press with a banner, which would state a refusal over work that was done.
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    const acts = buildLedgerStructureActs(actInputs([], { walkedRowId: WALKED_ROW_ID }));
    acts.openFind();
    acts.stepFindNext();
    acts.scrollToTail();
    acts.toggleReplay();
    acts.jumpToNextSeam();
    expect(raised).toStrictEqual([]);
  });
});

/** A log of participant messages, oldest first, so every row carries a sequence. */
function syntheticLog(count: number): readonly ConsoleSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    sessionId: SESSION_ID,
    sequence: index,
    kind: "user.message",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString(),
    payload: {},
  }));
}

describe("the follow handler — resolving a cast chip against this window", () => {
  const rows = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false).rows;
  const NEWEST_SEQUENCE = LOG_EVENT_COUNT - 1;
  const PARTICIPANT_ID = "participant-alba";

  it("scrolls to the row the wire sequence names and says it revealed it", () => {
    const trace: ActTrace = [];
    const follow = buildActorFollowHandler({
      visibleRows: rows,
      jumpToRow: (rowId) => {
        trace.push(rowId);
      },
    });
    expect(follow({ participantId: PARTICIPANT_ID, newestSequence: NEWEST_SEQUENCE })).toBe(
      "revealed",
    );
    expect(trace).toStrictEqual([rows[NEWEST_SEQUENCE]?.id]);
  });

  it("answers row-not-in-view for a row this window no longer holds", () => {
    // The window the cap left, not the log: `jumpToRow` scrolls to what the
    // viewport reconciled, so a row outside it would report a reveal and move
    // nothing — which is the silent press the seat's outcome exists to end.
    const trace: ActTrace = [];
    const follow = buildActorFollowHandler({
      visibleRows: rows.slice(-2),
      jumpToRow: (rowId) => {
        trace.push(rowId);
      },
    });
    expect(follow({ participantId: PARTICIPANT_ID, newestSequence: 0 })).toBe("row-not-in-view");
    expect(trace).toStrictEqual([]);
  });

  it("negative control: a sequence no row carries reveals nothing over the whole window", () => {
    // Without this the case above would pass over a handler that answered
    // `row-not-in-view` for everything, which reports a working ledger as broken.
    const trace: ActTrace = [];
    const follow = buildActorFollowHandler({
      visibleRows: rows,
      jumpToRow: (rowId) => {
        trace.push(rowId);
      },
    });
    expect(follow({ participantId: PARTICIPANT_ID, newestSequence: LOG_EVENT_COUNT + 1 })).toBe(
      "row-not-in-view",
    );
    expect(follow({ participantId: PARTICIPANT_ID, newestSequence: NEWEST_SEQUENCE })).toBe(
      "revealed",
    );
    expect(trace).toHaveLength(1);
  });
});
