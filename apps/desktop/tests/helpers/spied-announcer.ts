// The real announcer with `announce` spied, not replaced, so a case reads every sentence said, in
// order and with its lane, which a live region, holding one sentence at a time, cannot: a
// sentence said twice leaves the same text, and one said on mount and then replaced leaves none.

import { vi } from "vitest";

import {
  LiveAnnouncer,
  type AnnouncementPoliteness,
} from "#renderer/components/LiveAnnouncer/announcer.js";
import { ManualClock, type Clock } from "#renderer/lib/clock.js";

/** An announcer to hand `LiveAnnouncerProvider`, and what it has been asked to say. */
export interface SpiedAnnouncer {
  readonly announcer: LiveAnnouncer;
  /** Every sentence said so far, in order, on either lane. */
  readonly spoken: () => readonly string[];
  /** Every sentence said so far on one lane, in order. */
  readonly spokenOn: (politeness: AnnouncementPoliteness) => readonly string[];
}

/** A real announcer on `clock` (a frozen one by default) whose every `announce` is recorded. */
export function spiedAnnouncer(clock: Clock = new ManualClock(0)): SpiedAnnouncer {
  const announcer = new LiveAnnouncer({ clock });
  const announce = vi.spyOn(announcer, "announce");
  return {
    announcer,
    spoken: () => announce.mock.calls.map(([message]) => message),
    spokenOn: (politeness) =>
      announce.mock.calls
        .filter(([, lane = "polite"]) => lane === politeness)
        .map(([message]) => message),
  };
}
