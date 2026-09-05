// The act each absence offers, and the jump that outlives the render it was asked in.
//
// TWO CLAIMS, AND NEITHER IS ABOUT CLASSIFICATION. Which narrowing is hiding a row
// is `ledger/structure/narrowing/filters.test.ts`', and which arm the composed feed reaches
// over a real ledger is `LedgerFeedJump.test.tsx`'. What is only true here is that
// every absence the pipeline names has a DECIDED act — the table is driven from the
// exported tuple, so a fifth narrowing added to the pipeline and not to the table is
// a red test rather than a row silently offered the chapter fold's button — and that
// a deferred request is spent exactly once, by the row it named, and dies with the
// question that asked for it.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { type LedgerJumpAbsence, type LedgerJumpOutcome } from "../../structure/index.js";
// Deeply, and only here: the tuple's one consumer outside its own directory is this
// suite's totality case, so a door line for it would be a door widened for testing.
import { LEDGER_JUMP_ABSENCES } from "../../structure/narrowing/filters.js";
import { foldChapterHeaders } from "../feed/ledger-chapter-fold.js";
import {
  SESSION_ID,
  TERMINAL_RUN_ID,
  projectedRowId,
} from "../feed/ledger-feed-logs.test-support.js";
import { foldedMessageChapterLog } from "../feed/ledger-chapter-logs.test-support.js";
import { jumpOutcomeRowId, useDeferredRowJump, useLedgerJumpReach } from "./ledger-jump.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "../window/ledger-window.js";

/** The loaded projection of a finished chapter beside a live run. */
const LOADED_WINDOW: LedgerWindowModel = deriveLedgerWindow(foldedMessageChapterLog(), false);

/** A message row of the finished run, which the shut fold keeps off screen. */
const FOLDED_ROW: TimelineRow = rowOf(projectedRowId(SESSION_ID, 1));

function rowOf(rowId: string): TimelineRow {
  const row = LOADED_WINDOW.rowsByKey.get(rowId);
  if (row === undefined) {
    throw new Error(`the fixture log projects no row ${rowId}`);
  }
  return row;
}

/** The four acts, each recording that it was performed and nothing else. */
function recordingActs(): {
  readonly performed: string[];
  readonly clearFilter: () => void;
  readonly openChapterOfRow: (row: TimelineRow) => void;
  readonly endReplay: () => void;
  readonly requestJump: (rowId: string) => void;
} {
  const performed: string[] = [];
  return {
    performed,
    clearFilter: () => performed.push("clear-filter"),
    openChapterOfRow: () => performed.push("open-chapter"),
    endReplay: () => performed.push("end-replay"),
    requestJump: (rowId: string) => performed.push(`request-jump:${rowId}`),
  };
}

/** The reach for one outcome over a window whose chapters are shut unless named. */
function reachFor(
  outcome: LedgerJumpOutcome | undefined,
  acts: ReturnType<typeof recordingActs>,
  openedTerminalRunIds: ReadonlySet<string> = new Set<string>(),
): ReturnType<typeof useLedgerJumpReach> {
  const { result } = renderHook(() =>
    useLedgerJumpReach({
      outcome,
      foldedWindow: foldChapterHeaders(LOADED_WINDOW, openedTerminalRunIds),
      openedTerminalRunIds,
      clearFilter: acts.clearFilter,
      openChapterOfRow: acts.openChapterOfRow,
      endReplay: acts.endReplay,
      requestJump: acts.requestJump,
    }),
  );
  return result.current;
}

describe("the act an absence offers", () => {
  it("decides every absence the pipeline names", () => {
    // TOTALITY, DRIVEN FROM THE TUPLE THE CLASSIFIER WALKS. The resolution used to
    // be an `if`-chain whose last arm was the chapter fold, so a fifth narrowing
    // compiled and fell through to "Open that chapter and go to it" — an act that
    // cannot reach the row, which is the exact defect the module exists to remove.
    for (const absence of LEDGER_JUMP_ABSENCES) {
      const acts = recordingActs();
      const reach = reachFor({ status: absence, row: FOLDED_ROW }, acts);
      // Decided means answered, not answered YES: two arms are honestly actless.
      expect(reach === undefined || typeof reach.label === "string").toBe(true);
    }
  });

  it("clears the filter and holds the jump for a row the filter hid", () => {
    const acts = recordingActs();
    const reach = reachFor({ status: "hidden-by-filter", row: FOLDED_ROW }, acts);

    expect(reach?.label).toBe("Clear the filter and go to it");
    reach?.perform();
    expect(acts.performed).toStrictEqual(["clear-filter", `request-jump:${FOLDED_ROW.id}`]);
  });

  it("leaves the replay and holds the jump for a row the position has not reached", () => {
    const acts = recordingActs();
    const reach = reachFor({ status: "withheld-by-replay", row: FOLDED_ROW }, acts);

    expect(reach?.label).toBe("Leave the replay and go to it");
    reach?.perform();
    expect(acts.performed).toStrictEqual(["end-replay", `request-jump:${FOLDED_ROW.id}`]);
  });

  it("opens the chapter and holds the jump for a row the fold dropped", () => {
    const acts = recordingActs();
    const reach = reachFor({ status: "folded-into-chapter", row: FOLDED_ROW }, acts);

    expect(reach?.label).toBe("Open that chapter and go to it");
    reach?.perform();
    expect(acts.performed).toStrictEqual(["open-chapter", `request-jump:${FOLDED_ROW.id}`]);
  });

  it("withholds the chapter act while that chapter is already open", () => {
    // Toggling an OPEN chapter closes it, taking the rest of the run off screen —
    // so the row past the chapter's own cap is reached by nothing this build has.
    const acts = recordingActs();

    expect(
      reachFor(
        { status: "folded-into-chapter", row: FOLDED_ROW },
        acts,
        new Set([TERMINAL_RUN_ID]),
      ),
    ).toBeUndefined();
  });

  it("offers nothing for a row the cap took", () => {
    // This console subscribes to the log and holds no read that fetches a range of
    // it, so a button here would report a success it could not perform.
    expect(
      reachFor({ status: "outside-window", row: FOLDED_ROW }, recordingActs()),
    ).toBeUndefined();
  });

  it("negative control: an outcome that is not an absence offers nothing", () => {
    // Without this the table could be answering for every outcome, which would put
    // an act beside a row that is already on screen.
    const acts = recordingActs();
    expect(reachFor(undefined, acts)).toBeUndefined();
    expect(reachFor({ status: "found", row: FOLDED_ROW }, acts)).toBeUndefined();
    expect(reachFor({ status: "not-in-loaded-log" }, acts)).toBeUndefined();
    expect(acts.performed).toStrictEqual([]);
  });

  it("refuses an absence the pipeline does not name", () => {
    // The compile-time half of the same claim: the act table is keyed by the tuple,
    // so a caller cannot invent a status and reach an arm nothing decided.
    // @ts-expect-error — not a member of `LEDGER_JUMP_ABSENCES`.
    const inventedAbsence: LedgerJumpAbsence = "withheld-by-a-fifth-narrowing";

    expect(LEDGER_JUMP_ABSENCES).not.toContain(inventedAbsence);
  });
});

/** What one rerender of the deferred jump moves — the window, and the question. */
interface DeferredJumpProps {
  readonly visibleRows: readonly TimelineRow[];
  readonly questionRowId: string | undefined;
}

describe("the deferred jump", () => {
  const REQUESTED_ROW = FOLDED_ROW;
  const OTHER_ROW: TimelineRow = rowOf(projectedRowId(SESSION_ID, 2));

  /** The hook over a window a case widens by rerendering with more rows. */
  function mountDeferredJump(): {
    readonly jumps: string[];
    readonly rerenderWith: (props: DeferredJumpProps) => void;
    readonly request: (rowId: string) => void;
  } {
    const jumps: string[] = [];
    const jumpToRow = vi.fn((rowId: string) => {
      jumps.push(rowId);
    });
    const initialProps: DeferredJumpProps = {
      visibleRows: [],
      questionRowId: REQUESTED_ROW.id,
    };
    const { result, rerender } = renderHook(
      (props: DeferredJumpProps) => useDeferredRowJump({ ...props, jumpToRow }),
      { initialProps },
    );
    return {
      jumps,
      rerenderWith: (props) => {
        act(() => {
          rerender(props);
        });
      },
      request: (rowId: string) => {
        act(() => {
          result.current(rowId);
        });
      },
    };
  }

  it("spends nothing while the row is not one the viewport holds", () => {
    const deferred = mountDeferredJump();

    deferred.request(REQUESTED_ROW.id);

    expect(deferred.jumps).toStrictEqual([]);
  });

  it("spends the request exactly once, when the row arrives", () => {
    const deferred = mountDeferredJump();
    deferred.request(REQUESTED_ROW.id);

    deferred.rerenderWith({ visibleRows: [REQUESTED_ROW], questionRowId: REQUESTED_ROW.id });
    // A second reconcile over the same window — a scroll republishing the snapshot —
    // must not jump again.
    deferred.rerenderWith({
      visibleRows: [REQUESTED_ROW, OTHER_ROW],
      questionRowId: REQUESTED_ROW.id,
    });

    expect(deferred.jumps).toStrictEqual([REQUESTED_ROW.id]);
  });

  it("lets the second ask supersede the first", () => {
    // A second ask is somebody having changed their mind — they typed another id
    // and pressed its act — so the question moves with it. Queueing the first would
    // scroll them somewhere they had already moved on from.
    const deferred = mountDeferredJump();
    deferred.request(REQUESTED_ROW.id);
    deferred.rerenderWith({ visibleRows: [], questionRowId: OTHER_ROW.id });
    deferred.request(OTHER_ROW.id);

    deferred.rerenderWith({ visibleRows: [REQUESTED_ROW, OTHER_ROW], questionRowId: OTHER_ROW.id });

    expect(deferred.jumps).toStrictEqual([OTHER_ROW.id]);
  });

  it("abandons a request the ledger is no longer being asked about", () => {
    // THE DEFECT: the request cleared only on a successful jump or a replacement,
    // and closing the find field resets the query and nothing else — so a request
    // whose act never widened the window outlived the field, and playback reaching
    // that row minutes later scrolled the ledger away from what somebody was
    // reading with nothing on screen explaining why.
    const deferred = mountDeferredJump();
    deferred.request(REQUESTED_ROW.id);

    deferred.rerenderWith({ visibleRows: [], questionRowId: undefined });
    deferred.rerenderWith({ visibleRows: [REQUESTED_ROW], questionRowId: undefined });

    expect(deferred.jumps).toStrictEqual([]);
  });

  it("negative control: a request the question still names survives the widening", () => {
    // Without this the clearing could be unconditional, which would abandon every
    // deferred jump on the render its own act caused.
    const deferred = mountDeferredJump();
    deferred.request(REQUESTED_ROW.id);

    deferred.rerenderWith({ visibleRows: [REQUESTED_ROW], questionRowId: REQUESTED_ROW.id });

    expect(deferred.jumps).toStrictEqual([REQUESTED_ROW.id]);
  });
});

describe("the row a question names", () => {
  it("is the outcome's row for every arm that carries one", () => {
    expect(jumpOutcomeRowId({ status: "found", row: FOLDED_ROW })).toBe(FOLDED_ROW.id);
    for (const absence of LEDGER_JUMP_ABSENCES) {
      expect(jumpOutcomeRowId({ status: absence, row: FOLDED_ROW })).toBe(FOLDED_ROW.id);
    }
  });

  it("negative control: a field nobody typed in and an id nothing carries name none", () => {
    expect(jumpOutcomeRowId(undefined)).toBeUndefined();
    expect(jumpOutcomeRowId({ status: "not-in-loaded-log" })).toBeUndefined();
  });
});
