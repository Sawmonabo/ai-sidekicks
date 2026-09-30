// The window's and the reveal engine's bounds, held to the relations their rationales claim.

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
    // The parked-lease cap is documented as one window's worth, so equality is the claim: above
    // the window's cap it holds leases a page back cannot reach, below it paging back finds rows
    // that silently collapsed.
    expect(TRANSCRIPT_PARKED_LEASE_CAP).toBe(TRANSCRIPT_WINDOW_ROW_CAP);
  });

  it("fetches a page the window can hold, and the wire will serve", () => {
    // Two relations. At or above the window's row cap, one press delivers a page the cap must
    // trim before the reader reaches its end; past the wire's ceiling the contract refuses the
    // request and the control would offer a walk that never steps.
    expect(TRANSCRIPT_EARLIER_PAGE_ROWS).toBeLessThan(TRANSCRIPT_WINDOW_ROW_CAP);
    expect(TRANSCRIPT_EARLIER_PAGE_ROWS).toBeLessThanOrEqual(TIMELINE_READ_LIMIT_MAX);
  });
});

describe("frame caps — the reveal engine's per-frame bounds", () => {
  it("keeps the literal backtrack far inside one frame's published characters", () => {
    // The gate walks back inside the characters this frame is publishing; a cap at or above the
    // frame budget could scan the whole frame's output.
    expect(REVEAL_LITERAL_BACKTRACK_CAP).toBeLessThan(REVEAL_FRAME_CHARACTER_BUDGET);
  });

  it("retains more than one checkpoint, so the tail is history rather than a latch", () => {
    // A checkpoint re-anchors an out-of-band commit. A tail of one holds only the newest, so any
    // other commit has nothing to re-anchor against.
    expect(REVEAL_CHECKPOINT_TAIL_CAP).toBeGreaterThan(1);
  });
});
