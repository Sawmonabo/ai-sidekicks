// The roster's ordering, its hue attachment, the row it must never drop, and the
// instants at which a row's age stops being what it says.
//
// The age half is checked against `formatRelativeTime` itself rather than against a
// list written out here: the claim `ageBoundariesOf` makes is about that function's
// output — one deadline per change, and no deadline that changes nothing — so the
// only honest test drives it. The wake CHAIN those boundaries arm is
// `presence-model.wake.test.tsx`, which needs a render and so needs a `.tsx`.

import type { PresenceReadResponseParticipant } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  FROZEN_START_ISO,
  frozenStartMilliseconds,
} from "../../core/frozen-instant.test-support.js";
import { formatRelativeTime } from "../../primitives/index.js";
import { ParticipantHueAllocator } from "../../tokens/index.js";
import { ageBoundariesOf, rosterRowsFrom } from "./presence-model.js";

function participant(
  participantId: string,
  state: PresenceReadResponseParticipant["state"],
): PresenceReadResponseParticipant {
  return {
    participantId: participantId as PresenceReadResponseParticipant["participantId"],
    state,
    lastSeen: FROZEN_START_ISO,
  };
}

const NO_HUE = (): undefined => undefined;

describe("roster rows — ordering", () => {
  it("puts the people who can answer now at the top and keeps everyone", () => {
    const rows = rosterRowsFrom(
      [
        participant("participant-offline", "offline"),
        participant("participant-reconnecting", "reconnecting"),
        participant("participant-online", "online"),
        participant("participant-idle", "idle"),
      ],
      NO_HUE,
      undefined,
    );
    expect(rows.map((row) => row.participant.participantId)).toStrictEqual([
      "participant-online",
      "participant-idle",
      "participant-reconnecting",
      "participant-offline",
    ]);
  });

  it("keeps the daemon's order inside one state", () => {
    // Sorting by id would put "alpha" first; ties keep the served order so the list
    // does not re-order itself under a person mid-glance.
    const rows = rosterRowsFrom(
      [participant("participant-zulu", "online"), participant("participant-alpha", "online")],
      NO_HUE,
      undefined,
    );
    expect(rows.map((row) => row.participant.participantId)).toStrictEqual([
      "participant-zulu",
      "participant-alpha",
    ]);
  });

  it("negative control: an already-ordered read comes back unchanged", () => {
    const served = [
      participant("participant-one", "online"),
      participant("participant-two", "offline"),
    ];
    const rows = rosterRowsFrom(served, NO_HUE, undefined);
    expect(rows.map((row) => row.participant.participantId)).toStrictEqual([
      "participant-one",
      "participant-two",
    ]);
  });
});

describe("roster rows — hue and self", () => {
  it("takes each participant's assignment from the session's own wheel", () => {
    const allocator = new ParticipantHueAllocator();
    const first = allocator.admit("participant-one");
    const second = allocator.admit("participant-two");
    const rows = rosterRowsFrom(
      [participant("participant-two", "online"), participant("participant-one", "online")],
      (participantId) => allocator.assignmentFor(participantId),
      undefined,
    );
    expect(rows[0]?.hue?.step).toBe(second.step);
    expect(rows[1]?.hue?.step).toBe(first.step);
  });

  it("renders a participant the wheel has not admitted without a hue", () => {
    // Fail-closed: a borrowed step would attribute this person's rows to somebody
    // else everywhere hue is read.
    const allocator = new ParticipantHueAllocator();
    allocator.admit("participant-one");
    const rows = rosterRowsFrom(
      [participant("participant-stranger", "online")],
      (participantId) => allocator.assignmentFor(participantId),
      undefined,
    );
    expect(rows[0]?.hue).toBeUndefined();
  });

  it("marks the reader's own row without moving it", () => {
    const rows = rosterRowsFrom(
      [participant("participant-other", "online"), participant("participant-me", "offline")],
      NO_HUE,
      "participant-me",
    );
    expect(rows.map((row) => row.isSelf)).toStrictEqual([false, true]);
    expect(rows[1]?.participant.participantId).toBe("participant-me");
  });

  it("negative control: with no reader named, no row claims to be self", () => {
    const rows = rosterRowsFrom(
      [participant("participant-other", "online"), participant("participant-me", "offline")],
      NO_HUE,
      undefined,
    );
    expect(rows.some((row) => row.isSelf)).toBe(false);
  });
});

/** One participant seen at the console's frozen start, which every age case ages from. */
const SEEN_AT_FROZEN_START: readonly PresenceReadResponseParticipant[] = [
  participant("participant-one", "online"),
];

/**
 * The boundaries that change nothing, and the pairs that render the same phrase.
 *
 * Both halves of the claim in one walk, because they are the same question asked
 * from either side: a boundary the format does not change at is a re-render nobody
 * asked for, and two boundaries with no change between them is the duplicate the
 * band edges used to emit. The reading is `formatRelativeTime`'s own — this composes
 * no phrase of its own and knows none of its bands.
 */
function boundariesThatChangeNothing(boundaries: readonly number[]): readonly number[] {
  return [...boundaries]
    .sort((earlier, later) => earlier - later)
    .filter(
      (boundary) =>
        formatRelativeTime(FROZEN_START_ISO, boundary) ===
        formatRelativeTime(FROZEN_START_ISO, boundary - 1),
    );
}

describe("age boundaries — one deadline per rendered change", () => {
  it("arms nothing in the first minute, where the phrase changes once a second", () => {
    // The seconds band is sixty deadlines inside the next minute PER PARTICIPANT, and
    // a chain re-armed at that rate is an interval poll with a different
    // implementation. The figure under a minute old is left reading as of the read
    // that stamped it; the read re-stamps on every presence signal.
    const start = frozenStartMilliseconds();
    const withinTheFirstMinute = ageBoundariesOf(SEEN_AT_FROZEN_START).filter(
      (boundary) => boundary < start + 60_000,
    );
    expect(withinTheFirstMinute).toStrictEqual([]);
  });

  it("takes over each band exactly once, at the instant the band takes over", () => {
    const start = frozenStartMilliseconds();
    const boundaries = ageBoundariesOf(SEEN_AT_FROZEN_START);
    expect(boundaries).toContain(start + 60_000);
    expect(boundaries).toContain(start + 60 * 60_000);
    expect(boundaries).toContain(start + 24 * 60 * 60_000);
    // Sixty minute steps, twenty-four hour steps, thirty day steps — the horizon.
    expect(boundaries).toHaveLength(60 + 24 + 30);
    expect(new Set(boundaries).size).toBe(boundaries.length);
  });

  it("changes the phrase at every boundary it arms", () => {
    expect(boundariesThatChangeNothing(ageBoundariesOf(SEEN_AT_FROZEN_START))).toStrictEqual([]);
  });

  it("negative control: a band enumerated from step zero arms changes that are not", () => {
    // The shape that shipped. Each band's step 0 sits half a unit in — half a minute,
    // half an hour, half a day — which is INSIDE the band below it, so it crossed no
    // threshold the format renders and re-rendered the whole section anyway. Without
    // this the case above would hold for a walk that armed nothing at all.
    const start = frozenStartMilliseconds();
    const fromStepZero = [30_000, 30 * 60_000, 12 * 60 * 60_000].map(
      (offsetMilliseconds) => start + offsetMilliseconds,
    );
    expect(boundariesThatChangeNothing(fromStepZero)).toStrictEqual(fromStepZero);
  });
});
