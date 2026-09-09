// The identifiers and the two cast tables the collaboration scenario's parts share.
//
// Its own module for `composer.identifiers.ts`'s reason, which this scenario now
// meets four times over: the beats, the scripted replies, the activity frames, and
// the deep-link invitations all describe the SAME four people, the same four
// channels, and the same session, and they live in four files. An id declared in any
// one of them would be a value the other three could only match by copying it, which
// is how a fixture comes to answer a read about a person no beat admitted.
//
// THE ROSTER IS A TWO-ARM UNION AND THAT IS LOAD-BEARING. `presence-timeline.ts`
// narrows it to the rows that are not `online` — through `Exclude` over
// {@link CollaborationParticipant}, resolving to {@link CollaborationJoiner} — so the
// three presence transitions are derived from the roster rather than written a second
// time. It does NOT narrow the membership beats: every person in this room is admitted
// by one, the opener included, which is what the two arms now differ about and what
// they used to differ about wrongly. Declaring the arms is also what lets the table be
// EXPORTED at all: `--isolatedDeclarations` cannot write the declaration for an
// `as const` table whose members are references to other constants, which is what
// this table was while it lived beside its one reader.

import { MAIN_CHANNEL_NAME, ParticipantIdSchema, SessionIdSchema } from "@ai-sidekicks/contracts";
import type { MembershipRole, ParticipantId, SessionId } from "@ai-sidekicks/contracts";

import type { CollaborationRuntimeNodeScript } from "./runtime-nodes.js";
import type { GrowthInviteAttempt } from "../../growth-values/index.js";

// Wire identifiers, spelled as the wire spells them — UUID v7 values whose leading
// bytes are this scenario's own start instant, so a rendered id still tells one
// fixture apart from another.
//
// The participants are branded at their declaration because the ROSTER read types
// its `participantId` as one, while an event payload types every member `unknown`;
// one brand per constant is what keeps the machine script's rows free of casts.
// MINTED THROUGH `ParticipantIdSchema` RATHER THAN `as`-CAST: a cast asserts the
// brand and checks nothing, so a malformed id surfaced at the first `.strict()`
// reply that carried it and named the reply rather than the value. The parse fails
// this module instead, and the bridge seam's test still checks the frames it
// composes against the registered `RuntimeNodeRosterResponseSchema`.
export const SESSION_ID: SessionId = SessionIdSchema.parse("019b7904-8ce0-75e5-8510-ada11a5a33a5");
/**
 * The instant this room's frozen clock starts at — the scenario's own zero.
 *
 * ONE HOME, because two parts of the scenario measure time in different units and
 * meet here. `ScenarioEngine` builds its `ManualClock` from `startedAtIso`, so what a
 * computed reply is handed is an ABSOLUTE instant, while every beat's `atMs` is an
 * OFFSET from this one — and `presence-timeline.ts` converts between them. Written
 * twice, the two spellings of the room's zero would be free to disagree, and the
 * symptom would be a schedule every read considered either due or never due.
 */
export const SESSION_STARTED_AT_ISO = "2026-01-01T10:05:00.000Z";
export const PARTICIPANT_YOU: ParticipantId = ParticipantIdSchema.parse(
  "019b7904-8ce0-79a4-8110-cca0117a0330",
);
export const PARTICIPANT_PRIYA: ParticipantId = ParticipantIdSchema.parse(
  "019b7904-8ce0-79a4-8120-cca0117a0340",
);
export const PARTICIPANT_TOMAS: ParticipantId = ParticipantIdSchema.parse(
  "019b7904-8ce0-79a4-8130-cca0117a0350",
);
const PARTICIPANT_NOAH = ParticipantIdSchema.parse("019b7904-8ce0-79a4-8140-cca0117a0355");
// The opener's own. Minted here beside the other three rather than in the growth
// script that used to hold it: `session.create` answers with a membership for the
// person who opened the session, so the opener's row is a row like any other and a
// membership id living in the reply table alone was one person's identity declared
// somewhere no beat could reach.
const MEMBERSHIP_YOU = "019b7904-8ce0-7e3b-8140-cca0117a0378";
const MEMBERSHIP_PRIYA = "019b7904-8ce0-7e3b-8110-cca0117a0360";
const MEMBERSHIP_TOMAS = "019b7904-8ce0-7e3b-8120-cca0117a0370";
const MEMBERSHIP_NOAH = "019b7904-8ce0-7e3b-8130-cca0117a0375";
export const CHANNEL_MAIN = "019b7904-8ce0-7c11-8110-cca0117a0380";
export const CHANNEL_REVIEW = "019b7904-8ce0-7c11-8120-cca0117a0390";
export const CHANNEL_HANDOFF = "019b7904-8ce0-7c11-8130-cca0117a0395";
export const CHANNEL_DIRECT = "019b7904-8ce0-7c11-8135-cca0117a0396";
export const INVITE_EXPIRING = "019b7904-8ce0-7f22-8110-cca0117a03a0";
export const INVITE_ACCEPTED = "019b7904-8ce0-7f22-8120-cca0117a03b0";
// The ones this scenario MINTS, when a person fills the create form in and presses
// send. They are not in the ledger above: they do not exist until the act, which is
// the whole difference between a row the read returns and a row the create makes.
//
// A SEQUENCE AND NOT A CONSTANT, because a person sends more than one invitation: a
// fixed receipt handed the second mint the first one's identity, so the ledger held
// two rows under one key, the list drew duplicate keys, and revoking either moved
// both. The mint's ordinal comes off the engine — see `ScenarioComputedReply` — and
// the last field of the UUID carries it, which keeps every id in the sequence a
// well-formed v7 the registered `InviteCreateResponseSchema` accepts. The token moves
// with it for the same reason and one more: a token is handed out exactly once, so two
// invitations sharing one would be teaching a control plane that reissues credentials.
const MINTED_INVITE_ID_PREFIX = "019b7904-8ce0-7f22-8130-";
const MINTED_INVITE_TOKEN_PREFIX = "v4.local.V0hBVEVWRVIgVEhFIENPTlRST0wgUExBTkUgTUlOVEVE";
/**
 * The UUID node field, which the ordinal takes whole.
 *
 * Twelve hex digits, so the ordinal cannot overflow the field and make an id the
 * schema would reject — the fixture would exhaust memory long before it exhausted
 * this. The four groups ahead of it already mark this room and this brand of id, so
 * the node carries nothing else and the sequence reads as one at a glance.
 */
const MINTED_ORDINAL_WIDTH = 12;

/** The invite id this room's `mintOrdinal`-th `invite.create` answers with. */
export function collaborationMintedInviteId(mintOrdinal: number): string {
  return `${MINTED_INVITE_ID_PREFIX}${mintedOrdinalDigits(mintOrdinal)}`;
}

/**
 * The plaintext token that mint hands back, in the base64url-ish shape the wire uses.
 *
 * Hex digits are all base64url characters, so the ordinal rides the blob's tail
 * without teaching the reveal a shape a PASETO string could not have.
 */
export function collaborationMintedInviteToken(mintOrdinal: number): string {
  return `${MINTED_INVITE_TOKEN_PREFIX}${mintedOrdinalDigits(mintOrdinal)}`;
}

/** The ordinal as fixed-width hex, which both spellings above append. */
function mintedOrdinalDigits(mintOrdinal: number): string {
  return mintOrdinal.toString(16).padStart(MINTED_ORDINAL_WIDTH, "0");
}

/** The id the FIRST mint of a playback answers with. Every consumer derives it. */
export const INVITE_MINTED: string = collaborationMintedInviteId(1);

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
// The deep link whose preview never reached the control plane, and the invitation
// re-driving it mints. The handle is a DIFFERENT BRAND from the references above —
// it names an outstanding link rather than a confirmable invitation, and no act that
// spends a reference accepts one — so it is branded where it is declared, which is
// also the one place this scenario asserts a brand it does not compute.
export const PENDING_ATTEMPT_UNREACHED = "pending-attempt-unreached" as GrowthInviteAttempt;
export const PENDING_REFERENCE_RECHECKED = "pending-ref-rechecked";
export const PENDING_REFERENCE_LAPSED = "pending-ref-lapsed";
export const INVITED_SESSION_ROADMAP = "019b7904-8ce0-7f22-8180-cca0117a0450";
export const INVITED_SESSION_INCIDENT = "019b7904-8ce0-7f22-8190-cca0117a0460";
// A run this session's log has NOT carried, and deliberately so — see the activity
// frames below, which say why an unresolved run id is the case worth scripting.
export const PEER_RUN_ID = "019b7904-8ce0-740e-8110-cca0117a03c0";

/**
 * The state a session member holds the moment their `membership.created` beat admits
 * them, and holds until a `presence.*` transition says otherwise.
 *
 * DECLARED ONCE AND READ TWICE. The opener's row states it because that is where the
 * opener stays, and `presence-timeline.ts` answers with it for every row whose
 * transition is still ahead of the clock — so the state a read opens with and the
 * state that pins the roster's joiner arm cannot become two different words.
 */
export const PRESENCE_STATE_AT_JOIN = "online" as const;

/** What every person in this room has, whichever way they arrived. */
interface CollaborationMember {
  readonly participantId: ParticipantId;
  readonly identityHandle: string;
  /**
   * The `membership.created` beat that admits them.
   *
   * Required on BOTH arms, which is the correction this shape carries. The opener used
   * to declare an absent membership on the reading that `session.created` admits them
   * and no second event does — and the real `session.create` path emits a canonical
   * `membership.created` for the creator immediately after it, because a membership is
   * what the creator is given. With the beat missing, the fold that reads
   * `identityHandle` off it never saw the owner's, so every surface that resolves a
   * participant label through the projection rendered this room's owner as a raw UUID
   * and the production creator-admission path was exercised by nothing.
   */
  readonly membershipEventId: string;
  readonly role: MembershipRole;
  readonly membershipId: string;
  readonly joinedAtMs: number;
  readonly joinedAtIso: string;
  /**
   * The stamp this row carries once this person's presence has SETTLED.
   *
   * For a joiner it is the transition's own stamp — the `presence.*` frame's
   * `occurredAt`, and what `lastSeen` reads once that frame is due. For the opener,
   * whom no transition moves, it is the standing stamp their row carries for the life
   * of the room. It is NOT what a read answers before a transition falls due:
   * `presence-timeline.ts` answers those rows at their own join instant, because a
   * stamp the script has not reached is a reading from the future.
   */
  readonly lastSeenIso: string;
}

/**
 * The session's OPENER, whom `session.created` admits and `membership.created` records.
 *
 * A shape of its own rather than a row with optional members, because one absence
 * still distinguishes them: `online` is the state the session OPENS in, so no
 * `presence.*` transition announces it and there is no event id for one. That is this
 * window's own person, and it is why the presence beats are derived from the other arm.
 */
interface CollaborationOpener extends CollaborationMember {
  readonly presenceEventId: undefined;
  readonly presenceState: "online";
}

/**
 * Everyone else: a person one `membership.created` beat admitted and one
 * `presence.*` beat moved.
 *
 * Every member is required, which is the whole reason the two shapes are separate:
 * `presence-timeline.ts` filters the roster to exactly this arm to build the schedule
 * the beats and the presence read both fold, and then reads the event id and the
 * stamp with no optionality left to check.
 */
interface CollaborationJoiner extends CollaborationMember {
  readonly presenceEventId: string;
  readonly presenceState: "idle" | "reconnecting" | "offline";
}

/** One row of the roster, so the two beat subsets can name what they narrow to. */
export type CollaborationParticipant = CollaborationOpener | CollaborationJoiner;

/**
 * Who is in the room, in join order, and what the roster read says of each.
 *
 * ONE TABLE rather than a membership literal per beat and a presence literal per
 * reply, on `flagship.ts`'s rule: the `membership.created` event and the
 * `presence.read` row are two views of one person, and two hand-written copies of
 * one person drift in exactly the direction nothing catches. `you` carries a
 * membership beat like everyone else — the session's opener is admitted by
 * `session.created` and RECORDED by the `membership.created` the same path emits —
 * and carries no presence beat, because `online` is the state the session opens in.
 *
 * The four presence states are covered exactly once each, which is what makes the
 * roster's render order and its dimmed offline row both reachable from one script.
 */
export const COLLABORATION_PARTICIPANTS: readonly CollaborationParticipant[] = [
  {
    participantId: PARTICIPANT_YOU,
    identityHandle: "sawyer",
    membershipEventId: "019b7904-8ce0-7ea1-8115-cca0117a0401",
    presenceEventId: undefined,
    role: "owner",
    membershipId: MEMBERSHIP_YOU,
    // The session's own instant: the creator's admission is emitted immediately after
    // `session.created` rather than at a tick of its own, so the two share a moment.
    joinedAtMs: 0,
    joinedAtIso: SESSION_STARTED_AT_ISO,
    presenceState: PRESENCE_STATE_AT_JOIN,
    // The session's own instant again, and for the reason the join carries it: no
    // transition ever moves this row, so its settled stamp IS its join stamp. It read
    // 400ms while the presence reply was a fixed table, which put the opener's last
    // sighting four hundred milliseconds after a read taken at tick zero.
    lastSeenIso: SESSION_STARTED_AT_ISO,
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
 * read in `growth-replies.ts`, which is a different wire. The bootstrap
 * name is taken from `MAIN_CHANNEL_NAME` rather than spelled here — the value belongs
 * to the producer, and a fixture that wrote the word down would go on serving the old
 * one after the vocabulary moved.
 *
 * FOUR ROWS, BECAUSE THE DIRECTORY HAS FOUR RENDERINGS. The bootstrap row is hoisted
 * and never badged, a live named row carries its audience, an archived row sinks below
 * the live ones into their own region, and the unnamed row is the `direct` channel the
 * list labels by the other human in its pair. A table without the last two leaves two
 * of the four dead — and the archived rendering is reached by PLAYING the archival
 * rather than by declaring it, which is what makes both the live and the archived
 * reading of one row reachable from one script.
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
  /**
   * The state the directory OPENS in — what `channel.list` answers at tick zero.
   *
   * Not the state the room ends in, which is the correction this member carries. This
   * table used to state the handoff channel archived while the script did not archive
   * it until 340ms, so a read before the beat exposed future state and the refresh the
   * beat triggers produced no transition at all — the lifecycle behaviour the scenario
   * exists to show was unreachable, in both directions, from the one table that
   * decided it. What a read after the beat answers is the fixture's fold of the
   * delivered `channel.*` frames over this opening row, so there is one statement of
   * where the row starts and one of what moves it.
   */
  readonly state: "active" | "archived";
  /**
   * The tick this channel's `channel.archived` beat is due at, or `undefined` for a
   * channel this script never archives.
   *
   * `undefined` rather than optional, on the `name` member's rule: a row that means to
   * say it is never archived has to write it, and the beat is DERIVED from this member
   * so the tick has one home rather than two that can disagree.
   */
  readonly archivedAtMs: number | undefined;
  readonly participantCount: number;
}

export const COLLABORATION_CHANNELS: readonly CollaborationChannel[] = [
  {
    channelId: CHANNEL_MAIN,
    eventId: "019b7904-8ce0-7ea1-8150-cca0117a0405",
    name: MAIN_CHANNEL_NAME,
    state: "active",
    archivedAtMs: undefined,
    participantCount: 4,
  },
  {
    channelId: CHANNEL_REVIEW,
    eventId: "019b7904-8ce0-7ea1-8160-cca0117a0406",
    name: "review",
    state: "active",
    archivedAtMs: undefined,
    participantCount: 3,
  },
  {
    channelId: CHANNEL_HANDOFF,
    eventId: "019b7904-8ce0-7ea1-8170-cca0117a0407",
    name: "handoff",
    // Live when the room opens and archived by its own beat, which is the whole of
    // what this row is for: the directory's archived region and its active-to-archived
    // transition are two different renderings and both are reached from here.
    state: "active",
    archivedAtMs: 340,
    participantCount: 2,
  },
  {
    channelId: CHANNEL_DIRECT,
    eventId: "019b7904-8ce0-7ea1-8175-cca0117a0407",
    // No name, which is the wire shape a `direct` channel has: its label is the other
    // human in the pair and the row reaches that through the roster read.
    name: undefined,
    state: "active",
    archivedAtMs: undefined,
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
  // Thirteen beats precede them: the session, four memberships, four channels, one
  // archival, and three presence transitions.
  firstSequence: 14,
};
