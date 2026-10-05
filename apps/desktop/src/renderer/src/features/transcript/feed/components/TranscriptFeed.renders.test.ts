// What one admitted event costs the rows it did not change, and which row a density change
// draws again.

import { act, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionStore } from "#renderer/store/session/session-store.js";
import {
  RetainingRowBody,
  SHORT_LOG_EVENT_COUNT,
  renderFeed,
} from "./TranscriptFeed.test-support.js";
import { withLaidOutViewport } from "../../viewport/viewport-controller.test-support.js";
import {
  SESSION_ID,
  transcriptFixtureEventId,
  transcriptFixtureStreamCursor,
  openSessionStoreWithGeneralLog,
} from "../../transcript-logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** One more entry for the log the cases below open on, admitted the way the wire does. */
function admitOneMoreEntry(sessionStore: SessionStore, sequence: number): void {
  act(() => {
    sessionStore.applyBatch([
      {
        id: transcriptFixtureEventId(sequence),
        sessionId: SESSION_ID,
        sequence,
        cursor: transcriptFixtureStreamCursor(sequence),
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
    // The other half, separating this memo from one that never updates: the retained-state write
    // moves the renderer's identity, so every mounted row is compared and only the row whose
    // density moved is drawn.
    withLaidOutViewport();
    const drawsByRowId = new Map<string, number>();
    const feed = renderFeed(
      openSessionStoreWithGeneralLog(SHORT_LOG_EVENT_COUNT),
      (mount) => {
        drawsByRowId.set(mount.row.id, (drawsByRowId.get(mount.row.id) ?? 0) + 1);
      },
      RetainingRowBody,
    );
    const drawsBeforeThePress = new Map(drawsByRowId);
    const pressedRow = feed.querySelector<HTMLElement>(".retaining-row");
    if (pressedRow === null) {
      throw new Error("the feed drew no retaining row to press");
    }

    fireEvent.click(pressedRow);

    const redrawnRowIds = [...drawsByRowId.keys()].filter(
      (rowId) => drawsByRowId.get(rowId) !== drawsBeforeThePress.get(rowId),
    );
    expect(redrawnRowIds).toHaveLength(1);
  });
});
