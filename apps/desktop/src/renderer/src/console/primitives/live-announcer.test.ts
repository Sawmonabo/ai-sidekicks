// The announcer's five claims, each with the control that would catch it passing
// for the wrong reason.
//
// Every case drives a `ManualClock`, because the whole mechanism is about WHEN a
// region's text changes: a real clock would make "the message was still standing"
// and "the message had already been cleared" the same assertion with a sleep in
// between.

import { describe, expect, it } from "vitest";

import { LIVE_ANNOUNCEMENT_QUEUE_CAP, ManualClock } from "../core/index.js";
import { LiveAnnouncer, type LiveAnnouncementState } from "./live-announcer.js";

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

/** Every message the polite lane published, in order, until it fell silent. */
function drainPolite(announcer: LiveAnnouncer, clock: ManualClock): string[] {
  const published: string[] = [announcer.state.polite];
  while (announcer.isArmed) {
    clock.advance(HOLD_MS);
    published.push(announcer.state.polite);
  }
  return published;
}

describe("LiveAnnouncer — the two lanes are independent speech channels", () => {
  it("puts a polite and an assertive announcement in their own regions at once", () => {
    const { announcer } = announcerOnManualClock();

    announcer.announce("the deck was reordered");
    announcer.announce("that node refused the attach", "assertive");

    expect(announcer.state).toStrictEqual<LiveAnnouncementState>({
      polite: "the deck was reordered",
      assertive: "that node refused the attach",
    });
  });

  it("negative control: an unnamed politeness is polite, so nothing lands assertive by default", () => {
    // Without this, a default of "assertive" would satisfy every case above while
    // making the console interrupt a reader for a routine change.
    const { announcer } = announcerOnManualClock();

    announcer.announce("the deck was reordered");

    expect(announcer.state.assertive).toBe("");
  });

  it("does not let a polite burst shed a refusal, because the queues are per lane", () => {
    const { announcer, clock } = announcerOnManualClock(2);

    announcer.announce("standing");
    announcer.announce("polite one");
    announcer.announce("polite two");
    announcer.announce("polite three");
    announcer.announce("the refusal", "assertive");

    expect(announcer.state.assertive).toBe("the refusal");
    clock.advance(HOLD_MS);
    // The polite lane shed its oldest queued entry; the assertive lane, which
    // never overflowed, still says what it was given.
    expect(announcer.state.polite).toBe("polite two");
  });
});

describe("LiveAnnouncer — announcements are serialised, never overwritten", () => {
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

  it("clears the region once nothing is queued, so identical words announce again", () => {
    const { announcer, clock } = announcerOnManualClock();

    announcer.announce("the attach was refused");
    clock.advance(HOLD_MS);
    expect(announcer.state.polite).toBe("");

    announcer.announce("the attach was refused");
    expect(announcer.state.polite).toBe("the attach was refused");
  });

  it("negative control: the region does not clear itself while the hold is open", () => {
    // Without this, an announcer that cleared immediately would satisfy the case
    // above and announce nothing at all — the region would change and change back
    // inside one frame.
    const { announcer, clock } = announcerOnManualClock();

    announcer.announce("the attach was refused");
    clock.advance(HOLD_MS - 1);

    expect(announcer.state.polite).toBe("the attach was refused");
  });
});

describe("LiveAnnouncer — identical consecutive messages coalesce", () => {
  it("says one sentence once however many times a render loop asks for it", () => {
    const { announcer, clock } = announcerOnManualClock();

    for (let repeat = 0; repeat < 12; repeat += 1) {
      announcer.announce("the same sentence");
    }

    expect(drainPolite(announcer, clock)).toStrictEqual(["the same sentence", ""]);
  });

  it("negative control: a different sentence behind it is still queued", () => {
    // Without this, an announcer that dropped everything after the first message
    // would satisfy the case above by saying nothing at all afterwards.
    const { announcer, clock } = announcerOnManualClock();

    announcer.announce("the same sentence");
    announcer.announce("the same sentence");
    announcer.announce("a different sentence");

    expect(drainPolite(announcer, clock)).toStrictEqual([
      "the same sentence",
      "a different sentence",
      "",
    ]);
  });
});

describe("LiveAnnouncer — the queue is bounded and sheds its oldest", () => {
  it("keeps the newest messages when a burst overruns the cap", () => {
    const { announcer, clock } = announcerOnManualClock();
    const overrun = LIVE_ANNOUNCEMENT_QUEUE_CAP + 2;

    announcer.announce("standing");
    for (let index = 0; index < overrun; index += 1) {
      announcer.announce(`queued ${String(index)}`);
    }

    const published = drainPolite(announcer, clock);
    expect(published).toHaveLength(LIVE_ANNOUNCEMENT_QUEUE_CAP + 2);
    expect(published[0]).toBe("standing");
    expect(published[1]).toBe("queued 2");
    expect(published.at(-2)).toBe(`queued ${String(overrun - 1)}`);
    expect(published.at(-1)).toBe("");
  });

  it("negative control: the same burst under a wider cap keeps every message", () => {
    // Without this, a drain that silently lost messages for some other reason
    // would look exactly like the cap doing its job.
    const { announcer, clock } = announcerOnManualClock(LIVE_ANNOUNCEMENT_QUEUE_CAP * 4);
    const overrun = LIVE_ANNOUNCEMENT_QUEUE_CAP + 2;

    announcer.announce("standing");
    for (let index = 0; index < overrun; index += 1) {
      announcer.announce(`queued ${String(index)}`);
    }

    const published = drainPolite(announcer, clock);
    expect(published[1]).toBe("queued 0");
    expect(published).toHaveLength(overrun + 2);
  });
});

describe("LiveAnnouncer — one armed timer, and none when idle", () => {
  it("arms exactly one clock handle however many announcements are outstanding", () => {
    const { announcer, clock } = announcerOnManualClock();

    expect(clock.pendingCount).toBe(0);
    announcer.announce("one");
    announcer.announce("two");
    announcer.announce("three", "assertive");

    expect(clock.pendingCount).toBe(1);
    expect(announcer.isArmed).toBe(true);
  });

  it("disarms once every lane has fallen silent", () => {
    const { announcer, clock } = announcerOnManualClock();

    announcer.announce("one");
    announcer.announce("two", "assertive");
    clock.advance(HOLD_MS);

    expect(clock.pendingCount).toBe(0);
    expect(announcer.isArmed).toBe(false);
  });

  it("holds one snapshot identity between changes, because React reads it as one", () => {
    const { announcer } = announcerOnManualClock();

    announcer.announce("one");
    const firstRead = announcer.state;

    expect(announcer.state).toBe(firstRead);
  });
});

describe("LiveAnnouncer — dispose is terminal", () => {
  it("cancels the armed clear, drops every sink, and refuses to speak again", () => {
    const { announcer, clock } = announcerOnManualClock();
    const seen: LiveAnnouncementState[] = [];
    announcer.subscribe((state) => {
      seen.push(state);
    });

    announcer.announce("before");
    expect(seen).toHaveLength(1);

    announcer.dispose();
    announcer.announce("after");
    clock.advance(HOLD_MS * 4);

    expect(announcer.isDisposed).toBe(true);
    expect(clock.pendingCount).toBe(0);
    expect(seen).toHaveLength(1);
    expect(announcer.state.polite).toBe("before");
  });

  it("negative control: an undisposed announcer keeps speaking across the same advance", () => {
    // Without this, an announcer whose sink was never called again for some other
    // reason would satisfy the case above and prove nothing about `dispose`.
    const { announcer, clock } = announcerOnManualClock();
    const seen: LiveAnnouncementState[] = [];
    announcer.subscribe((state) => {
      seen.push(state);
    });

    announcer.announce("before");
    announcer.announce("after");
    clock.advance(HOLD_MS * 4);

    expect(seen.length).toBeGreaterThan(1);
    expect(announcer.state.polite).toBe("");
  });
});
