// The identifiers and the two cast tables the collaboration scenario's parts share.
//
// Its own module for `composer.identifiers.ts`'s reason, which this scenario now
// meets four times over: the beats, the scripted replies, the activity frames, and
// the deep-link invitations all describe the SAME four people, the same four
// channels, and the same session, and they live in four files. An id declared in any
// one of them would be a value the other three could only match by copying it, which
// is how a fixture comes to answer a read about a person no beat admitted.
//
// THE ROSTER IS A TWO-ARM UNION AND THAT IS LOAD-BEARING. `collaboration.beats.ts`
// narrows it twice — to the rows carrying a membership id, and to the rows that are
// not `online` — through `Extract` and `Exclude` over
// {@link CollaborationParticipant}, and both narrowings resolve to
// {@link CollaborationJoiner}. Declaring the arms is also what lets the table be
// EXPORTED at all: `--isolatedDeclarations` cannot write the declaration for an
// `as const` table whose members are references to other constants, which is what
// this table was while it lived beside its one reader.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import type { MembershipRole, ParticipantId } from "@ai-sidekicks/contracts";

import type { CollaborationRuntimeNodeScript } from "./collaboration-runtime-nodes.js";

// Wire identifiers, spelled as the wire spells them — UUID v7 values whose leading
// bytes are this scenario's own start instant, so a rendered id still tells one
// fixture apart from another.
//
// The participants are branded at their declaration because the ROSTER read types
// its `participantId` as one, while an event payload types every member `unknown`;
// one assertion per constant is what keeps the machine script's rows free of them.
// The assertion is a claim, and the bridge seam's test discharges it by parsing
// every shipped frame with the registered `RuntimeNodeRosterResponseSchema`.
export const SESSION_ID = "019b7904-8ce0-75e5-8510-ada11a5a33a5";
export const PARTICIPANT_YOU = "019b7904-8ce0-79a4-8110-cca0117a0330" as ParticipantId;
export const PARTICIPANT_PRIYA = "019b7904-8ce0-79a4-8120-cca0117a0340" as ParticipantId;
export const PARTICIPANT_TOMAS = "019b7904-8ce0-79a4-8130-cca0117a0350" as ParticipantId;
const PARTICIPANT_NOAH = "019b7904-8ce0-79a4-8140-cca0117a0355" as ParticipantId;
const MEMBERSHIP_PRIYA = "019b7904-8ce0-7e3b-8110-cca0117a0360";
const MEMBERSHIP_TOMAS = "019b7904-8ce0-7e3b-8120-cca0117a0370";
const MEMBERSHIP_NOAH = "019b7904-8ce0-7e3b-8130-cca0117a0375";
export const CHANNEL_MAIN = "019b7904-8ce0-7c11-8110-cca0117a0380";
export const CHANNEL_REVIEW = "019b7904-8ce0-7c11-8120-cca0117a0390";
export const CHANNEL_HANDOFF = "019b7904-8ce0-7c11-8130-cca0117a0395";
export const CHANNEL_DIRECT = "019b7904-8ce0-7c11-8135-cca0117a0396";
export const INVITE_EXPIRING = "019b7904-8ce0-7f22-8110-cca0117a03a0";
export const INVITE_ACCEPTED = "019b7904-8ce0-7f22-8120-cca0117a03b0";
// The one this scenario MINTS, when a person fills the create form in and presses
// send. It is not in the ledger above: it does not exist until the act, which is
// the whole difference between a row the read returns and a row the create makes.
export const INVITE_MINTED = "019b7904-8ce0-7f22-8130-cca0117a03b8";

// The deep link's own identifiers. The references are opaque by contract, so they are
// spelled as something no reader could mistake for a token or an id — which is the
// point of them: `Plan-023 §Invariants` I-023-10 makes what the renderer holds a
// handle main resolves, and a fixture spelling one as a credential would teach the
// wrong shape.
export const PENDING_REFERENCE_DESIGN = "pending-ref-design";
export const PENDING_REFERENCE_AUDIT = "pending-ref-audit";
export const INVITED_SESSION_DESIGN = "019b7904-8ce0-7f22-8140-cca0117a0410";
export const INVITED_SESSION_AUDIT = "019b7904-8ce0-7f22-8150-cca0117a0420";
export const MEMBERSHIP_FROM_INVITE = "019b7904-8ce0-7f22-8160-cca0117a0430";
export const MEMBERSHIP_FROM_RETRY = "019b7904-8ce0-7f22-8170-cca0117a0440";
// A run this session's log has NOT carried, and deliberately so — see the activity
// frames below, which say why an unresolved run id is the case worth scripting.
export const PEER_RUN_ID = "019b7904-8ce0-740e-8110-cca0117a03c0";

/**
 * The session's OPENER, whom `session.created` admits.
 *
 * A shape of its own rather than a row with optional members, because what makes the
 * opener different is a set of ABSENCES that travel together: no membership beat
 * announced them, so there is no membership id, no join instant, and no event id for
 * either — and `online` is not incidental to that, it is this window's own person.
 */
interface CollaborationOpener {
  readonly participantId: ParticipantId;
  readonly identityHandle: string;
  readonly role: MembershipRole;
  readonly membershipId: undefined;
  readonly joinedAtMs: undefined;
  readonly joinedAtIso: undefined;
  readonly presenceState: "online";
  readonly lastSeenIso: string;
}

/**
 * Everyone else: a person one `membership.created` beat admitted and one
 * `presence.*` beat moved.
 *
 * Every member is required, which is the whole reason the two shapes are separate:
 * `collaboration.beats.ts` filters the roster to exactly this arm — once for the
 * membership beats and once for the presence beats — and then reads the two event
 * ids and the join instant with no optionality left to check.
 */
interface CollaborationJoiner {
  readonly participantId: ParticipantId;
  readonly identityHandle: string;
  readonly membershipEventId: string;
  readonly presenceEventId: string;
  readonly role: MembershipRole;
  readonly membershipId: string;
  readonly joinedAtMs: number;
  readonly joinedAtIso: string;
  readonly presenceState: "idle" | "reconnecting" | "offline";
  readonly lastSeenIso: string;
}

/** One row of the roster, so the two beat subsets can name what they narrow to. */
export type CollaborationParticipant = CollaborationOpener | CollaborationJoiner;

/**
 * Who is in the room, in join order, and what the roster read says of each.
 *
 * ONE TABLE rather than a membership literal per beat and a presence literal per
 * reply, on `flagship.ts`'s rule: the `membership.created` event and the
 * `presence.read` row are two views of one person, and two hand-written copies of
 * one person drift in exactly the direction nothing catches. `you` carries no
 * membership beat because the session's opener is admitted by `session.created`
 * itself, so the entry states that with an absent id rather than inventing one.
 *
 * The four presence states are covered exactly once each, which is what makes the
 * roster's render order and its dimmed offline row both reachable from one script.
 */
export const COLLABORATION_PARTICIPANTS: readonly CollaborationParticipant[] = [
  {
    participantId: PARTICIPANT_YOU,
    identityHandle: "sawyer",
    role: "owner",
    membershipId: undefined,
    joinedAtMs: undefined,
    joinedAtIso: undefined,
    presenceState: "online",
    lastSeenIso: "2026-01-01T10:05:00.400Z",
  },
  {
    participantId: PARTICIPANT_PRIYA,
    identityHandle: "priya",
    membershipEventId: "019b7904-8ce0-7ea1-8120-cca0117a0402",
    presenceEventId: "019b7904-8ce0-7ea1-8220-cca0117a0409",
    role: "collaborator",
    membershipId: MEMBERSHIP_PRIYA,
    joinedAtMs: 60,
    joinedAtIso: "2026-01-01T10:05:00.060Z",
    presenceState: "idle",
    lastSeenIso: "2026-01-01T10:05:00.380Z",
  },
  {
    participantId: PARTICIPANT_TOMAS,
    identityHandle: "tomas",
    membershipEventId: "019b7904-8ce0-7ea1-8130-cca0117a0403",
    presenceEventId: "019b7904-8ce0-7ea1-8230-cca0117a0410",
    // `viewer` is the wire's read-only role. There is no `observer` on this wire,
    // and the members model refuses one, so a fixture that played it would be
    // scripting a role no session can hold.
    role: "viewer",
    membershipId: MEMBERSHIP_TOMAS,
    joinedAtMs: 120,
    joinedAtIso: "2026-01-01T10:05:00.120Z",
    presenceState: "reconnecting",
    lastSeenIso: "2026-01-01T10:05:00.240Z",
  },
  {
    participantId: PARTICIPANT_NOAH,
    identityHandle: "noah",
    membershipEventId: "019b7904-8ce0-7ea1-8140-cca0117a0404",
    presenceEventId: "019b7904-8ce0-7ea1-8240-cca0117a0411",
    role: "collaborator",
    membershipId: MEMBERSHIP_NOAH,
    joinedAtMs: 160,
    joinedAtIso: "2026-01-01T10:05:00.160Z",
    presenceState: "offline",
    lastSeenIso: "2026-01-01T10:05:00.180Z",
  },
];

/**
 * The channels, as `channel.list` serves them and `channel.created` announces them.
 *
 * `ChannelListResponseChannel` is exactly `{id, name?, state, participantCount}`
 * (`packages/contracts/src/channels.ts`), so this table carries those four members and
 * nothing about audience, kind, or pairing: those reach the console from the roster
 * read in `collaboration-growth-replies.ts`, which is a different wire. The bootstrap
 * name is taken from `MAIN_CHANNEL_NAME` rather than spelled here — the value belongs
 * to the producer, and a fixture that wrote the word down would go on serving the old
 * one after the vocabulary moved.
 *
 * FOUR ROWS, BECAUSE THE DIRECTORY HAS FOUR RENDERINGS. The bootstrap row is hoisted
 * and never badged, a live named row carries its audience, an archived row sinks below
 * the live ones into their own region, and the unnamed row is the `direct` channel the
 * list labels by the other human in its pair. A table without the last two leaves two
 * of the four dead.
 */
interface CollaborationChannel {
  readonly channelId: string;
  /** The daemon's opaque row id for the `channel.created` beat this row produces. */
  readonly eventId: string;
  /**
   * Absent for the `direct` channel, whose label is the other human in its pair.
   *
   * `undefined` rather than optional, so a row that means to state the absence has
   * to write it: `channel.created` OMITS the member for such a channel, and a table
   * where the absence could be a forgotten member would let a row drift into
   * scripting a shape the beat cannot then produce.
   */
  readonly name: string | undefined;
  readonly state: "active" | "archived";
  readonly participantCount: number;
}

export const COLLABORATION_CHANNELS: readonly CollaborationChannel[] = [
  {
    channelId: CHANNEL_MAIN,
    eventId: "019b7904-8ce0-7ea1-8150-cca0117a0405",
    name: MAIN_CHANNEL_NAME,
    state: "active",
    participantCount: 4,
  },
  {
    channelId: CHANNEL_REVIEW,
    eventId: "019b7904-8ce0-7ea1-8160-cca0117a0406",
    name: "review",
    state: "active",
    participantCount: 3,
  },
  {
    channelId: CHANNEL_HANDOFF,
    eventId: "019b7904-8ce0-7ea1-8170-cca0117a0407",
    name: "handoff",
    state: "archived",
    participantCount: 2,
  },
  {
    channelId: CHANNEL_DIRECT,
    eventId: "019b7904-8ce0-7ea1-8175-cca0117a0407",
    // No name, which is the wire shape a `direct` channel has: its label is the other
    // human in the pair and the row reaches that through the roster read.
    name: undefined,
    state: "active",
    participantCount: 2,
  },
];

/**
 * What the machine script needs from this scenario: the session, who owns which
 * machine in registration order, and the first free position in the event log.
 *
 * Stated here rather than reached for over there, so the two scripts share exactly
 * these three facts and neither file imports the other's identifiers.
 */
export const RUNTIME_NODE_SCRIPT: CollaborationRuntimeNodeScript = {
  sessionId: SESSION_ID,
  ownerParticipantIds: [PARTICIPANT_YOU, PARTICIPANT_PRIYA, PARTICIPANT_TOMAS],
  // Twelve beats precede them: the session, three memberships, four channels, one
  // archival, and three presence transitions.
  firstSequence: 13,
};
