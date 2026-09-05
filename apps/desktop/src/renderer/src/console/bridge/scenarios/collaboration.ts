// The collaboration scenario — a room with people in it.
//
// A session that has PEOPLE and CHANNELS in it, which is the one thing neither
// substrate scenario supplies: `first-run` has a single participant and no
// structure, and `flagship` is about four agents working at once. The roster, the
// channel list, the members section, and the sent-invite ledger are built against
// this one.
//
// The join order is load-bearing for the same reason it is in `flagship.ts`:
// `Spec-023 §Console Design (Meridian)` rule 2 allocates participant hues by
// join-log order, so this array is what the hue allocator consumes and what a
// screenshot baseline of the roster depends on.
//
// Every `kind` below is a registered wire event type (`packages/contracts/src/event.ts`
// `SessionEventType`) CARRYING THE REGISTERED PAYLOAD, and `scenarios/wire-truth.ts`
// holds this file to both. A fixture that scripted a type the daemon cannot emit —
// or a payload its `.strict()` schema rejects — would teach the console a shape it
// will never meet, and every screenshot and end-to-end result taken against it
// would look like a pass. Two consequences a reader meets first, the same two
// `flagship.ts` records: the identifiers are the branded UUIDs the strict layer
// declares, and `session.created` carries `{sessionId, config, metadata}` rather
// than a title — a session's display name reaches the console from the session
// read, never from the creation event. The roles are the wire's four
// (`MembershipRole` in `packages/contracts/src/session.ts`), which is the same
// closed set `collaboration/members/members-model.ts` reads.
//
// FOUR PEOPLE, BECAUSE THE ROSTER HAS FOUR STATES. `PresenceState` is
// `online | idle | reconnecting | offline` and `collaboration/members/presence-model.ts`
// renders them in exactly that order, keeping an offline member IN the list rather
// than dropping them. A three-person roster leaves one of those four rows — the
// dimmed one, which is the row with a rendering of its own — unreachable, so the
// scenario carries the fourth person whose only job is to be away.
//
// WHY THE PRESENCE READ IS A REPLY AND THE PRESENCE EVENTS ARE BEATS. The roster's
// whole discipline is that the READ is the truth and the push is only a SIGNAL: it
// never decodes a push payload and answers every one with a fresh read. So the
// four states live in the `presence.read` reply, which is the registered
// `PresenceReadResponse`, and the `presence.*` beats exist to make the signal
// arrive at all. Their payloads carry the session and the participant the envelope
// is about and nothing else — the census registers these four types with no
// payload variant, and a fixture that invented a device id or a last-seen member
// for them would be teaching a shape to a surface that has promised not to read it.
//
// WHY THE MACHINES ARE IN A SIBLING FILE. A room with people in it is a room with
// their MACHINES in it: three participants attach one runtime node each, which is
// the multi-node case the registered roster read exists for. But that is a second
// script rather than more of this one — it plays `runtime_node.*` beats and is read
// back through `runtimenode.roster` rather than `presence.read` — so it lives in
// `collaboration-runtime-nodes.js` and takes from here only the session, who owns
// which machine, and the first free log position. That file states what the two
// surfaces disagree about and why the disagreement is the point.
//
// WHY THERE IS NO INVITE BEAT AND THERE IS AN INVITE REPLY. `invite.created` is a
// census type with no registered payload variant and no consumer: the sent-invite
// ledger reads the growth port's `invitesList`, not the event stream. So the
// expiring invitation this scenario exists to show reaches the surface through a
// scripted `invite.list` reply — served through the fixture growth port, in the
// `GrowthInviteSummary` shape the console itself declares — and no event payload is
// invented for a read nothing performs.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import type { ParticipantId } from "@ai-sidekicks/contracts";

import {
  collaborationRuntimeNodeBeats,
  collaborationRuntimeNodeRoster,
  type CollaborationRuntimeNodeScript,
} from "./collaboration-runtime-nodes.js";
import type { ConsoleScenario } from "../scenario.js";

export const COLLABORATION_SCENARIO_ID = "collaboration";

// Wire identifiers, spelled as the wire spells them — UUID v7 values whose leading
// bytes are this scenario's own start instant, so a rendered id still tells one
// fixture apart from another.
//
// The participants are branded at their declaration because the ROSTER read types
// its `participantId` as one, while an event payload types every member `unknown`;
// one assertion per constant is what keeps the machine script's rows free of them.
// The assertion is a claim, and the bridge seam's test discharges it by parsing
// every shipped frame with the registered `RuntimeNodeRosterResponseSchema`.
const SESSION_ID = "019b7904-8ce0-75e5-8510-ada11a5a33a5";
const PARTICIPANT_YOU = "019b7904-8ce0-79a4-8110-cca0117a0330" as ParticipantId;
const PARTICIPANT_PRIYA = "019b7904-8ce0-79a4-8120-cca0117a0340" as ParticipantId;
const PARTICIPANT_TOMAS = "019b7904-8ce0-79a4-8130-cca0117a0350" as ParticipantId;
const PARTICIPANT_NOAH = "019b7904-8ce0-79a4-8140-cca0117a0355" as ParticipantId;
const MEMBERSHIP_PRIYA = "019b7904-8ce0-7e3b-8110-cca0117a0360";
const MEMBERSHIP_TOMAS = "019b7904-8ce0-7e3b-8120-cca0117a0370";
const MEMBERSHIP_NOAH = "019b7904-8ce0-7e3b-8130-cca0117a0375";
const CHANNEL_MAIN = "019b7904-8ce0-7c11-8110-cca0117a0380";
const CHANNEL_REVIEW = "019b7904-8ce0-7c11-8120-cca0117a0390";
const CHANNEL_HANDOFF = "019b7904-8ce0-7c11-8130-cca0117a0395";
const INVITE_EXPIRING = "019b7904-8ce0-7f22-8110-cca0117a03a0";
const INVITE_ACCEPTED = "019b7904-8ce0-7f22-8120-cca0117a03b0";

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
const COLLABORATION_PARTICIPANTS = [
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
] as const;

/** One row of the roster above, so the two beat subsets can name what they narrow to. */
type CollaborationParticipant = (typeof COLLABORATION_PARTICIPANTS)[number];

/**
 * The channels, as `channel.list` serves them and `channel.created` announces them.
 *
 * `ChannelListResponseChannel` is exactly `{id, name?, state, participantCount}`
 * (`packages/contracts/src/channels.ts`), so this table carries those four members
 * and nothing about audience or kind — the wire has neither, and
 * `collaboration/channels/channel-model.ts` classifies rows from `state` and the bootstrap
 * name alone. That name is taken from `MAIN_CHANNEL_NAME` rather than spelled here:
 * the value belongs to the producer, and a fixture that wrote the word down would
 * go on serving the old one after the wire vocabulary moved — teaching the
 * directory a bootstrap row it would then refuse to lift. The archived row is here
 * because the directory renders live and archived as two regions and a list with no
 * archived row leaves one of them dead.
 */
const COLLABORATION_CHANNELS = [
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
] as const;

/**
 * What the machine script needs from this scenario: the session, who owns which
 * machine in registration order, and the first free position in the event log.
 *
 * Stated here rather than reached for over there, so the two scripts share exactly
 * these three facts and neither file imports the other's identifiers.
 */
const RUNTIME_NODE_SCRIPT: CollaborationRuntimeNodeScript = {
  sessionId: SESSION_ID,
  ownerParticipantIds: [PARTICIPANT_YOU, PARTICIPANT_PRIYA, PARTICIPANT_TOMAS],
  // Eleven beats precede them: the session, three memberships, three channels, one
  // archival, and three presence transitions.
  firstSequence: 12,
};

export const COLLABORATION_SCENARIO: ConsoleScenario = {
  id: COLLABORATION_SCENARIO_ID,
  label: "A room with people in it",
  purpose:
    "Four participants across all four presence states, three channels including an archived one, and one invitation about to expire — the roster, the channel list, the members section, and the sent-invite ledger are built against this one.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: COLLABORATION_PARTICIPANTS.map(
    (participant) => participant.participantId,
  ),
  // Which of the four this window is. Stated rather than inferred from the head of
  // the join order — that entry is whoever opened the session, on whichever machine,
  // and the two facts coincide here only because this scenario chose to make them.
  // The members section reads it to mark the reader's own row rather than to gate a
  // control, which is why the owner is the honest choice: an owner's row is the one
  // whose role controls are all reachable.
  viewingParticipantId: PARTICIPANT_YOU,
  // The role every gated control resolves the viewer through, derived from the roster
  // above rather than restated beside it. Each row already carries the role its
  // `membership.created` beat plays, so a second hand-written table here would be the
  // same fact twice and free to disagree with itself. Every id in the join order is a
  // person: this scenario attaches no agent, so the map is total over the roster.
  membershipRoleByParticipantId: Object.fromEntries(
    COLLABORATION_PARTICIPANTS.map(
      (participant) => [participant.participantId, participant.role] as const,
    ),
  ),
  startedAtIso: "2026-01-01T10:05:00.000Z",
  runtimeNodeRoster: collaborationRuntimeNodeRoster(RUNTIME_NODE_SCRIPT),
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b7904-8ce0-7ea1-8110-cca0117a0401",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T10:05:00.000Z",
        actorId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    ...COLLABORATION_PARTICIPANTS.filter(
      (participant): participant is Extract<CollaborationParticipant, { membershipId: string }> =>
        participant.membershipId !== undefined,
    ).map((participant, joinIndex) => ({
      atMs: participant.joinedAtMs ?? 0,
      event: {
        id: participant.membershipEventId,
        sessionId: SESSION_ID,
        sequence: 2 + joinIndex,
        kind: "membership.created",
        occurredAt: participant.joinedAtIso ?? "2026-01-01T10:05:00.000Z",
        actorId: participant.participantId,
        payload: {
          membershipId: participant.membershipId,
          participantId: participant.participantId,
          role: participant.role,
          identityHandle: participant.identityHandle,
        },
      },
    })),
    ...COLLABORATION_CHANNELS.map((channel, channelIndex) => ({
      atMs: 200 + channelIndex * 40,
      event: {
        id: channel.eventId,
        sessionId: SESSION_ID,
        sequence: 5 + channelIndex,
        kind: "channel.created",
        occurredAt: `2026-01-01T10:05:00.${String(200 + channelIndex * 40)}Z`,
        actorId: PARTICIPANT_YOU,
        // The registered shape, verbatim: `{channelId, name?}`. A channel's state
        // and its participant count reach the console from `channel.list`, never
        // from the creation event, so neither is carried here.
        payload: { channelId: channel.channelId, name: channel.name },
      },
    })),
    {
      atMs: 340,
      event: {
        id: "019b7904-8ce0-7ea1-8180-cca0117a0408",
        sessionId: SESSION_ID,
        sequence: 8,
        kind: "channel.archived",
        occurredAt: "2026-01-01T10:05:00.340Z",
        actorId: PARTICIPANT_YOU,
        // One of the four kinds `collaboration/channels/channel-model.ts` re-reads on, so
        // this beat is what proves the directory refreshes from a signal rather
        // than from a timer. The census registers no payload variant for it, so the
        // payload carries the channel the event is about and invents nothing else.
        payload: { sessionId: SESSION_ID, channelId: CHANNEL_HANDOFF },
      },
    },
    ...COLLABORATION_PARTICIPANTS.filter(
      (
        participant,
      ): participant is Exclude<CollaborationParticipant, { presenceState: "online" }> =>
        participant.presenceState !== "online",
    ).map((participant, presenceIndex) => ({
      atMs: 380 + presenceIndex * 20,
      event: {
        id: participant.presenceEventId,
        sessionId: SESSION_ID,
        sequence: 9 + presenceIndex,
        kind: `presence.${participant.presenceState}` as const,
        occurredAt: participant.lastSeenIso,
        actorId: participant.participantId,
        // Opaque BY CONTRACT. The roster treats every presence push as a change
        // signal and answers it with a fresh `presence.read`, so this payload is
        // never decoded by anything — which is exactly why it carries the two
        // identifiers the envelope is about and no third member.
        payload: { sessionId: SESSION_ID, participantId: participant.participantId },
      },
    })),
    ...collaborationRuntimeNodeBeats(RUNTIME_NODE_SCRIPT),
  ],
  replies: [
    {
      // The registered `PresenceReadResponse`: `{participants: [{participantId,
      // state, lastSeen}]}` and nothing beside it — the schema is `.strict()`, so a
      // role or a display name here would be rejected outright. Role lives on the
      // membership projection and the roster reads it from there.
      call: "presence.read",
      result: {
        participants: COLLABORATION_PARTICIPANTS.map((participant) => ({
          participantId: participant.participantId,
          state: participant.presenceState,
          lastSeen: participant.lastSeenIso,
        })),
      },
    },
    {
      call: "channel.list",
      result: {
        channels: COLLABORATION_CHANNELS.map((channel) => ({
          id: channel.channelId,
          name: channel.name,
          state: channel.state,
          participantCount: channel.participantCount,
        })),
      },
    },
    {
      // Served through the fixture growth port's `invitesList`, in the
      // `GrowthInviteSummary` shape the console declares: `{inviteId, state,
      // expiresAt}`. There is no plaintext token and no join link, because
      // `invite.create` returns the token exactly once and nothing hands this
      // renderer its control-plane host — a fixture that supplied either would let
      // a copy-link control be built against an identifier that opens nothing.
      //
      // The pending row expires forty seconds after the scenario starts, so a
      // console driven past that tick sees an invitation age out rather than one
      // frozen permanently on the brink.
      call: "invites.list",
      result: [
        { inviteId: INVITE_EXPIRING, state: "pending", expiresAt: "2026-01-01T10:05:40.000Z" },
        { inviteId: INVITE_ACCEPTED, state: "accepted", expiresAt: "2026-01-01T10:04:00.000Z" },
      ],
    },
    // No agent has been attached, and the empty list is the honest reading rather
    // than an absent reply: the read succeeded and this room has no agents in it.
    { call: "agent.list", result: { agents: [] } },
  ],
};
