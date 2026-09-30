// The act each absence offers, and the jump that outlives the render it was asked in: a deferred
// request is spent once, by the row it named, and dies with the question that asked for it.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { type RowJumpOutcome } from "./row-jump.js";
// Imported directly: the tuple's only consumer outside its directory is this test, so the
// feature's public entry stays narrow.
import { foldRunGroupHeaders } from "../feed/run-group-fold.js";
import { TERMINAL_RUN_ID, projectedRowId } from "../transcript-logs.test-support.js";
import { foldedMessageRunGroupLog } from "../run-group-logs.test-support.js";
import { useDeferredRowJump } from "./hooks/useDeferredRowJump.js";
import { useTranscriptJumpReach } from "./hooks/useTranscriptJumpReach.js";
import { deriveTranscriptWindow, type TranscriptWindowModel } from "../window/transcript-window.js";

/** The loaded projection of a finished run group beside a live run. */
const LOADED_WINDOW: TranscriptWindowModel = deriveTranscriptWindow(foldedMessageRunGroupLog());

/** A message row of the finished run, which the shut fold keeps off screen. */
const FOLDED_ROW: TimelineRow = rowOf(projectedRowId(1));

function rowOf(rowId: string): TimelineRow {
  const row = LOADED_WINDOW.rowsByKey.get(rowId);
  if (row === undefined) {
    throw new Error(`the fixture log projects no row ${rowId}`);
  }
  return row;
}

function recordingActs(): {
  readonly performed: string[];
  readonly openFoldsHoldingRow: (row: TimelineRow) => void;
  readonly requestJump: (rowId: string) => void;
} {
  const performed: string[] = [];
  return {
    performed,
    openFoldsHoldingRow: () => performed.push("open-folds"),
    requestJump: (rowId: string) => performed.push(`request-jump:${rowId}`),
  };
}

function reachFor(
  outcome: RowJumpOutcome | undefined,
  acts: ReturnType<typeof recordingActs>,
  openedTerminalRunIds: ReadonlySet<string> = new Set<string>(),
): ReturnType<typeof useTranscriptJumpReach> {
  const { result } = renderHook(() =>
    useTranscriptJumpReach({
      outcome,
      foldedWindow: foldRunGroupHeaders(LOADED_WINDOW, openedTerminalRunIds).window,
      openedTerminalRunIds,
      openFoldsHoldingRow: acts.openFoldsHoldingRow,
      requestJump: acts.requestJump,
    }),
  );
  return result.current;
}

describe("the act an absence offers", () => {
  it("opens the run group and holds the jump for a row the fold dropped", () => {
    const acts = recordingActs();
    const reach = reachFor({ status: "folded-into-run-group", row: FOLDED_ROW }, acts);

    expect(reach?.label).toBe("Open that run group and go to it");
    reach?.perform();
    expect(acts.performed).toStrictEqual(["open-folds", `request-jump:${FOLDED_ROW.id}`]);
  });

  it("withholds the run group act while that run group is already open", () => {
    // Toggling an open run group closes it, taking the rest of the run off screen, so a row past
    // the group's own cap is reached by nothing.
    const acts = recordingActs();

    expect(
      reachFor(
        { status: "folded-into-run-group", row: FOLDED_ROW },
        acts,
        new Set([TERMINAL_RUN_ID]),
      ),
    ).toBeUndefined();
  });

  it("offers nothing for a row the cap took", () => {
    // Nothing here reaches a row the cap took, so a button would promise a jump it cannot make.
    expect(
      reachFor({ status: "outside-window", row: FOLDED_ROW }, recordingActs()),
    ).toBeUndefined();
  });
});

interface DeferredJumpProps {
  readonly visibleRows: readonly TimelineRow[];
  readonly questionRowId: string | undefined;
}

describe("the deferred jump", () => {
  const REQUESTED_ROW = FOLDED_ROW;
  const OTHER_ROW: TimelineRow = rowOf(projectedRowId(2));

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
    // A second reconcile over the same window (a scroll republishing the snapshot) must not
    // jump again.
    deferred.rerenderWith({
      visibleRows: [REQUESTED_ROW, OTHER_ROW],
      questionRowId: REQUESTED_ROW.id,
    });

    expect(deferred.jumps).toStrictEqual([REQUESTED_ROW.id]);
  });

  it("lets the second ask supersede the first", () => {
    // A second ask is somebody changing their mind and the question moves with it; queueing the
    // first would scroll them somewhere they had left.
    const deferred = mountDeferredJump();
    deferred.request(REQUESTED_ROW.id);
    deferred.rerenderWith({ visibleRows: [], questionRowId: OTHER_ROW.id });
    deferred.request(OTHER_ROW.id);

    deferred.rerenderWith({ visibleRows: [REQUESTED_ROW, OTHER_ROW], questionRowId: OTHER_ROW.id });

    expect(deferred.jumps).toStrictEqual([OTHER_ROW.id]);
  });

  it("abandons a request the transcript is no longer being asked about", () => {
    // A request whose act never widened the window must not outlive the find field: closing the
    // field resets the query only, and a later widening would scroll the reader away.
    const deferred = mountDeferredJump();
    deferred.request(REQUESTED_ROW.id);

    deferred.rerenderWith({ visibleRows: [], questionRowId: undefined });
    deferred.rerenderWith({ visibleRows: [REQUESTED_ROW], questionRowId: undefined });

    expect(deferred.jumps).toStrictEqual([]);
  });
});
