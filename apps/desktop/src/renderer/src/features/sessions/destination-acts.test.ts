// What the destination's acts do once they are handed a session, driven through
// `sessionDestinationActs` against a recording context so nothing is mounted.

import { describe, expect, it } from "vitest";

import { contextWith } from "./destination-acts.test-support.js";
import { sessionDestinationActs } from "./destination-acts.js";

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
    // `open` raises on a disposed registry, which would otherwise take the navigation with it.
    const navigations: unknown[] = [];

    sessionDestinationActs(
      contextWith({ navigations, isRegistryDisposed: true }),
      () => undefined,
    ).settleStartedSession(CREATED_SESSION_ID);

    expect(navigations).toStrictEqual([{ kind: "session", sessionId: CREATED_SESSION_ID }]);
  });
});
