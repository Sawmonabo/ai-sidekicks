// What the destination's acts do once they are handed a session, driven through
// `sessionDestinationActs` against a recording context so nothing is mounted.

import { describe, expect, it } from "vitest";

import { contextWith } from "./destination-acts.test-support.js";
import { sessionDestinationActs } from "./destination-acts.js";

const CREATED_SESSION_ID = "7f3c1a2b-4d5e-4f60-8a71-9c2d3e4f5061";

// The pick that settles into a full start is `new-session/components/NewSessionControl.test.tsx`.
describe("a settled start", () => {
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
