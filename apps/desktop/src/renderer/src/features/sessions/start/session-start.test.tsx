// What the destination's acts do once they are handed a session.
//
// Driven through `sessionDestinationActs` against a recording context: the acts are
// what a composed send and an attention item reach, and every step is a call on a
// store or a route, so a case reads what was called and nothing is mounted.

import { describe, expect, it } from "vitest";

import { contextWith } from "../sessions-screen-context.test-support.js";
import { sessionDestinationActs } from "../session-destination-acts.js";

const CREATED_SESSION_ID = "7f3c1a2b-4d5e-4f60-8a71-9c2d3e4f5061";

describe("a settled composed send", () => {
  it("opens the session's store, asks for the directory again, and navigates into it", () => {
    const navigations: unknown[] = [];
    const openedSessionIds: string[] = [];
    let directoryRechecks = 0;

    sessionDestinationActs(contextWith({ navigations, openedSessionIds }), () => {
      directoryRechecks += 1;
    }).settleStartedSession(CREATED_SESSION_ID);

    expect(openedSessionIds).toStrictEqual([CREATED_SESSION_ID]);
    expect(directoryRechecks).toBe(1);
    expect(navigations).toStrictEqual([{ kind: "session", sessionId: CREATED_SESSION_ID }]);
  });

  it("does not open a store through a registry this window has already left", () => {
    // `open` is the one registry call that raises rather than returning a refusal, so
    // a settlement landing after a bridge replacement would otherwise take the rest of
    // the act, the navigation included, with it.
    const navigations: unknown[] = [];

    sessionDestinationActs(
      contextWith({ navigations, isRegistryDisposed: true }),
      () => undefined,
    ).settleStartedSession(CREATED_SESSION_ID);

    expect(navigations).toStrictEqual([{ kind: "session", sessionId: CREATED_SESSION_ID }]);
  });
});

describe("an attention item", () => {
  it("opens the session it belongs to and not the route's", () => {
    // The destination's address names no session, so a navigation composed from the
    // route would open nothing at all.
    const navigations: unknown[] = [];

    sessionDestinationActs(contextWith({ navigations }), () => undefined).openAttentionItem({
      id: "attention-1",
      momentId: "moment-1",
      sessionId: "session-node",
      trigger: "pending_approval",
      severity: "actionable",
      displayName: "Fix the login flow",
      stateWord: "Waiting on you",
      summary: "A tool call is waiting on you.",
      sourceEventId: "event-1",
      createdAt: "2026-01-01T10:00:00.000Z",
      bannerState: "pending",
      seen: false,
    });

    expect(navigations).toStrictEqual([{ kind: "session", sessionId: "session-node" }]);
  });
});
