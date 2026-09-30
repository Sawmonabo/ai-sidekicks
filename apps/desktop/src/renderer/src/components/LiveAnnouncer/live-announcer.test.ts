// The announcer's two claims a screen-reader person depends on: a refusal is never shed behind a
// polite burst, and a second announcement never overwrites the first before its window. Every case
// drives a `ManualClock`, since the mechanism is about when text changes.

import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { LiveAnnouncer } from "./live-announcer.js";

const HOLD_MS = 500;

function announcerOnManualClock(queueCap?: number): {
  announcer: LiveAnnouncer;
  clock: ManualClock;
} {
  const clock = new ManualClock();
  const announcer = new LiveAnnouncer({
    clock,
    holdMs: HOLD_MS,
    ...(queueCap === undefined ? {} : { queueCap }),
  });
  return { announcer, clock };
}

describe("LiveAnnouncer — the two lanes are independent speech channels", () => {
  it("does not let a polite burst shed a refusal, because the queues are per lane", () => {
    const { announcer, clock } = announcerOnManualClock(2);

    announcer.announce("standing");
    announcer.announce("polite one");
    announcer.announce("polite two");
    announcer.announce("polite three");
    announcer.announce("the refusal", "assertive");

    expect(announcer.state.assertive).toBe("the refusal");
    clock.advance(HOLD_MS);
    // The polite lane shed its oldest entry; the assertive lane never overflowed.
    expect(announcer.state.polite).toBe("polite two");
  });
});

describe("LiveAnnouncer — announcements are serialized, never overwritten", () => {
  it("holds the second announcement until the first has had its window", () => {
    const { announcer, clock } = announcerOnManualClock();

    announcer.announce("first");
    announcer.announce("second");

    expect(announcer.state.polite).toBe("first");
    clock.advance(HOLD_MS - 1);
    expect(announcer.state.polite).toBe("first");
    clock.advance(1);
    expect(announcer.state.polite).toBe("second");
  });
});
