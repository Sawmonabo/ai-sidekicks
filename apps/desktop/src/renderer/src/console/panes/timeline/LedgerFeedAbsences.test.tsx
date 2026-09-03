// The ways this window is not the whole session, each said out loud.
//
// Four absences with four different next moves — an unrecognised type, a row the
// cap took, a row the replay position has not reached, and a sequence that never
// arrived — and the failure this file guards is one being reported as another. The
// seam is `LedgerFeed.test.tsx`'; the scaffolding is `ledger-feed-fixtures.tsx`'.

import { afterEach, describe, expect, it, vi } from "vitest";

import { OVER_CAP_EVENT_COUNT, renderFeed, withLaidOutViewport } from "./ledger-feed-fixtures.js";
import { SESSION_ID, openSessionStoreWithGeneralLog } from "./ledger-feed-logs.js";
import { SessionStore } from "../../store/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ledger feed — what it does not hold", () => {
  it("offers no load-earlier control, and names the rows the cap took", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithGeneralLog(OVER_CAP_EVENT_COUNT));
    // No read this console can perform returns rows before the window's head, so
    // the affordance is absent rather than drawn over an act nobody can complete.
    expect(feed.querySelector(".meridian-rail__load-earlier")).toBeNull();
    expect(feed.querySelector(".meridian-find__load-earlier")).toBeNull();
    expect(feed.textContent).toContain("Older entries are no longer in this window.");
  });

  it("names entries the stream numbered and never delivered", () => {
    withLaidOutViewport();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
    sessionStore.applyBatch([
      {
        id: "event-0",
        sessionId: SESSION_ID,
        sequence: 0,
        kind: "user.message",
        occurredAt: "2026-01-01T11:00:00.000Z",
        payload: {},
      },
      {
        id: "event-4",
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "user.message",
        occurredAt: "2026-01-01T11:00:04.000Z",
        payload: {},
      },
    ]);
    const feed = renderFeed(sessionStore);
    expect(feed.textContent).toContain("Some entries never arrived.");
    expect(feed.querySelector(".meridian-rail__load-earlier")).toBeNull();
  });

  it("negative control: a whole log under the cap claims nothing is missing", () => {
    // Without this the two cases above would pass over a feed that always said
    // something was missing, which is its own kind of lie about a complete session.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithGeneralLog(5));
    expect(feed.textContent).not.toContain("Older entries are no longer in this window.");
    expect(feed.textContent).not.toContain("Some entries never arrived.");
  });
});
