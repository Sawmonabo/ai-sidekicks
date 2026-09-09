// What this room's presence read answers on either side of each beat.
//
// THE DEFECT THESE CASES EXIST FOR. `presence.read` was a fixed table built from the
// roster's eventual states, so at tick zero it already answered each joiner's `idle`,
// `reconnecting` or `offline` row and the final stamp that goes with it — state the
// script does not reach until 380ms. The three `presence.*` beats then landed at 380,
// 400 and 420 into a roster whose whole discipline is to answer every push with a
// fresh read, and each of those re-reads returned exactly what the read before it had.
// Both halves were unreachable at once: the transition itself, and the refresh the
// signal drives, because no read on either side of a beat ever differed.
//
// DRIVEN THROUGH THE REAL SEAM, never through the fold alone. What broke was the path
// from a call to an answer — the engine's frozen clock, the scripted-reply settlement
// that reads the instant off it, and the call door that parses the answer against the
// registered `PresenceReadResponse`. A case that called `collaborationPresenceRowsAt`
// directly would pass against a bridge that handed the reply no instant at all.
//
// AND NOT ONE TICK IS TRANSCRIBED. Every case reaches its instants through the
// schedule the beats are emitted from, so a room that re-times its own moves re-times
// these cases with it rather than leaving them asserting a clock nobody plays.

import { describe, expect, it } from "vitest";

import type {
  DaemonEvent,
  DaemonMethod,
  PresenceReadResponse,
  PresenceReadResponseParticipant,
} from "@ai-sidekicks/contracts";

import { createFixtureBridge } from "../../fixture/call-plane/bridge.js";
import { PRESENCE_EVENT_STREAM } from "../../daemon/session-event-streams.js";
import type { ConsoleBridge } from "../../console-bridge.js";
import { COLLABORATION_SCENARIO } from "./collaboration.js";
import { COLLABORATION_BEATS } from "./beats.js";
import { COLLABORATION_PARTICIPANTS } from "./identifiers.js";
import {
  COLLABORATION_PRESENCE_TRANSITIONS,
  type CollaborationPresenceTransition,
} from "./presence-timeline.js";

const SESSION = { sessionId: COLLABORATION_SCENARIO.sessionId };

/** The room under its own fixture, driven exactly as a console window drives one. */
function room(): { readonly bridge: ConsoleBridge; readonly advance: (ms: number) => void } {
  const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture built no engine, so there is nothing to drive");
  }
  return {
    bridge,
    advance: (ms: number) => {
      engine.advance(ms);
    },
  };
}

/**
 * One of this room's scripted moves, by position in the schedule.
 *
 * Reached through the table rather than through a tick written here, so a case says
 * "the first move" and never "380ms": the schedule is the scenario's to change, and a
 * case that transcribed one would go quietly vacuous the moment it did.
 */
function moveNumber(position: number): CollaborationPresenceTransition {
  const move = COLLABORATION_PRESENCE_TRANSITIONS[position];
  if (move === undefined) {
    throw new Error(`this room scripts no presence move at position ${String(position)}`);
  }
  return move;
}

/** Every presence row this read answers with, right now, through the real call door. */
async function presenceRowsFrom(
  bridge: ConsoleBridge,
): Promise<readonly PresenceReadResponseParticipant[]> {
  const reply = await bridge.sidekicks.daemon.call("presence.read" as DaemonMethod, SESSION);
  return (reply as PresenceReadResponse).participants;
}

/** One person's row out of a reading, or a failure naming who is missing from it. */
function rowFor(
  rows: readonly PresenceReadResponseParticipant[],
  participantId: string,
): PresenceReadResponseParticipant {
  const row = rows.find((candidate) => candidate.participantId === participantId);
  if (row === undefined) {
    throw new Error(`the presence read answered nothing about ${participantId}`);
  }
  return row;
}

/** The rest of a reading, so "and nothing else moved" is one comparison. */
function everyRowExcept(
  rows: readonly PresenceReadResponseParticipant[],
  participantId: string,
): readonly PresenceReadResponseParticipant[] {
  return rows.filter((candidate) => candidate.participantId !== participantId);
}

/** The row a join establishes, which is what a read before that person's move says. */
function openingRowFor(participantId: string): PresenceReadResponseParticipant {
  const participant = COLLABORATION_PARTICIPANTS.find(
    (candidate) => candidate.participantId === participantId,
  );
  if (participant === undefined) {
    throw new Error(`this room holds nobody by the id ${participantId}`);
  }
  return {
    participantId: participant.participantId,
    state: "online",
    lastSeen: participant.joinedAtIso,
  };
}

/** The row a move leaves behind, read off the move itself. */
function movedRowFor(move: CollaborationPresenceTransition): PresenceReadResponseParticipant {
  return { participantId: move.participantId, state: move.state, lastSeen: move.lastSeenIso };
}

describe("the collaboration room's presence read", () => {
  it("opens with every member online and last seen at their own join instant", async () => {
    // The room at tick zero: nothing has happened yet, so every row reads as the
    // `membership.created` beat that admitted it left it — including the opener's,
    // whose stamp used to sit four hundred milliseconds after a read taken here.
    const { bridge } = room();

    await expect(presenceRowsFrom(bridge)).resolves.toStrictEqual(
      COLLABORATION_PARTICIPANTS.map((participant) => openingRowFor(participant.participantId)),
    );
  });

  it("moves the row whose beat has just come due, and no other row with it", async () => {
    // A millisecond either side of one beat, which is the tightest statement of what a
    // presence push means: the row it names reads differently afterwards and every
    // other row is unchanged. A fixed table passes neither half.
    const { bridge, advance } = room();
    const firstMove = moveNumber(0);

    advance(firstMove.atMs - 1);
    const justBefore = await presenceRowsFrom(bridge);
    advance(1);
    const justAfter = await presenceRowsFrom(bridge);

    expect(rowFor(justBefore, firstMove.participantId)).toStrictEqual(
      openingRowFor(firstMove.participantId),
    );
    expect(rowFor(justAfter, firstMove.participantId)).toStrictEqual(movedRowFor(firstMove));
    expect(everyRowExcept(justAfter, firstMove.participantId)).toStrictEqual(
      everyRowExcept(justBefore, firstMove.participantId),
    );
  });

  it("answers a read between two beats with exactly the moves that are due", async () => {
    // The middle of the schedule, where both halves of the rule are visible at once:
    // what has played has moved, and what has not is still where it joined.
    const { bridge, advance } = room();
    const playedMove = moveNumber(0);
    const dueMove = moveNumber(1);
    const aheadMove = moveNumber(2);

    advance(dueMove.atMs);
    const between = await presenceRowsFrom(bridge);

    // The read is only "between" two beats if the third is genuinely still ahead.
    expect(aheadMove.atMs).toBeGreaterThan(dueMove.atMs);
    expect(rowFor(between, playedMove.participantId)).toStrictEqual(movedRowFor(playedMove));
    expect(rowFor(between, dueMove.participantId)).toStrictEqual(movedRowFor(dueMove));
    expect(rowFor(between, aheadMove.participantId)).toStrictEqual(
      openingRowFor(aheadMove.participantId),
    );
  });

  it("emits each move as a beat and answers it as a row, off one declaration", async () => {
    // What keeps the two halves from drifting: for every row in the schedule there is
    // exactly one beat carrying its id, released at its tick and announcing its state,
    // and the read at that tick answers with that row. A second hand-written list on
    // either side would be free to name a move the other denies, which is the shape
    // this scenario was in — a reply built from the roster and beats built from a tick
    // formula, agreeing about a person and about nothing else.
    const { bridge, advance } = room();
    let clockMs = 0;

    for (const move of COLLABORATION_PRESENCE_TRANSITIONS) {
      const frames = COLLABORATION_BEATS.filter((beat) => beat.event.id === move.eventId);
      expect(frames).toHaveLength(1);
      expect(frames[0]?.atMs).toBe(move.atMs);
      expect(frames[0]?.event.kind).toBe(`presence.${move.state}`);

      advance(move.atMs - clockMs);
      clockMs = move.atMs;
      expect(rowFor(await presenceRowsFrom(bridge), move.participantId)).toStrictEqual(
        movedRowFor(move),
      );
    }
  });

  it("hands the Awareness re-read a different row than the read before the beat", async () => {
    // What the roster actually does with a push: it decodes nothing and answers with a
    // fresh read. So the signal is only worth delivering if the read behind it has
    // moved, and both halves are asserted — the push arrived, and the reading it
    // prompted is not the reading from a millisecond earlier.
    const { bridge, advance } = room();
    const signals: unknown[] = [];
    bridge.sidekicks.daemon.subscribe(PRESENCE_EVENT_STREAM as DaemonEvent, (signal: unknown) => {
      signals.push(signal);
    });
    const firstMove = moveNumber(0);

    advance(firstMove.atMs - 1);
    const beforeTheBeat = await presenceRowsFrom(bridge);
    const signalsBeforeTheBeat = signals.length;
    advance(1);
    const afterTheBeat = await presenceRowsFrom(bridge);

    expect(signals.length).toBeGreaterThan(signalsBeforeTheBeat);
    expect(afterTheBeat).not.toStrictEqual(beforeTheBeat);
  });

  it("negative control: no row carries its settled state before that state's own beat", async () => {
    // Without this every case above passes over the fixed table this replaced: it
    // answered each mover's eventual state and final stamp from tick zero, so "the row
    // moved" would have been true of a read that never moved at all — and the opening
    // stamp would have been a sighting the script had not reached yet.
    const { bridge } = room();

    const atStart = await presenceRowsFrom(bridge);

    for (const move of COLLABORATION_PRESENCE_TRANSITIONS) {
      expect(rowFor(atStart, move.participantId)).not.toStrictEqual(movedRowFor(move));
      expect(rowFor(atStart, move.participantId).lastSeen).not.toBe(move.lastSeenIso);
    }
  });
});
