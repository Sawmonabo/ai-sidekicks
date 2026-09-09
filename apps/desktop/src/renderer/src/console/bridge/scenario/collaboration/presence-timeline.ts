// When this room's presence rows MOVE, and what a presence read answers on either
// side of each move.
//
// ONE DECLARATION, TWO READERS. `beats.ts` and `replies.ts` split what a room PLAYS
// from what it ANSWERS, and that split had each of them stating this room's presence
// separately: the beats scheduled three `presence.*` frames off the roster's joiner
// arm, and the reply answered `presence.read` with the roster's EVENTUAL state and
// its final stamp. So at tick zero the read already carried each joiner's `idle`,
// `reconnecting` or `offline` row — state the script does not reach until 380ms — and
// when the frames did land, the roster answered each one with a fresh read that
// returned exactly the rows the read before it had. Both of the things those beats
// exist for were unreachable at once: the transition itself, and the refresh the
// signal drives, because no read on either side of a beat ever differed.
//
// So the transitions are declared HERE, once — who moves, when, into which state,
// and with which stamp — and both sides fold this one table. `beats.ts` emits one
// frame per row, and the reply answers with the rows DUE at the instant it settles
// at, which is the engine's own frozen clock and therefore the same timeline the
// frames are released on. A frame and the read that follows it are two views of one
// transition, and neither can now claim a move the other denies.
//
// WHAT A READ ANSWERS BEFORE A ROW MOVES is the state the JOIN establishes.
// `membership.created` admits a person and a member of a session is `online` until
// something says otherwise, so every row opens `online` with `lastSeen` at its own
// join instant. The opener never leaves that row: no `presence.*` beat announces
// `online`, which is why the roster's joiner arm is the only one this table walks and
// why the opener needs no entry in it to be answered about.

import { parseInstant } from "../../../core/index.js";
import {
  COLLABORATION_PARTICIPANTS,
  PRESENCE_STATE_AT_JOIN,
  SESSION_STARTED_AT_ISO,
} from "./identifiers.js";
import type { CollaborationParticipant } from "./identifiers.js";
import type {
  ParticipantId,
  PresenceReadResponseParticipant,
  PresenceState,
} from "@ai-sidekicks/contracts";

/**
 * The tick the first transition is due at, and the gap between the ones after it.
 *
 * Scenario data rather than a cap: it is when this room's script moves somebody, and
 * the only thing it has to be is comfortably past the memberships and the channels so
 * the roster is drawn before it starts changing.
 */
const FIRST_TRANSITION_MS = 380;
const TRANSITION_STEP_MS = 20;

/** One scheduled move: who, when, into which state, and the stamp it leaves behind. */
export interface CollaborationPresenceTransition {
  readonly participantId: ParticipantId;
  /** The `presence.*` frame's own row id, so the beat and this row are one fact. */
  readonly eventId: string;
  /** The tick the frame is released at, and the tick the read starts answering it. */
  readonly atMs: number;
  readonly state: Exclude<PresenceState, typeof PRESENCE_STATE_AT_JOIN>;
  /** What `lastSeen` reads once the move is due, and the frame's own `occurredAt`. */
  readonly lastSeenIso: string;
}

/** The people this room moves through a `presence.*` transition. Never the opener. */
type CollaborationPresenceMover = Exclude<
  CollaborationParticipant,
  { presenceState: typeof PRESENCE_STATE_AT_JOIN }
>;

/** The roster's joiner arm, narrowed by the one state no transition announces. */
const COLLABORATION_PRESENCE_MOVERS: readonly CollaborationPresenceMover[] =
  COLLABORATION_PARTICIPANTS.filter(
    (participant): participant is CollaborationPresenceMover =>
      participant.presenceState !== PRESENCE_STATE_AT_JOIN,
  );

/**
 * Every presence move this room makes, in the order the frozen clock releases them.
 *
 * Numbered from the roster rather than written beside it, on the rule the rest of
 * this scenario already keeps: the person, the state they end in, and the id of the
 * frame that announces it are the roster's, and the only thing scheduling adds is
 * WHEN. A second hand-written list here would be free to name a tick the frame denies.
 */
export const COLLABORATION_PRESENCE_TRANSITIONS: readonly CollaborationPresenceTransition[] =
  COLLABORATION_PRESENCE_MOVERS.map((participant, transitionIndex) => ({
    participantId: participant.participantId,
    eventId: participant.presenceEventId,
    atMs: FIRST_TRANSITION_MS + transitionIndex * TRANSITION_STEP_MS,
    state: participant.presenceState,
    lastSeenIso: participant.lastSeenIso,
  }));

/**
 * The room's own zero, as the engine's frozen clock reports it.
 *
 * `ScenarioEngine` builds its `ManualClock` from `startedAtIso`, so a computed reply
 * is handed an ABSOLUTE instant while this schedule is written in offsets from the
 * scenario's start. Converting is therefore this module's job and not the seam's:
 * `scenario.ts` documents that member as the instant a reply settles at, and the
 * fixture's invite ledger compares it against wire stamps that are absolute too.
 *
 * Read through the console's own instant reader rather than `Date.parse`, which
 * answers `NaN` for a start that is not an instant — every comparison against `NaN`
 * is false, so a mistyped start would silently freeze every row at its join state.
 * A start this room cannot read is a defect at module load, which is where it is
 * cheapest to see.
 */
const SESSION_START_EPOCH_MS: number = readSessionStartEpochMilliseconds();

/**
 * What `presence.read` answers at one instant on the scenario's frozen clock.
 *
 * The DUE set and nothing else: a row whose transition is still ahead reads as the
 * join left it, and a row whose transition has passed reads as that transition made
 * it. Every member of the room is answered about at every instant — the read is
 * session-scoped and a person the log has admitted does not disappear from it — so
 * what moves across a beat is one row's two members and never the roster's length.
 *
 * `findLast` rather than `find` because the table is in tick order: one move per
 * person is what this room scripts today, and the newest due one is the answer
 * whether that stays true or not.
 */
export function collaborationPresenceRowsAt(
  settledAtMilliseconds: number,
): readonly PresenceReadResponseParticipant[] {
  const elapsedMilliseconds = settledAtMilliseconds - SESSION_START_EPOCH_MS;
  return COLLABORATION_PARTICIPANTS.map((participant) => {
    const moved = COLLABORATION_PRESENCE_TRANSITIONS.findLast(
      (transition) =>
        transition.participantId === participant.participantId &&
        transition.atMs <= elapsedMilliseconds,
    );
    return moved === undefined
      ? {
          participantId: participant.participantId,
          state: PRESENCE_STATE_AT_JOIN,
          lastSeen: participant.joinedAtIso,
        }
      : {
          participantId: participant.participantId,
          state: moved.state,
          lastSeen: moved.lastSeenIso,
        };
  });
}

function readSessionStartEpochMilliseconds(): number {
  const start = parseInstant(SESSION_STARTED_AT_ISO);
  if (start.kind !== "instant") {
    throw new Error(
      `the collaboration room declares a start instant nothing can read: ${SESSION_STARTED_AT_ISO}`,
    );
  }
  return start.epochMilliseconds;
}
