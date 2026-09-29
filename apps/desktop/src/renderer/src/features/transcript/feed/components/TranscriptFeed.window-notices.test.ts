// The ways this window is not the whole session, each said out loud.
//
// Three absences with three different next moves — an unrecognized type, a row the
// cap took, and a sequence that never arrived — and the failure this file guards is
// one being reported as another. The scaffolding is `TranscriptFeed.test-support.tsx`'.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OVER_CAP_EVENT_COUNT,
  renderFeed,
  withLaidOutViewport,
} from "./TranscriptFeed.test-support.js";
import { SESSION_ID, openSessionStoreWithGeneralLog } from "../../transcript-logs.test-support.js";
import { SessionStore } from "@renderer/store/session/session-store.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the transcript feed — what it does not hold", () => {
  it("names the rows the cap took", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithGeneralLog(OVER_CAP_EVENT_COUNT));
    // The cap is a fact about the WINDOW and the feed states it. The act that fetches
    // rows the daemon still holds is the viewport's backward read, which answers a
    // different question and is offered where that read lives.
    expect(feed.textContent).toContain("Older entries are no longer in this window.");
  });

  it("names entries the stream numbered and never delivered", () => {
    withLaidOutViewport();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.initialize({ cursor: -1, entities: [] });
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
