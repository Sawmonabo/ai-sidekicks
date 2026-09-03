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
// WHAT THIS FILE DOES NOT CLAIM. Not that a row never re-renders: an admitted event
// rebuilds the window and the viewport rows it carries are fresh objects, so every
// mounted row re-renders on every event by construction. That is a different defect
// with a different owner — it lives in the projection this feed consumes — and a
// case asserting otherwise would be asserting something this diff did not do.
//
// The mount is composed here rather than taken from `ledger-feed-fixtures.tsx`
// because this case needs the PARENT in its hands, which that helper deliberately
// does not expose — `LedgerFeedSeats.test.tsx`' precedent, for its reason.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../bridge/scenarios/ledger-quiet.js";
import { type TimelineRowSlotProps } from "../../seats/index.js";
import { type SessionStore } from "../../store/index.js";
import { LedgerFeed } from "./LedgerFeed.js";
import { REPLAY_LOG_EVENT_COUNT, withLaidOutViewport } from "./ledger-feed-fixtures.js";
import { openSessionStoreWithGeneralLog } from "./ledger-feed-logs.js";

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
