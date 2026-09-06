// The ways this window is not the whole session, each said out loud.
//
// Four absences with four different next moves — an unrecognised type, a row the
// cap took, a row the replay position has not reached, and a sequence that never
// arrived — and the failure this file guards is one being reported as another. The
// seam is `LedgerFeed.test.tsx`'; the scaffolding is `LedgerFeedFixtures.test-support.tsx`'.
//
// AND THE WINDOW THAT HOLDS NOTHING AT ALL, which is a fifth thing and reads as an
// absence of activity unless the session says otherwise. The rule that picks its
// sentence has its own cases beside the module; what the last describe here asserts
// is the WIRING — that the feed subscribes to the projected grant and hands it down,
// which no assertion over a pure function can reach.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OVER_CAP_EVENT_COUNT,
  renderFeed,
  withLaidOutViewport,
} from "./LedgerFeedFixtures.test-support.js";
import {
  SESSION_ID,
  openEmptySessionStore,
  openSessionStoreWithGeneralLog,
} from "./ledger-feed-logs.test-support.js";
import { SessionStore } from "../../../store/index.js";
import { LedgerRowsAdmittedDuringReplayNotice } from "./LedgerRowsAdmittedDuringReplayNotice.js";

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

describe("the ledger feed — a session that moved on during a replay", () => {
  const ADMITTED_DURING_REPLAY_COUNT = 3;

  it("names the rows the walk began after, and offers the act that reaches them", () => {
    const { container } = render(
      <LedgerRowsAdmittedDuringReplayNotice
        count={ADMITTED_DURING_REPLAY_COUNT}
        onEndReplay={() => undefined}
      />,
    );
    expect(container.textContent).toContain("moved on while this replay was running");
    // The count, and the reason scrubbing is not the answer — the two halves that
    // keep this apart from the withheld-ahead sentence beside it.
    expect(container.textContent).toContain("3 entries arrived after this replay started");
    expect(container.textContent).toContain("scrubbing forward does not reach them");
  });

  it("ends the walk when the offered action is pressed", () => {
    let endedCount = 0;
    render(
      <LedgerRowsAdmittedDuringReplayNotice
        count={ADMITTED_DURING_REPLAY_COUNT}
        onEndReplay={() => {
          endedCount += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Leave the replay and catch up" }));
    expect(endedCount).toBe(1);
  });

  it("negative control: a walk nothing arrived during says nothing", () => {
    // Without this the notice could be unconditional, which would put a permanent
    // absence on a ledger with no absence in it.
    const { container } = render(
      <LedgerRowsAdmittedDuringReplayNotice count={0} onEndReplay={() => undefined} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("the ledger feed — a window holding nothing", () => {
  const CONTROL_NAME = "Sidekicks reaching each other";

  it("names the peer-invocation control when the session reported the grant off", () => {
    // A session that cannot let its sidekicks reach each other cannot hold a handoff
    // row: every invocation is adjudicated per call against this projected member and
    // answers denied, so the log staying empty is partly a setting rather than only a
    // quiet session — and the window says which.
    withLaidOutViewport();
    const feed = renderFeed(openEmptySessionStore(false));
    expect(feed.textContent).toContain("Nothing has happened in this session yet.");
    expect(feed.textContent).toContain(CONTROL_NAME);
  });

  it("negative control: an enabled session's empty window names no control", () => {
    // Without this the case above would pass over a feed that named the control on
    // every empty session — telling a reader whose capability is on that it is off.
    withLaidOutViewport();
    const feed = renderFeed(openEmptySessionStore(true));
    expect(feed.textContent).toContain("Nothing has happened in this session yet.");
    expect(feed.textContent).not.toContain(CONTROL_NAME);
  });

  it("says nothing about the grant where the read never reported it", () => {
    // The absent member is a responder that predates it and looks identical to an
    // enabled session, so rendering it as off would tell somebody a capability they
    // have is switched off.
    withLaidOutViewport();
    const feed = renderFeed(openEmptySessionStore());
    expect(feed.textContent).toContain("Nothing has happened in this session yet.");
    expect(feed.textContent).not.toContain(CONTROL_NAME);
  });
});
