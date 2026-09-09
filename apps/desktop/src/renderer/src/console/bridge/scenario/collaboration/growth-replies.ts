// What the collaboration room answers for the wires the bridge does not carry yet.
//
// A part of `collaboration.ts` on `runtime-nodes.ts`'s rule: this is
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
//   • The MEMBERSHIP ROSTER carries the membership STATE, which no beat states. Every
//     person in this room has a `membership.created` beat carrying their id — the
//     opener's included, because the real `session.create` path emits one for the
//     creator — so the ids come from the roster table rather than being minted here.
//     What a fold over those beats could never reach is `MembershipState`:
//     `membership.created` states none, and the four kinds that would announce one
//     carry no registered payload at all.
//   • The PRESENCE DETAIL carries the devices behind one person's aggregated state.
//     `presence.read` carries the aggregate and the four `presence.*` beats carry no
//     payload variant at all, so per-device detail exists on no other wire. Each
//     aggregate here AGREES with the roster's own row for that participant: the
//     detail is what stands behind the summary, never a second answer to it — AT
//     EVERY INSTANT, which is what the room hands this script the roster read for.
//     Building the card from the roster TABLE agreed only after every presence beat
//     had played: the row moved on the clock and the card did not, so a card opened
//     early reported somebody offline whom the roster beside it drew as here.
//   • The TERMINAL-CONTROL HOLDER is the one session-scoped fact of the four. It is
//     stated rather than folded for the reason the surface reading it is forbidden to
//     fold one: the holder is a wire field, and a room that derived it from whichever
//     `pty.control_changed` beat happened to be last would be the exact derivation
//     `Spec-023 §Console Design (Meridian)` 8.8 rules out.
//
// AND WHY THE FOUR WRITES ANSWER RATHER THAN REFUSING AS A TABLE ROW. A scenario
// scripts one reply per call, and a scripted refusal is that call's whole answer — so a
// row that refused `channel.create` would make creating a channel impossible in the one
// scenario built to show a room with channels in it. The refusal RENDERINGS are driven
// where they can be driven exhaustively: co-located tests over the surfaces themselves,
// one per registered code. What this script covers is the path a person takes when
// nothing goes wrong, which no unit test covers.
//
// A COMPUTED reply refuses per REQUEST, which is a different mechanism and the one the
// three lifecycle moves take: the call is served for every channel this room holds and
// refused for an id it does not, so both paths stay reachable through one row. That is
// the fixture answering as the daemon does rather than the scenario picking a side.

import { requestedIdentifier, answerFor, refuseAs } from "../computed-reply.js";
import {
  MEMBERSHIP_ROSTER_READ_CALL,
  TERMINAL_CONTROL_HOLDER_READ_CALL,
} from "../../fixture/collaboration/collaboration-reads.js";
import type { PresenceReadResponseParticipant } from "@ai-sidekicks/contracts";
import type { ScenarioReply } from "../runtime/index.js";

/** What this script needs from the room: who is in it, and which channels it has. */
export interface CollaborationGrowthScript {
  readonly participants: readonly CollaborationGrowthParticipant[];
  readonly channelIds: CollaborationGrowthChannelIds;
  /**
   * Every channel id the room's DIRECTORY holds when it opens.
   *
   * A superset of {@link CollaborationGrowthChannelIds} rather than a second spelling of
   * it: the roster read below deliberately omits the bootstrap channel, which has no
   * channel row at all, while `channel.list` carries it like any other — so the three
   * ids that reply states are what each channel is FOR and these are what the room
   * contains. Supplied by the room from its own channel table on `presenceRowsAt`'s
   * rule, because the directory is the room's fact and this script's business with it is
   * only to know which ids a lifecycle move may name.
   */
  readonly directoryChannelIds: readonly string[];
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
  /**
   * The room's roster read, at one instant on the scenario's frozen clock.
   *
   * A FUNCTION rather than a table, because presence is the one fact in this script
   * that MOVES: the room schedules `presence.*` transitions and the roster read
   * answers the ones due, so a card built from a fixed table would be a second
   * reading of a moving row. Taken from the room rather than reached for over there,
   * on this script's own rule — what it needs is stated in this shape, and the room
   * supplies exactly the read the roster itself answers from.
   */
  readonly presenceRowsAt: (
    settledAtMilliseconds: number,
  ) => readonly PresenceReadResponseParticipant[];
}

/** One person, as the two membership-keyed reads and the presence detail see them. */
export interface CollaborationGrowthParticipant {
  readonly participantId: string;
  /**
   * Required, the opener's included.
   *
   * It was optional while the opener's membership was a thing this file minted, and
   * that optionality was the hole: a room whose owner had no membership beat had no
   * membership id anywhere the log could reach, so the roster read stood in for a fold
   * that could not run. The beat exists now, so the id is the roster's.
   */
  readonly membershipId: string;
  readonly role: string;
}

/** The three channels this script states a policy for. Main deliberately absent. */
export interface CollaborationGrowthChannelIds {
  readonly review: string;
  readonly handoff: string;
  readonly direct: string;
}

/**
 * What creating a channel answers with. One id, because one create is scripted.
 *
 * It is also the one id this room's directory can hold that its opening table does not:
 * the create mints it and the fold in `fixture/collaboration/channel-directory.ts` appends the
 * row, so a lifecycle move naming it is a move against a channel of this room's.
 */
const CHANNEL_CREATED = "019b7904-8ce0-7c11-8140-cca0117a0398";

/** The instant the created channel reports. The scenario's own start, one minute on. */
const CHANNEL_CREATED_AT = "2026-01-01T10:06:00.000Z";

/**
 * The devices behind one person's aggregate, from their roster row at this instant.
 *
 * Built from the ROW rather than from the roster table, so the aggregate a detail card
 * shows can never disagree with the row it opened from — at the instant it opened,
 * which is the half a table could not carry. The fan-out is keyed on that state and so
 * moves with it: an idle member on two devices is the reading the card exists for, and
 * an offline member on NO device is the empty state a card that only ever listed rows
 * would never draw. Both are reached by PLAYING this room's presence beats, and before
 * they play the same person is on the one device their join brought.
 */
function presenceDetailFor(row: PresenceReadResponseParticipant): unknown {
  const devices =
    row.state === "offline"
      ? []
      : row.state === "idle"
        ? [
            { deviceId: `${row.participantId}:desk`, state: row.state, lastSeen: row.lastSeen },
            { deviceId: `${row.participantId}:phone`, state: "offline", lastSeen: row.lastSeen },
          ]
        : [{ deviceId: `${row.participantId}:desk`, state: row.state, lastSeen: row.lastSeen }];
  return { participantId: row.participantId, devices, aggregateState: row.state };
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
  const presenceDetailAt = (settledAtMilliseconds: number): Readonly<Record<string, unknown>> =>
    Object.fromEntries(
      script
        .presenceRowsAt(settledAtMilliseconds)
        .map((row) => [row.participantId, presenceDetailFor(row)]),
    );
  // Built once here rather than per call, which is what keeps the three lifecycle
  // replies computations: they read a set composed from the script and hold no state of
  // their own, so a playback stays replayable tick-for-tick.
  const roomChannelIds = roomChannelIdsOf(script);
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
        membershipId: participant.membershipId,
        role: participant.role,
        state: "active",
      })),
    },
    {
      // COMPUTED FROM THE INSTANT as well as from the request, because this card is
      // the detail behind a row that moves. The table is rebuilt per settled reply
      // rather than held, which is what `scenario.ts` requires of a computed reply:
      // no state, no mutation, and a scenario that stays replayable tick-for-tick.
      // A participant this room does not hold is absent from the read and therefore
      // from the table, so the unscripted refusal arm is reached exactly as before.
      call: "participant.presenceDetail",
      resultFor: (request, settledAtMilliseconds) =>
        answerFor(presenceDetailAt(settledAtMilliseconds), "participantId", request),
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
    // a surface that a lifecycle move is session-wide. They RESOLVE it first — see
    // below for what a receipt for an id this room has never held would teach instead.
    {
      call: "channel.mute",
      resultFor: (request) => lifecycleReceipt(request, "muted", roomChannelIds),
    },
    {
      call: "channel.unmute",
      resultFor: (request) => lifecycleReceipt(request, "active", roomChannelIds),
    },
    {
      call: "channel.archive",
      resultFor: (request) => lifecycleReceipt(request, "archived", roomChannelIds),
    },
  ];
}

/**
 * Every channel this room can be asked to move: the directory it opens with, plus the
 * one its own create mints.
 *
 * ARCHIVED ROWS STAY IN IT, because the directory keeps them — `channel.list` sinks an
 * archived channel into its own region rather than dropping it, so an archived channel
 * is one this room still holds and a move against it is a request the daemon answers
 * (whether it answers with a receipt or with `channel.inactive` is a state rule this
 * room does not script). What is NOT in it is an id no read of this room ever returns,
 * which is the one thing being resolved.
 */
function roomChannelIdsOf(script: CollaborationGrowthScript): ReadonlySet<string> {
  return new Set([...script.directoryChannelIds, CHANNEL_CREATED]);
}

/**
 * What a lifecycle move answers: the channel asked about, in the state it now holds.
 *
 * RESOLVED AGAINST THE ROOM'S OWN DIRECTORY FIRST, and the reason is what the previous
 * reading cost. Any string-valued `channelId` was echoed back as a served receipt, and
 * `fixture/collaboration/channel-lifecycle.ts` appends the matching transition frame for every
 * served act — so a surface muting a channel by a stale identifier, or by one it had
 * composed from the wrong row, was answered exactly as a correct press is and the
 * directory grew a row for a channel this room has never held. The regression class that
 * makes unreachable is the one a fixture exists to make reachable.
 *
 * The refusal is `channel.not_found`, which is what
 * `docs/architecture/contracts/error-contracts.md` registers for a channel that does not
 * exist in the session, thrown through the scenario seam's one refusal constructor so
 * this room refuses in the shape the wire refuses in.
 *
 * A request carrying NO readable `channelId` still answers `undefined` rather than
 * refusing, and the two are different facts: an unresolvable request is a malformed call
 * this scenario scripts no answer for, which is the authoring gap the unscripted arm
 * names, while a resolvable one naming a channel the room does not hold is a daemon
 * refusal a surface has to render.
 */
function lifecycleReceipt(
  request: unknown,
  state: string,
  roomChannelIds: ReadonlySet<string>,
): unknown {
  const channelId = requestedIdentifier(request, "channelId");
  if (channelId === undefined) {
    return undefined;
  }
  if (!roomChannelIds.has(channelId)) {
    refuseAs("channel.not_found", "No channel by that id exists in this session.");
  }
  return { channelId, state };
}
