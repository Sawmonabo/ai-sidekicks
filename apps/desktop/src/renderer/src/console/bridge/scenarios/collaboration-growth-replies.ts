// What the collaboration room answers for the wires the bridge does not carry yet.
//
// A sibling of `collaboration.ts` on `collaboration-runtime-nodes.ts`'s rule: this is
// a second script rather than more of the first one. Everything here is served through
// the growth port rather than through `daemon.call`, every row is keyed on the growth
// slate's own expected wire method, and none of it reaches a surface through the live
// bridge — which is exactly the state the slate exists to record.
//
// WHAT THE THREE READS CARRY, AND WHY NONE OF THEM IS DERIVABLE FROM THE BEATS.
//
//   • The CHANNEL ROSTER carries a channel's kind, its member pair, and the
//     configuration whose audience says whether this session's agents read it.
//     `ChannelListResponseChannel` carries none of the three, and no registered event
//     payload names an audience — `channel.created` is `{channelId, name?}` — so a
//     fold over the beats could reach every channel in the room and would still have
//     to invent what each one is FOR. The main channel is deliberately absent from
//     this reply: it has no channel row at all, its audience is fixed at
//     `participants`, and a row here would be the fixture minting a record the daemon
//     does not keep.
//   • The MEMBERSHIP ROSTER carries the identifier `membership.update` is keyed by.
//     The `membership.created` beats carry one each, but the session's OPENER has no
//     such beat — `session.created` admitted them — so a fold over the log reaches
//     three of the four people in this room and the fourth is the owner, whose row is
//     the one every role control is reached from. The opener's membership id is real
//     and its EVENT is not, which is why it is minted here beside the read that
//     carries it rather than in the beat table that cannot.
//   • The PRESENCE DETAIL carries the devices behind one person's aggregated state.
//     `presence.read` carries the aggregate and the four `presence.*` beats carry no
//     payload variant at all, so per-device detail exists on no other wire. Each
//     aggregate here AGREES with the roster's own row for that participant: the
//     detail is what stands behind the summary, never a second answer to it.
//   • The TERMINAL-CONTROL HOLDER is the one session-scoped fact of the four. It is
//     stated rather than folded for the reason the surface reading it is forbidden to
//     fold one: the holder is a wire field, and a room that derived it from whichever
//     `pty.control_changed` beat happened to be last would be the exact derivation
//     `Spec-023 §Console Design (Meridian)` 8.8 rules out.
//
// AND WHY THE FOUR WRITES ANSWER AND THE REFUSALS ARE NOT SCRIPTED HERE. A scenario
// scripts one reply per call, and a reply is either a value or a refusal — so a script
// that refused `channel.create` would make creating a channel impossible in the one
// scenario built to show a room with channels in it. The refusal renderings are driven
// where they can be driven exhaustively: co-located tests over the surfaces
// themselves, one per registered code. What this script covers is the path a person
// takes when nothing goes wrong, which no unit test covers.

import { requestedIdentifier, answerFor } from "./scripted-request.js";
import {
  MEMBERSHIP_ROSTER_READ_CALL,
  TERMINAL_CONTROL_HOLDER_READ_CALL,
} from "../fixture/fixture-collaboration-reads.js";
import type { ScenarioReply } from "../scenario-runtime/index.js";

/** What this script needs from the room: who is in it, and which channels it has. */
export interface CollaborationGrowthScript {
  readonly participants: readonly CollaborationGrowthParticipant[];
  readonly channelIds: CollaborationGrowthChannelIds;
  /**
   * The two humans the direct channel is between, in the order the daemon fixed.
   *
   * Stated rather than taken from the head of the roster: the pair is canonicalized at
   * creation and carries no meaning beyond membership, so deriving it from join order
   * would make the fixture's pair an accident of who joined first.
   */
  readonly directChannelPair: readonly [string, string];
  /**
   * Who holds the session's one shared-terminal write lease, or `null` for unheld.
   *
   * A member rather than a derivation, and deliberately not the viewing participant:
   * the reading a person cannot get any other way is somebody ELSE holding the shell,
   * and a room whose viewer always held it would never draw that row.
   */
  readonly terminalControlHolder: string | null;
}

/** One person, as the two membership-keyed reads and the presence detail see them. */
export interface CollaborationGrowthParticipant {
  readonly participantId: string;
  /** Absent for the session's opener, whose membership no beat announces. */
  readonly membershipId: string | undefined;
  readonly role: string;
  readonly presenceState: string;
  readonly lastSeenIso: string;
}

/** The three channels this script states a policy for. Main deliberately absent. */
export interface CollaborationGrowthChannelIds {
  readonly review: string;
  readonly handoff: string;
  readonly direct: string;
}

/**
 * The opener's membership id, minted here rather than in the beat table.
 *
 * The session's opener is admitted by `session.created` and has no
 * `membership.created` event, so the beat table states that with an absent id. The
 * membership itself is not absent — `session.create` answers with one — and the owner
 * row is where every role control is reached from, so a roster read that skipped it
 * would leave the one row that matters most permanently uncontrolled.
 */
const MEMBERSHIP_OPENER = "019b7904-8ce0-7e3b-8140-cca0117a0378";

/** What creating a channel answers with. One id, because one create is scripted. */
const CHANNEL_CREATED = "019b7904-8ce0-7c11-8140-cca0117a0398";

/** The instant the created channel reports. The scenario's own start, one minute on. */
const CHANNEL_CREATED_AT = "2026-01-01T10:06:00.000Z";

/**
 * The devices behind each person's aggregate, keyed by participant.
 *
 * Built from the roster rather than written beside it, so the aggregate a detail card
 * shows can never disagree with the row it opened from. The fan-out differs per person
 * on purpose: an idle member on two devices is the reading the card exists for, and an
 * offline member on NO device is the empty state a card that only ever listed rows
 * would never draw.
 */
function presenceDetailFor(participant: CollaborationGrowthParticipant): unknown {
  const devices =
    participant.presenceState === "offline"
      ? []
      : participant.presenceState === "idle"
        ? [
            {
              deviceId: `${participant.participantId}:desk`,
              state: participant.presenceState,
              lastSeen: participant.lastSeenIso,
            },
            {
              deviceId: `${participant.participantId}:phone`,
              state: "offline",
              lastSeen: participant.lastSeenIso,
            },
          ]
        : [
            {
              deviceId: `${participant.participantId}:desk`,
              state: participant.presenceState,
              lastSeen: participant.lastSeenIso,
            },
          ];
  return {
    participantId: participant.participantId,
    devices,
    aggregateState: participant.presenceState,
  };
}

/** The channel roster: what each channel is FOR, in the shape the growth read carries. */
function channelRosterEntries(script: CollaborationGrowthScript): unknown {
  return [
    {
      id: script.channelIds.review,
      name: "review",
      kind: "general",
      config: {
        // A round-robin channel with a moderation gate and a per-agent cap, which is
        // the fullest configuration a channel can carry: a fixture whose every channel
        // was free-form would leave the other four members of `ChannelConfig` drawn by
        // nothing.
        turnPolicy: "round-robin",
        turnsPerAgent: 2,
        moderation: { preTurnGate: true, postTurnReview: false },
        audience: "participants",
      },
    },
    {
      id: script.channelIds.handoff,
      name: "handoff",
      kind: "general",
      // The archived row, and the one channel this session's agents never read. Both
      // facts on one row on purpose: an audience badge has to stay legible under the
      // archived row's own reduced weight.
      config: { turnPolicy: "free-form", audience: "humans-only" },
    },
    {
      id: script.channelIds.direct,
      // No name. A direct channel is labelled by the other human in its pair, and a
      // fixture that gave one a name would let the row render without ever reaching
      // the pair — which is the whole of what makes the row different.
      kind: "direct",
      memberPair: script.directChannelPair,
      config: { audience: "humans-only" },
    },
  ];
}

/**
 * Every growth-served reply this room answers, in one array the scenario spreads.
 *
 * One function rather than a constant, because three of the eight answers are computed
 * from the room's own roster and the fixture's whole discipline is that one fact has
 * one home.
 */
export function collaborationGrowthReplies(
  script: CollaborationGrowthScript,
): readonly ScenarioReply[] {
  const presenceDetailByParticipantId: Record<string, unknown> = Object.fromEntries(
    script.participants.map((participant) => [
      participant.participantId,
      presenceDetailFor(participant),
    ]),
  );
  return [
    { call: "channel.rosterRead", result: channelRosterEntries(script) },
    {
      // Keyed on the operation id under the `growth:` prefix, which is what the wire
      // rule requires of a slate row that declares no expected wire method: the corpus
      // registers a membership identifier on four write-shaped replies and on no read,
      // so there is no method name to transcribe here.
      call: MEMBERSHIP_ROSTER_READ_CALL,
      result: script.participants.map((participant) => ({
        participantId: participant.participantId,
        membershipId: participant.membershipId ?? MEMBERSHIP_OPENER,
        role: participant.role,
        state: "active",
      })),
    },
    {
      call: "participant.presenceDetail",
      resultFor: (request) => answerFor(presenceDetailByParticipantId, "participantId", request),
    },
    {
      // The holder, keyed on the operation id for the second of the two reasons a
      // slate row declares no wire method: the member is registered and the METHOD
      // carrying it is `runtimenode.roster`, whose shipped strict schema drops it.
      call: TERMINAL_CONTROL_HOLDER_READ_CALL,
      result: { controlHolder: script.terminalControlHolder },
    },
    {
      call: "channel.create",
      result: { channelId: CHANNEL_CREATED, state: "active", createdAt: CHANNEL_CREATED_AT },
    },
    // The three lifecycle receipts echo the channel they were asked about rather than
    // naming one: a receipt about a different channel than the caller sent would teach
    // a surface that a lifecycle move is session-wide.
    {
      call: "channel.mute",
      resultFor: (request) => lifecycleReceipt(request, "muted"),
    },
    {
      call: "channel.unmute",
      resultFor: (request) => lifecycleReceipt(request, "active"),
    },
    {
      call: "channel.archive",
      resultFor: (request) => lifecycleReceipt(request, "archived"),
    },
  ];
}

/** What a lifecycle move answers: the channel asked about, in the state it now holds. */
function lifecycleReceipt(request: unknown, state: string): unknown {
  const channelId = requestedIdentifier(request, "channelId");
  return channelId === undefined ? undefined : { channelId, state };
}
