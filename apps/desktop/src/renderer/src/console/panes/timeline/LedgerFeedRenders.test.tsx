// What a render of the FEED'S PARENT costs the rows that did not change in it.
//
// `LedgerViewport.tsx` memoizes its row mount and says in the prop's own doc that
// the memo "only holds if the caller's `renderRow` is stable". This feed's row
// renderer listed the whole `props` object among its dependencies, and React hands a
// component a fresh props object whenever its parent renders — so a pane-level
// render with every value inside it unchanged moved the callback's identity and
// re-rendered every mounted row for a change none of them could see. Four lanes
// streaming is the workload `budgets.json`'s `frame-time-p95-four-lanes` row bounds,
// and this was main-thread work inside those frames that produced no different
// pixel.
//
// WHY THE PARENT AND NOT THE FEED'S OWN STATE. React reuses the props object across
// a render the component schedules for itself, so opening the find field or typing a
// query never moved that dependency and pinning either would pin nothing. The defect
// was reachable only from above, which is where this case drives it from.
//
// AND WHAT ONE ADMITTED EVENT COSTS THEM, which is the second describe below. The
// projection used to rebuild every row and every identity triple per pass, so an
// event that changed nothing visible re-rendered the whole mounted window TWICE —
// measured on a ten-row window, ten bodies at mount and twenty-one more per event.
// `ledger-window.ts`'s retention table holds those objects across passes and
// `LedgerFeedRow`'s memo is what spends the stability, so what an event costs now is
// the rows it actually changed.
//
// The mount is composed here rather than taken from `LedgerFeedFixtures.test-support.tsx`
// because this case needs the PARENT in its hands, which that helper deliberately
// does not expose — `LedgerFeedSeats.test.tsx`' precedent, for its reason.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../bridge/scenarios/ledger-quiet.js";
import { type TimelineRowSlotProps } from "../../seats/index.js";
import { type SessionStore } from "../../store/index.js";
import { LedgerFeed } from "./LedgerFeed.js";
import {
  LeasingRowBody,
  REPLAY_LOG_EVENT_COUNT,
  renderFeed,
  withLaidOutViewport,
} from "./LedgerFeedFixtures.test-support.js";
import { SESSION_ID, openSessionStoreWithGeneralLog } from "./ledger-feed-logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

interface FeedParentProps {
  readonly sessionStore: SessionStore;
  readonly renderTimelineRow: (mount: TimelineRowSlotProps) => React.JSX.Element;
  /**
   * Moved to make the parent render, and read by nothing.
   *
   * A pane above this feed re-renders for its own reasons — a tab change, a
   * neighbouring dock, a resize — and every one of them hands the feed a fresh props
   * object while the three values inside it stay the same.
   */
  readonly renderNudge: number;
}

/** The pane position: one bridge, one store, and the feed under both. */
function FeedParent(props: FeedParentProps): React.JSX.Element {
  void props.renderNudge;
  return (
    <SidekicksBridgeProvider bridge={FIXTURE_BRIDGE}>
      <LedgerFeed
        sessionStore={props.sessionStore}
        renderTimelineRow={props.renderTimelineRow}
        feedLabel="Session timeline"
      />
    </SidekicksBridgeProvider>
  );
}

/**
 * One bridge for every case in this file.
 *
 * Minted once rather than per render: a fresh bridge is a fresh context value, which
 * re-renders the whole subtree and would make every count below move for a reason
 * that is this file's own doing.
 */
const FIXTURE_BRIDGE = createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO });

describe("the ledger feed — what a parent's render costs the rows", () => {
  it("draws no row body again when the parent re-renders with the same values", () => {
    withLaidOutViewport();
    let rowBodyRenders = 0;
    const sessionStore = openSessionStoreWithGeneralLog(REPLAY_LOG_EVENT_COUNT);
    // Stable across the re-render below, so the only thing that can move the
    // callback's identity is the dependency this case is about.
    const renderTimelineRow = (mount: TimelineRowSlotProps): React.JSX.Element => {
      rowBodyRenders += 1;
      return <p>{mount.row.summary}</p>;
    };

    const { rerender } = render(
      <FeedParent
        sessionStore={sessionStore}
        renderTimelineRow={renderTimelineRow}
        renderNudge={0}
      />,
    );
    const rendersAtMount = rowBodyRenders;
    // The floor the case rests on: rows were drawn at all, so a frozen count is a
    // memo holding rather than a feed that mounted nothing.
    expect(rendersAtMount).toBeGreaterThan(0);

    rerender(
      <FeedParent
        sessionStore={sessionStore}
        renderTimelineRow={renderTimelineRow}
        renderNudge={1}
      />,
    );

    expect(rowBodyRenders).toBe(rendersAtMount);
  });

  it("negative control: a parent that hands down a new renderer draws them again", () => {
    // Without this the case above would pass over a counter nothing increments and a
    // row mount that never draws twice for any reason. The memo is keyed on the
    // renderer, so moving the renderer is what must move the count.
    withLaidOutViewport();
    let rowBodyRenders = 0;
    const sessionStore = openSessionStoreWithGeneralLog(REPLAY_LOG_EVENT_COUNT);
    const countingRenderer = (mount: TimelineRowSlotProps): React.JSX.Element => {
      rowBodyRenders += 1;
      return <p>{mount.row.summary}</p>;
    };

    const { rerender } = render(
      <FeedParent
        sessionStore={sessionStore}
        renderTimelineRow={countingRenderer}
        renderNudge={0}
      />,
    );
    const rendersAtMount = rowBodyRenders;

    rerender(
      <FeedParent
        sessionStore={sessionStore}
        renderTimelineRow={(mount) => countingRenderer(mount)}
        renderNudge={0}
      />,
    );

    expect(rowBodyRenders).toBeGreaterThan(rendersAtMount);
  });
});

/** One more entry for the log the cases below open on, admitted the way the wire does. */
function admitOneMoreEntry(sessionStore: SessionStore, sequence: number): void {
  act(() => {
    sessionStore.applyBatch([
      {
        id: `019b793b-7b60-7ea1-8110-e5e0d115${String(sequence).padStart(4, "0")}`,
        sessionId: SESSION_ID,
        sequence,
        kind: "user.message",
        occurredAt: new Date(Date.UTC(2026, 0, 1, 11, 1, sequence)).toISOString(),
        payload: {},
      },
    ]);
  });
}

describe("the ledger feed — what one admitted event costs the rows", () => {
  it("draws no row body again for a row the event did not change", () => {
    withLaidOutViewport();
    const drawsByRowId = new Map<string, number>();
    const sessionStore = openSessionStoreWithGeneralLog(REPLAY_LOG_EVENT_COUNT);
    renderFeed(sessionStore, (mount) => {
      drawsByRowId.set(mount.row.id, (drawsByRowId.get(mount.row.id) ?? 0) + 1);
    });
    const rowIdsAtMount = [...drawsByRowId.keys()];
    // The floor the case rests on: rows were drawn at all, so a frozen count below is
    // a memo holding rather than a feed that mounted nothing.
    expect(rowIdsAtMount.length).toBeGreaterThan(0);
    const drawsAtMount = new Map(drawsByRowId);

    admitOneMoreEntry(sessionStore, REPLAY_LOG_EVENT_COUNT);

    for (const rowId of rowIdsAtMount) {
      expect(drawsByRowId.get(rowId), `row ${rowId} was drawn again by an event it is not in`).toBe(
        drawsAtMount.get(rowId),
      );
    }
    // And the event's own row WAS drawn, so the counter is live and the window did
    // admit the entry rather than quietly ignoring it.
    expect([...drawsByRowId.keys()].length).toBe(rowIdsAtMount.length + 1);
  });

  it("draws again exactly the row whose density the list changed", () => {
    // The other half, and the one that separates this memo from a memo that never
    // updates: the lease write moves the row renderer's identity, so every mounted row
    // is re-rendered and every one of them is compared — and exactly the row whose
    // density moved is drawn.
    withLaidOutViewport();
    const drawsByRowId = new Map<string, number>();
    const feed = renderFeed(
      openSessionStoreWithGeneralLog(REPLAY_LOG_EVENT_COUNT),
      (mount) => {
        drawsByRowId.set(mount.row.id, (drawsByRowId.get(mount.row.id) ?? 0) + 1);
      },
      LeasingRowBody,
    );
    const drawsBeforeThePress = new Map(drawsByRowId);
    const pressedRow = feed.querySelector<HTMLElement>(".leasing-row");
    if (pressedRow === null) {
      throw new Error("the feed drew no leasing row to press");
    }

    fireEvent.click(pressedRow);

    const redrawnRowIds = [...drawsByRowId.keys()].filter(
      (rowId) => drawsByRowId.get(rowId) !== drawsBeforeThePress.get(rowId),
    );
    expect(redrawnRowIds).toHaveLength(1);
  });
});
