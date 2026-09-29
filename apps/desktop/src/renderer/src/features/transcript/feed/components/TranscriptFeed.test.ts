// The hue seam: which wheel the feed hands each row.
//
// WHAT THIS FILE IS FOR. `LedgerFeed.tsx` adds arrangement and the callbacks that
// let one piece act on another, and every one of those is a claim that fails
// silently — a row handed a hue allocated off the wrong order looks exactly like a
// correct one. So the cases below drive the composed feed with a REAL store, a real
// projection and a real viewport binding, and assert the seam rather than the pieces.
//
// The feed's other subjects are each their own file, on this package's ~400-line rule
// — the `LedgerFeed.<subject>.test.tsx` siblings beside this one, read off the
// directory rather than listed here, so a subject that arrives or leaves does not
// leave a stale roster in a header. The scaffolding they share is
// `LedgerFeedFixtures.test-support.tsx`.

import { afterEach, describe, expect, it, vi } from "vitest";

import { renderFeed, withLaidOutViewport } from "./TranscriptFeed.test-support.js";
import {
  EARLY_JOINER,
  LATE_JOINER,
  openStoreWhereJoinOrderIsNotEventOrder,
} from "../../transcript-logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ledger feed — one wheel", () => {
  it("hands each row the hue the session store allocated", () => {
    withLaidOutViewport();
    const sessionStore = openStoreWhereJoinOrderIsNotEventOrder();
    const stepByActor = new Map<string, number>();
    renderFeed(sessionStore, (mount) => {
      if (mount.row.actor !== undefined && mount.actorHue !== undefined) {
        stepByActor.set(mount.row.actor, mount.actorHue.step);
      }
    });
    expect(stepByActor.get(EARLY_JOINER)).toBe(
      sessionStore.hueAllocator.assignmentFor(EARLY_JOINER)?.step,
    );
    expect(stepByActor.get(LATE_JOINER)).toBe(
      sessionStore.hueAllocator.assignmentFor(LATE_JOINER)?.step,
    );
  });
});
