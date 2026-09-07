// What the collaboration scenario ANSWERS, as opposed to what it plays.
//
// `composer.replies.ts`'s split, applied here: a reply is looked up by method and
// answered once, while a beat is routed to a subscription by kind and arrives on the
// frozen clock. This room's reply table carries a scripted latency on the mint and a
// computed answer for it, both of which are properties of a call and meaningless for
// a frame.
//
// The presence and channel rows are DERIVED from the same two cast tables the beats
// are, so what a read answers about a person is the row that person's membership
// beat admitted rather than a second hand-written copy of it.
//
// AND THE INVITE LEDGER IS DERIVED FROM THE CLOCK. This room exists in part to show
// an invitation ageing out, and a fixed reply cannot show it: every `invites.list`
// call answered `pending` for the life of the window, so re-reading past the declared
// expiry — remounting the section, minting a second invitation, opening the room an
// hour in — kept the row pending and kept Revoke on it, which is the fixture asserting
// a session state that had stopped being true. The rows are therefore aged against the
// instant the reply settles at, off the engine's own frozen clock, which is the same
// timeline the beats are due on. No second timeline is introduced and no invite beat
// is invented: `collaboration.ts` records why this scenario has an invite reply and no
// invite beat, and that reasoning is unchanged.

import {
  CHANNEL_DIRECT,
  CHANNEL_HANDOFF,
  CHANNEL_REVIEW,
  COLLABORATION_CHANNELS,
  COLLABORATION_PARTICIPANTS,
  INVITE_ACCEPTED,
  INVITE_EXPIRING,
  INVITE_MINTED,
  PARTICIPANT_PRIYA,
  PARTICIPANT_TOMAS,
  PARTICIPANT_YOU,
} from "./identifiers.js";
import { collaborationGrowthReplies } from "./growth-replies.js";
import { parseInstant } from "../../../core/index.js";
import type { GrowthInviteSummary } from "../../growth-values/index.js";
import type { ConsoleScenario } from "../../scenario-runtime/index.js";

/**
 * The invitations this room has sent, as the ledger read answers them at tick zero.
 *
 * Served through the fixture growth port's `invitesList`, in the `GrowthInviteSummary`
 * shape the console declares: `{inviteId, state, expiresAt, joinMode}`. The two rows
 * grant DIFFERENT roles, because the ledger prints the role each invitation grants and
 * a table where every row said the same word would not show that it prints it at all.
 *
 * No plaintext token and no join link, because the read carries neither: the token
 * exists exactly once, in the reply to the act that minted it, and a ledger row that
 * carried one would be a credential recoverable by re-reading.
 *
 * The pending row expires forty seconds after the scenario starts, so a console driven
 * past that tick sees an invitation age out rather than one frozen permanently on the
 * brink. The accepted row's own expiry is already BEHIND tick zero, which is the
 * ageing rule's built-in foil: a settled invitation stays settled past its expiry, and
 * a table where both rows aged would be showing a lifecycle the wire does not have.
 */
const COLLABORATION_SENT_INVITES: readonly GrowthInviteSummary[] = [
  {
    inviteId: INVITE_EXPIRING,
    state: "pending",
    expiresAt: "2026-01-01T10:05:40.000Z",
    joinMode: "collaborator",
  },
  {
    inviteId: INVITE_ACCEPTED,
    state: "accepted",
    expiresAt: "2026-01-01T10:04:00.000Z",
    joinMode: "viewer",
  },
];

/**
 * The ledger as it stands at one instant on the scenario's own clock.
 *
 * ONLY A PENDING ROW AGES, because only a pending invitation has a lifetime left to
 * run: `InviteState` moves `pending → expired` and every other state is terminal, so
 * ageing an accepted or revoked row would invent a transition the daemon never makes.
 *
 * AT the declared instant rather than after it. `expiresAt` is when the invitation
 * stops being usable, so a row read at exactly its own expiry is already past the
 * point where a person could redeem it, and answering `pending` there would offer
 * Revoke on an invitation nothing could accept.
 *
 * A row whose expiry is not a readable instant is answered EXACTLY as declared, rather
 * than aged on a stamp nothing could read — an unreadable expiry is an authoring
 * mistake in this table, and `collaboration.test.ts` is what fails on one; guessing a
 * lifecycle from it here would hide that failure behind a plausible row.
 */
export function collaborationSentInvitesAt(
  settledAtMilliseconds: number,
): readonly GrowthInviteSummary[] {
  return COLLABORATION_SENT_INVITES.map((invite) => {
    const expiry = parseInstant(invite.expiresAt).epochMilliseconds;
    return invite.state === "pending" && expiry !== undefined && settledAtMilliseconds >= expiry
      ? { ...invite, state: "expired" }
      : invite;
  });
}

/** Every call this room answers, and what it answers with. */
export const COLLABORATION_REPLIES: ConsoleScenario["replies"] = [
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
    // COMPUTED, and computed off the clock rather than off the request: this read is
    // session-scoped, so there is no entity to answer per — what varies is WHEN it is
    // asked. The rows and the ageing rule are the table above; this line is only the
    // seam that hands the settling instant to it.
    call: "invites.list",
    resultFor: (_request, settledAtMilliseconds) =>
      collaborationSentInvitesAt(settledAtMilliseconds),
  },
  {
    // The mint. A COMPUTED reply rather than a fixed one, because two of the three
    // members it answers with are the caller's own: the expiry is whichever the
    // person picked in the form, and echoing back a different one would show a
    // reveal that contradicts the request that produced it. The invite id is the
    // scenario's, because the control plane mints that and the caller does not.
    //
    // The registered `InviteCreateResponse` is `{inviteId, token, expiresAt}` and
    // the call door parses this against it, so the token below is a base64url-ish
    // blob rather than a sentence: a fixture that scripted a readable string here
    // would be teaching the reveal a shape the wire cannot send.
    //
    // THE REFUSAL ARMS ARE NOT REACHABLE FROM HERE, and that is the reply table's
    // shape rather than a gap: it answers one call one way, so a scenario cannot
    // both mint an invitation and refuse the next mint. The pending-cap sentence
    // and the sliding-window refusal are driven by the create form's own cases,
    // against the codes `Spec-021` registers.
    call: "invite.create",
    afterMs: 250,
    resultFor: (request) => {
      const asked = request as { readonly expiresAt?: unknown };
      return {
        inviteId: INVITE_MINTED,
        token: "v4.local.V0hBVEVWRVIgVEhFIENPTlRST0wgUExBTkUgTUlOVEVE",
        expiresAt:
          typeof asked.expiresAt === "string" ? asked.expiresAt : "2026-01-08T10:05:00.000Z",
      };
    },
  },
  // No agent has been attached, and the empty list is the honest reading rather
  // than an absent reply: the read succeeded and this room has no agents in it.
  { call: "agent.list", result: { agents: [] } },
  // Everything the growth port serves for this room, from the sibling that owns it:
  // the channel roster, the membership roster, one participant's device fan-out, and
  // the four channel-lifecycle writes.
  ...collaborationGrowthReplies({
    participants: COLLABORATION_PARTICIPANTS,
    channelIds: {
      review: CHANNEL_REVIEW,
      handoff: CHANNEL_HANDOFF,
      direct: CHANNEL_DIRECT,
    },
    directChannelPair: [PARTICIPANT_YOU, PARTICIPANT_PRIYA],
    // Somebody else holds the shell. The viewer holding it would draw the one
    // arm every surface renders the same way it renders no holder at all.
    terminalControlHolder: PARTICIPANT_TOMAS,
  }),
];
