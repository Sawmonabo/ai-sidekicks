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
// beat admitted rather than a second hand-written copy of it. For presence that
// derivation is TIME-DEPENDENT — see the reply below — because the roster's whole
// contract is that the read is the truth: a read that answers the same rows before
// and after a `presence.*` push says the push carried no news.
//
// AND THE INVITE LEDGER IS A TABLE, NOT A RULE. This room exists in part to show an
// invitation ageing out, and the ageing itself is NOT here: `pending → expired` on the
// clock is the daemon's lifecycle rather than this room's, so it lives on the fixture's
// own invite ledger (`fixture/fixture-invite-ledger.ts`) and reaches every row that
// read returns. Written here it was a rule one table applied to itself — the rows an
// ACT mints are ones this scenario cannot see, so a minted invitation could never have
// aged at all. What stays is the two rows and the instants they carry, which is data.
// No second timeline is introduced and no invite beat is invented: `collaboration.ts`
// records why this scenario has an invite reply and no invite beat, and that reasoning
// is unchanged.

import {
  CHANNEL_DIRECT,
  CHANNEL_HANDOFF,
  CHANNEL_REVIEW,
  COLLABORATION_CHANNELS,
  COLLABORATION_PARTICIPANTS,
  INVITE_ACCEPTED,
  INVITE_EXPIRING,
  PARTICIPANT_PRIYA,
  PARTICIPANT_TOMAS,
  PARTICIPANT_YOU,
  collaborationMintedInviteId,
  collaborationMintedInviteToken,
} from "./identifiers.js";
import { collaborationGrowthReplies } from "./growth-replies.js";
import { collaborationPresenceRowsAt } from "./presence-timeline.js";
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
 *
 * EXPORTED so the scenario's own test can read what this room opens with. It is the
 * OPENING state and not the answer: what `invites.list` serves is this table plus
 * whatever this window minted, with each row aged and moved by the acts it has taken.
 */
export const COLLABORATION_SENT_INVITES: readonly GrowthInviteSummary[] = [
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

/** Every call this room answers, and what it answers with. */
export const COLLABORATION_REPLIES: ConsoleScenario["replies"] = [
  {
    // The registered `PresenceReadResponse`: `{participants: [{participantId,
    // state, lastSeen}]}` and nothing beside it — the schema is `.strict()`, so a
    // role or a display name here would be rejected outright. Role lives on the
    // membership projection and the roster reads it from there.
    //
    // COMPUTED FROM THE INSTANT, which is what makes this room's presence beats mean
    // anything. A fixed table here answered every read with each joiner's EVENTUAL
    // state and final stamp, so at tick zero the console was already showing rows the
    // script does not reach until 380ms — and the roster, whose whole discipline is to
    // answer each `presence.*` push with a fresh read, received the identical rows on
    // every one of them. The transition and the refresh were both unreachable at once.
    // `presence-timeline.ts` declares the moves the beats are emitted from, and this
    // answers with the ones DUE at the tick the reply settles at, off the engine's own
    // frozen clock.
    call: "presence.read",
    resultFor: (_request, settledAtMilliseconds) => ({
      participants: collaborationPresenceRowsAt(settledAtMilliseconds),
    }),
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
    // DATA, and the whole of what this room states about its own ledger. What varies —
    // when the read is asked, and what this window has minted or revoked since — is the
    // fixture ledger's, which folds both over these rows on the way out. A `resultFor`
    // here would be this table applying a lifecycle rule to itself, which is where the
    // rule used to live and why a minted row could never age.
    call: "invites.list",
    result: COLLABORATION_SENT_INVITES,
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
    // ONE RECEIPT PER MINT, off the ordinal the reply seam hands in. A person who
    // dismisses the first reveal and sends a second invitation used to get the first
    // one's identity back: the ledger appends a row per served mint, so two rows
    // arrived under one key, the list drew them with duplicate keys, and a revoke on
    // that key — recorded in a map keyed by id — moved both at once. The identity is
    // the mint's, and `identifiers.ts` is where the sequence is spelled.
    //
    // THE REFUSAL ARMS ARE NOT REACHABLE FROM HERE, and that is the reply table's
    // shape rather than a gap: it answers one call one way, so a scenario cannot
    // both mint an invitation and refuse the next mint. The pending-cap sentence
    // and the sliding-window refusal are driven by the create form's own cases,
    // against the codes `Spec-021` registers.
    call: "invite.create",
    afterMs: 250,
    resultFor: (request, _settledAtMilliseconds, mintOrdinal) => {
      const asked = request as { readonly expiresAt?: unknown };
      return {
        inviteId: collaborationMintedInviteId(mintOrdinal),
        token: collaborationMintedInviteToken(mintOrdinal),
        expiresAt:
          typeof asked.expiresAt === "string" ? asked.expiresAt : "2026-01-08T10:05:00.000Z",
      };
    },
  },
  {
    // The revoke. COMPUTED for the mint's second reason and not its first: there is no
    // entity the control plane mints here, so both members of `InviteRevokeResponse`
    // are about the row the caller named — the id it asked about, echoed, and the state
    // that row is now in. A fixed reply would answer every revoke about one invitation,
    // so pressing Revoke on the accepted row would have moved the pending one.
    //
    // ALWAYS `revoked`, which is this room's statement rather than the wire's only
    // answer: a revoke put on an invitation already accepted answers with the state it
    // is actually in, and a scenario that wanted to show that would script it. What the
    // ledger records is the state on THIS receipt, so the two stay one fact.
    call: "invite.revoke",
    resultFor: (request) => {
      const asked = request as { readonly inviteId?: unknown };
      return {
        inviteId: typeof asked.inviteId === "string" ? asked.inviteId : INVITE_EXPIRING,
        state: "revoked",
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
    // What the directory above OPENS with, derived from the same table that composes it
    // rather than listed a second time — so a channel added to this room is one a
    // lifecycle move can name, in one edit and without a second table agreeing to it.
    // The bootstrap row is in here and deliberately absent from the roster read beside
    // it: it is a channel this session holds and not a channel with a configuration.
    directoryChannelIds: COLLABORATION_CHANNELS.map((channel) => channel.channelId),
    directChannelPair: [PARTICIPANT_YOU, PARTICIPANT_PRIYA],
    // Somebody else holds the shell. The viewer holding it would draw the one
    // arm every surface renders the same way it renders no holder at all.
    terminalControlHolder: PARTICIPANT_TOMAS,
    // The same read `presence.read` above answers with, so the detail card behind a
    // roster row and the row itself are one reading of one instant rather than two.
    presenceRowsAt: collaborationPresenceRowsAt,
  }),
];
