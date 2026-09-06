// How often the roster wakes, counted rather than reasoned about.
//
// `ageBoundariesOf` arms a chain of single-shot timers through `useDeadlineWake`, and
// the property that matters is not which instant it publishes — that is
// `store/deadline-wake.catch-up.test.tsx`'s — but HOW OFTEN. A band enumerated once a
// second per participant made a session of twenty people wake about twenty times a
// second on a console nobody was touching, each wake re-rendering every row and
// building an `Intl.RelativeTimeFormat` for each of them. That is an interval poll
// with a different implementation, which `Spec-023 §Console Design (Meridian)` forbids
// outright and whose cost its idle-CPU budget is measured against.
//
// So the clock is advanced in ONE-SECOND STEPS rather than in one jump: a single large
// advance is collapsed by `latestPassedDeadline` into one publish, which is correct
// behaviour and makes the wake volume invisible. Stepping is what makes each crossing
// its own observation.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PresenceReadResponseParticipant } from "@ai-sidekicks/contracts";

import {
  FROZEN_START_ISO,
  frozenStartMilliseconds,
} from "../../core/frozen-instant.test-support.js";
import { CountingManualClock, renderWake } from "../../store/deadline-wake.test-support.js";
import { ageBoundariesOf } from "./presence-model.js";

/** A session of twenty people, all seen just now — the ordinary live roster. */
const ROSTER: readonly PresenceReadResponseParticipant[] = Array.from(
  { length: 20 },
  (_unused, index) => ({
    participantId:
      `participant-${String(index)}` as PresenceReadResponseParticipant["participantId"],
    state: "online",
    lastSeen: FROZEN_START_ISO,
  }),
);

const ONE_SECOND = 1_000;

/**
 * Step the clock forward a second at a time and count the seconds it woke in.
 *
 * The count is of one-second WINDOWS in which the surface's instant moved, not of
 * timers armed: a window in which several rows cross at once is one re-render of the
 * section, and the section is what the budget is about.
 */
function wakingSecondsOver(
  clock: CountingManualClock,
  wake: { readonly instant: () => number },
  seconds: number,
): number {
  let wakingWindows = 0;
  let previousInstant = wake.instant();
  for (let second = 0; second < seconds; second += 1) {
    act(() => {
      clock.advance(ONE_SECOND);
    });
    if (wake.instant() !== previousInstant) {
      wakingWindows += 1;
      previousInstant = wake.instant();
    }
  }
  return wakingWindows;
}

describe("the roster's age wake-up — how often it fires", () => {
  it("wakes not at all in the minute after a read, with twenty people online", () => {
    const clock = new CountingManualClock(frozenStartMilliseconds());
    const wake = renderWake(clock, ageBoundariesOf(ROSTER));

    expect(wakingSecondsOver(clock, wake, 59)).toBe(0);
  });

  it("negative control: a sub-minute deadline in the list does wake it", () => {
    // The shape that shipped, reduced to one row's worth: without this the case above
    // would hold for a harness that observes no wake-up at all, and the seconds band
    // it replaced would read as fixed by a test that could not see it.
    const start = frozenStartMilliseconds();
    const clock = new CountingManualClock(start);
    const everySecond = Array.from({ length: 59 }, (_unused, step) => start + (step + 0.5) * 1_000);
    const wake = renderWake(clock, everySecond);

    expect(wakingSecondsOver(clock, wake, 59)).toBe(59);
  });

  it("wakes once per rendered change over five minutes, not once per second", () => {
    // Five crossings: the minute the phrase stops being "now", then the four half-
    // minute flips inside the next four minutes. Every row shares one stamp, so the
    // twenty of them cross together and the section re-renders once for all of them.
    const clock = new CountingManualClock(frozenStartMilliseconds());
    const wake = renderWake(clock, ageBoundariesOf(ROSTER));

    expect(wakingSecondsOver(clock, wake, 5 * 60)).toBe(5);
  });
});
