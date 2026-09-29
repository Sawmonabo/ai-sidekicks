// Which arm of the dispatch a key is, and what the memo behind the seat's arm holds.
//
// THE DISPATCH IS DRIVEN DIRECTLY rather than through a mounted feed, because the
// question here is which BRANCH a key takes and the eight suites next door already
// mount the whole transcript. Driven through a feed, a dispatch case would pass or fail
// on the viewport's cap, its reconcile, and whatever the fixture clock had reached.
//
// THE MEMO IS THE ONE CLAIM THAT NEEDS A RENDERER, and it is the reason this file
// exists: the module's whole justification is that `renderRow`'s identity moves on
// every admitted event — it closes over the window — so the viewport's own row memo
// cannot hold across one, and the boundary is drawn one level lower where the four
// values it compares are identity-stable. A case that only read the returned element
// would prove the branch and say nothing about the work a frame does.

import { render, renderHook } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { type RetainedRowState } from "../../viewport/retained-row-state-table.js";
import { type ViewportRow } from "../../viewport/viewport-snapshot.js";
import { type TranscriptRowProps } from "@renderer/console/seats/index.js";
import { foldRunGroupHeaders } from "../run-group-fold.js";
import {
  useTranscriptRowRenderer,
  type TranscriptRowRendererOptions,
} from "../hooks/useTranscriptRowRenderer.js";
import { TERMINAL_RUN_ID } from "../../transcript-logs.test-support.js";
import {
  openSessionStoreWithSystemMessage,
  openSessionStoreWithTerminalRunGroup,
} from "../../run-group-logs.test-support.js";
import { TranscriptRowRetention } from "../../window/row-retention.js";
import {
  deriveTranscriptWindow,
  type TranscriptWindowModel,
} from "../../window/transcript-window.js";

/** A viewport row is a key and its place in the list; the dispatch reads the key. */
function viewportRowFor(ledgerWindow: TranscriptWindowModel, key: string): ViewportRow {
  const row = ledgerWindow.viewportRows.find((candidate) => candidate.key === key);
  if (row === undefined) {
    throw new Error(`the fixture window holds no viewport row keyed ${key}`);
  }
  return row;
}

/** The options every case starts from, over one folded window. */
function rendererOptions(
  ledgerWindow: TranscriptWindowModel,
  overrides: Partial<TranscriptRowRendererOptions> = {},
): TranscriptRowRendererOptions {
  return {
    ledgerWindow,
    openedTerminalRunIds: new Set<string>(),
    hueForActor: () => undefined,
    toggleRunGroup: () => undefined,
    rowLease: (): RetainedRowState | undefined => undefined,
    renderTimelineRow: () => <output data-seat-row="yes" />,
    ...overrides,
  };
}

/** Render whatever the dispatch returned for one key. */
function renderDispatch(options: TranscriptRowRendererOptions, key: string): HTMLElement {
  const { result } = renderHook(() => useTranscriptRowRenderer(options));
  const { container } = render(<>{result.current(viewportRowFor(options.ledgerWindow, key))}</>);
  return container;
}

describe("the feed's row dispatch — which of the four a key is", () => {
  /** The run-grouped fixture, shut, which is what puts a header key in the list. */
  function foldedRunGroupWindow(): TranscriptWindowModel {
    const sessionStore = openSessionStoreWithTerminalRunGroup();
    return foldRunGroupHeaders(
      deriveTranscriptWindow(sessionStore.snapshot().timeline, false),
      new Set<string>(),
    ).window;
  }

  it("draws a run group header for the run's own key, never through the seat", () => {
    const ledgerWindow = foldedRunGroupWindow();
    const seatCalls = vi.fn(() => <output data-seat-row="yes" />);
    const container = renderDispatch(
      rendererOptions(ledgerWindow, { renderTimelineRow: seatCalls }),
      TERMINAL_RUN_ID,
    );

    expect(container.querySelector(".meridian-run-group-header")).not.toBeNull();
    // The seat owns row BODIES and a run group header is not one — asking it would
    // render a finished run as an ordinary receipt.
    expect(seatCalls).not.toHaveBeenCalled();
  });

  it("draws a seam for a row the seam index names, never through the seat", () => {
    const sessionStore = openSessionStoreWithSystemMessage();
    const ledgerWindow = deriveTranscriptWindow(sessionStore.snapshot().timeline, false);
    const seamRowId = [...ledgerWindow.seamByRowId.keys()][0];
    if (seamRowId === undefined) {
      throw new Error("the seam fixture projected no seam row");
    }
    const seatCalls = vi.fn(() => <output data-seat-row="yes" />);
    const container = renderDispatch(
      rendererOptions(ledgerWindow, { renderTimelineRow: seatCalls }),
      seamRowId,
    );

    expect(container.querySelector(".meridian-system-message__label")).not.toBeNull();
    expect(seatCalls).not.toHaveBeenCalled();
  });

  it("names a row the window no longer holds rather than drawing a blank band", () => {
    // The window moved under the viewport between its reconcile and this paint. A
    // blank would read as a row with nothing in it; this is a fact about the cap.
    const ledgerWindow = foldedRunGroupWindow();
    const vanished = viewportRowFor(ledgerWindow, TERMINAL_RUN_ID);
    const seatCalls = vi.fn(() => <output data-seat-row="yes" />);
    const { result } = renderHook(() =>
      useTranscriptRowRenderer(
        rendererOptions(
          // A window with neither the header nor any projected row under that key.
          deriveTranscriptWindow([], false),
          { renderTimelineRow: seatCalls },
        ),
      ),
    );
    const { container } = render(<>{result.current(vanished)}</>);

    expect(container.textContent).toContain("This entry is no longer loaded.");
    expect(seatCalls).not.toHaveBeenCalled();
  });

  it("hands an ordinary row to the seat with the four values the seat is given", () => {
    const ledgerWindow = foldedRunGroupWindow();
    const sessionRow = ledgerWindow.viewportRows.find(
      (row) => row.key !== TERMINAL_RUN_ID && ledgerWindow.rowsByKey.has(row.key),
    );
    if (sessionRow === undefined) {
      throw new Error("the run group fixture projected no ordinary row");
    }
    const seatCalls = vi.fn(
      (slot: TranscriptRowProps): ReactNode => <output data-seat-row={slot.row.id} />,
    );
    const container = renderDispatch(
      rendererOptions(ledgerWindow, { renderTimelineRow: seatCalls }),
      sessionRow.key,
    );

    expect(seatCalls).toHaveBeenCalledTimes(1);
    expect(container.querySelector(`[data-seat-row="${sessionRow.key}"]`)).not.toBeNull();
  });
});

describe("the memo behind the seat's arm — what a frame redraws", () => {
  /**
   * One log, projected twice through ONE retention table.
   *
   * The retention is the whole instrument: it is what holds a row object across a
   * projection, and the memo's four values are identity-stable only because it does.
   * Two projections built without it hand the memo four fresh values and it can never
   * hold — which is the state this boundary was drawn to end.
   */
  function twoProjectionsOverOneLog(): {
    readonly before: TranscriptWindowModel;
    readonly after: TranscriptWindowModel;
    readonly rowKey: string;
  } {
    const sessionStore = openSessionStoreWithTerminalRunGroup();
    const timeline = sessionStore.snapshot().timeline;
    const retention = new TranscriptRowRetention();
    const before = deriveTranscriptWindow(timeline, false, retention);
    const after = deriveTranscriptWindow(timeline, false, retention);
    const rowKey = before.viewportRows.find((row) => before.rowsByKey.has(row.key))?.key;
    if (rowKey === undefined) {
      throw new Error("the run group fixture projected no retained row");
    }
    return { before, after, rowKey };
  }

  /**
   * Dispatch one key through two projections in ONE mounted tree.
   *
   * The same element position across both renders, because that is what gives React a
   * memo cell to compare against — re-rendering into a fresh tree would mount a new
   * component and the count would be two under any arrangement at all. The mock is
   * the helper's, so a claim and its control cannot accidentally count two of them.
   */
  function seatCallsAcrossTwoProjections(
    secondOptions: (
      nextWindow: TranscriptWindowModel,
      renderTimelineRow: (slot: TranscriptRowProps) => ReactNode,
    ) => TranscriptRowRendererOptions,
  ): number {
    const { before, after, rowKey } = twoProjectionsOverOneLog();
    expect(after).not.toBe(before);
    const seatCalls = vi.fn((): ReactNode => <output data-seat-row="yes" />);
    const Dispatch = (props: { readonly options: TranscriptRowRendererOptions }): ReactNode => {
      const renderRow = useTranscriptRowRenderer(props.options);
      return renderRow(viewportRowFor(props.options.ledgerWindow, rowKey));
    };
    const view = render(
      <Dispatch options={rendererOptions(before, { renderTimelineRow: seatCalls })} />,
    );
    expect(seatCalls).toHaveBeenCalledTimes(1);
    view.rerender(<Dispatch options={secondOptions(after, seatCalls)} />);
    const calls = seatCalls.mock.calls.length;
    view.unmount();
    return calls;
  }

  it("does not redraw the card when the window moved and the row did not", () => {
    // THE CLAIM THE MODULE EXISTS FOR. `renderRow` is a new callback — it closes over
    // a new window object — so the lookups really run again; the card behind them does
    // not, because the four values the seat is handed are the same four objects.
    expect(
      seatCallsAcrossTwoProjections((nextWindow, renderTimelineRow) =>
        rendererOptions(nextWindow, { renderTimelineRow }),
      ),
    ).toBe(1);
  });

  it("negative control: a row whose density moved is redrawn", () => {
    // Without this the case above would pass over a memo that never re-rendered at
    // all — a card frozen at whatever it drew first, which is worse than redrawing it.
    const openedLease = (): RetainedRowState => ({ density: "expanded", innerScrollTopPx: 0 });
    expect(
      seatCallsAcrossTwoProjections((nextWindow, renderTimelineRow) =>
        rendererOptions(nextWindow, { renderTimelineRow, rowLease: openedLease }),
      ),
    ).toBe(2);
  });
});
