// What a render of the feed's parent, and one admitted event, cost the rows that did not change.
// `TranscriptViewport` memoizes its row mount and needs a stable `renderRow`; a fresh props object
// from a parent render must not move it, or every mounted row re-renders inside the frames that
// `frame-time-p95-four-lanes` bounds. The mount is composed here because it needs the parent.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { EMPTY_SESSION_SCENARIO } from "../../../../../../../fixtures/scenarios/empty-session.js";
import { type TranscriptRowProps } from "../../transcript-row-renderer.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { TranscriptFeed } from "./TranscriptFeed.js";
import {
  LeasingRowBody,
  SHORT_LOG_EVENT_COUNT,
  renderFeed,
  withLaidOutViewport,
} from "./TranscriptFeed.test-support.js";
import {
  SESSION_ID,
  transcriptFixtureEventId,
  openSessionStoreWithGeneralLog,
} from "../../transcript-logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

interface FeedParentProps {
  readonly sessionStore: SessionStore;
  readonly renderTranscriptRow: (mount: TranscriptRowProps) => React.JSX.Element;
  /**
   * Moved to make the parent render, and read by nothing. A pane above re-renders for its own
   * reasons and hands the feed a fresh props object while the three values in it stay the same.
   */
  readonly renderNudge: number;
}

/** The pane position: one bridge, one store, and the feed under both. */
function FeedParent(props: FeedParentProps): React.JSX.Element {
  void props.renderNudge;
  return (
    <FixtureBridgeProvider fixture={FIXTURE}>
      <TranscriptFeed
        sessionStore={props.sessionStore}
        renderTranscriptRow={props.renderTranscriptRow}
        feedLabel="Transcript"
      />
    </FixtureBridgeProvider>
  );
}

/**
 * One bridge for every case: a fresh bridge is a fresh context value, which re-renders the
 * subtree and would move every count below.
 */
const FIXTURE = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });

describe("the transcript feed — what a parent's render costs the rows", () => {
  it("draws no row body again when the parent re-renders with the same values", () => {
    withLaidOutViewport();
    let rowBodyRenders = 0;
    const sessionStore = openSessionStoreWithGeneralLog(SHORT_LOG_EVENT_COUNT);
    // Stable across the re-render, so only the dependency under test can move the callback.
    const renderTranscriptRow = (mount: TranscriptRowProps): React.JSX.Element => {
      rowBodyRenders += 1;
      return <p>{mount.row.summary}</p>;
    };

    const { rerender } = render(
      <FeedParent
        sessionStore={sessionStore}
        renderTranscriptRow={renderTranscriptRow}
        renderNudge={0}
      />,
    );
    const rendersAtMount = rowBodyRenders;
    // The floor: rows were drawn at all, so a frozen count is a memo holding.
    expect(rendersAtMount).toBeGreaterThan(0);

    rerender(
      <FeedParent
        sessionStore={sessionStore}
        renderTranscriptRow={renderTranscriptRow}
        renderNudge={1}
      />,
    );

    expect(rowBodyRenders).toBe(rendersAtMount);
  });

  it("negative control: a parent that hands down a new renderer draws them again", () => {
    // Without this the case above would pass over a counter nothing increments; the memo is keyed
    // on the renderer, so moving the renderer must move the count.
    withLaidOutViewport();
    let rowBodyRenders = 0;
    const sessionStore = openSessionStoreWithGeneralLog(SHORT_LOG_EVENT_COUNT);
    const countingRenderer = (mount: TranscriptRowProps): React.JSX.Element => {
      rowBodyRenders += 1;
      return <p>{mount.row.summary}</p>;
    };

    const { rerender } = render(
      <FeedParent
        sessionStore={sessionStore}
        renderTranscriptRow={countingRenderer}
        renderNudge={0}
      />,
    );
    const rendersAtMount = rowBodyRenders;

    rerender(
      <FeedParent
        sessionStore={sessionStore}
        renderTranscriptRow={(mount) => countingRenderer(mount)}
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
        id: transcriptFixtureEventId(sequence),
        sessionId: SESSION_ID,
        sequence,
        kind: "user.message",
        occurredAt: new Date(Date.UTC(2026, 0, 1, 11, 1, sequence)).toISOString(),
        payload: {},
      },
    ]);
  });
}

describe("the transcript feed — what one admitted event costs the rows", () => {
  it("draws no row body again for a row the event did not change", () => {
    withLaidOutViewport();
    const drawsByRowId = new Map<string, number>();
    const sessionStore = openSessionStoreWithGeneralLog(SHORT_LOG_EVENT_COUNT);
    renderFeed(sessionStore, (mount) => {
      drawsByRowId.set(mount.row.id, (drawsByRowId.get(mount.row.id) ?? 0) + 1);
    });
    const rowIdsAtMount = [...drawsByRowId.keys()];
    // The floor: rows were drawn at all, so a frozen count is a memo holding.
    expect(rowIdsAtMount.length).toBeGreaterThan(0);
    const drawsAtMount = new Map(drawsByRowId);

    admitOneMoreEntry(sessionStore, SHORT_LOG_EVENT_COUNT);

    for (const rowId of rowIdsAtMount) {
      expect(drawsByRowId.get(rowId), `row ${rowId} was drawn again by an event it is not in`).toBe(
        drawsAtMount.get(rowId),
      );
    }
    // The event's own row was drawn, so the counter is live and the window admitted the entry.
    expect([...drawsByRowId.keys()].length).toBe(rowIdsAtMount.length + 1);
  });

  it("draws again exactly the row whose density the list changed", () => {
    // The other half, separating this memo from one that never updates: the lease write moves the
    // renderer's identity, so every mounted row is compared and only the row whose density moved
    // is drawn.
    withLaidOutViewport();
    const drawsByRowId = new Map<string, number>();
    const feed = renderFeed(
      openSessionStoreWithGeneralLog(SHORT_LOG_EVENT_COUNT),
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
