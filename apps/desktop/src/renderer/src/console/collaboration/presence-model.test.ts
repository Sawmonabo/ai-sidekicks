// The roster's ordering, its hue attachment, and the row it must never drop.

import type { PresenceReadResponseParticipant } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { ParticipantHueAllocator } from "../tokens/index.js";
import { rosterRowsFrom } from "./presence-model.js";

function participant(
  participantId: string,
  state: PresenceReadResponseParticipant["state"],
): PresenceReadResponseParticipant {
  return {
    participantId: participantId as PresenceReadResponseParticipant["participantId"],
    state,
    lastSeen: "2026-01-01T10:00:00.000Z",
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
