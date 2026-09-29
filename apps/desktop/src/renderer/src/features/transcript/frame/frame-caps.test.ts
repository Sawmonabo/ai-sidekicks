// The transcript window's and the reveal engine's bounds, held to the relations their
// rationales claim.

import { TIMELINE_READ_LIMIT_MAX } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  TRANSCRIPT_EARLIER_PAGE_ROWS,
  TRANSCRIPT_PARKED_LEASE_CAP,
  TRANSCRIPT_WINDOW_ROW_CAP,
  REVEAL_CHECKPOINT_TAIL_CAP,
  REVEAL_FRAME_CHARACTER_BUDGET,
  REVEAL_LITERAL_BACKTRACK_CAP,
} from "./frame-caps.js";

describe("frame caps — the window's caps describe one window", () => {
  it("parks exactly one window's worth of leases", () => {
    // `TRANSCRIPT_PARKED_LEASE_CAP`'s own rationale states the bound as a RELATION —
    // "parking one window's worth covers a page back and no more" — so the two
    // numbers being equal is the claim, not a coincidence. Above the window's cap it
    // would hold leases for rows a page back cannot reach; below it, paging back one
    // window would find rows that had silently collapsed.
    expect(TRANSCRIPT_PARKED_LEASE_CAP).toBe(TRANSCRIPT_WINDOW_ROW_CAP);
  });

  it("fetches a page the window can hold, and the wire will serve", () => {
    // TWO RELATIONS, and both are the reason this number is not free. At or above the
    // window's row cap one press would deliver a page the cap has to trim before the
    // reader can reach the end of it — the round trip spent on rows nobody sees. And
    // past the wire's own ceiling the request is refused by the contract rather than
    // answered, so the control would offer a walk that never takes a step.
    expect(TRANSCRIPT_EARLIER_PAGE_ROWS).toBeLessThan(TRANSCRIPT_WINDOW_ROW_CAP);
    expect(TRANSCRIPT_EARLIER_PAGE_ROWS).toBeLessThanOrEqual(TIMELINE_READ_LIMIT_MAX);
  });
});

describe("frame caps — the reveal engine's per-frame bounds", () => {
  it("keeps the literal backtrack far inside one frame's published characters", () => {
    // The gate walks back from a candidate ceiling inside the characters this frame
    // is publishing. A backtrack cap at or above the frame budget could walk the
    // whole frame's output, which is exactly the scan its rationale says it "refuses
    // to become".
    expect(REVEAL_LITERAL_BACKTRACK_CAP).toBeLessThan(REVEAL_FRAME_CHARACTER_BUDGET);
  });

  it("retains more than one checkpoint, so the tail is history rather than a latch", () => {
    // A checkpoint re-anchors a commit that arrived out of band. A tail of one holds
    // only the newest, so any commit that is not the newest has nothing to
    // re-anchor against and the retention stops being a tail at all.
    expect(REVEAL_CHECKPOINT_TAIL_CAP).toBeGreaterThan(1);
  });
});
