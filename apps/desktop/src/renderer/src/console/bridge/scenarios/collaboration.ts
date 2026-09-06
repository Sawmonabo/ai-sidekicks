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
//
// AND THE SCENARIO'S OWN PARTS ARE FIVE SIBLING FILES. What a reader meets here is
// the room's composition — who is in it, what it answers with, what it plays — and
// each of those is a table long enough to bury the others when they share a file.
// The dot-named siblings (`collaboration.identifiers.ts`, `.beats.ts`, `.replies.ts`,
// `.activity.ts`, `.pending-invites.ts`) are THIS scenario's own parts, on the split
// `composer.ts` already makes; the hyphen-named ones
// (`collaboration-runtime-nodes.ts`, `collaboration-growth-replies.ts`) are the
// second scripts described above, which play other wires and are not more of this
// one. The identifiers module is what keeps the parts naming the same room.

import { COLLABORATION_ACTIVITY } from "./collaboration.activity.js";
import { COLLABORATION_BEATS } from "./collaboration.beats.js";
import {
  COLLABORATION_PARTICIPANTS,
  PARTICIPANT_YOU,
  RUNTIME_NODE_SCRIPT,
  SESSION_ID,
} from "./collaboration.identifiers.js";
import { COLLABORATION_PENDING_INVITES } from "./collaboration.pending-invites.js";
import { COLLABORATION_REPLIES } from "./collaboration.replies.js";
import { collaborationRuntimeNodeRoster } from "./collaboration-runtime-nodes.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

export const COLLABORATION_SCENARIO_ID = "collaboration";

export const COLLABORATION_SCENARIO: ConsoleScenario = {
  id: COLLABORATION_SCENARIO_ID,
  label: "A room with people in it",
  purpose:
    "Four participants across all four presence states, four channels including an archived one and a direct pair, and one invitation about to expire — the roster, the channel list, the members section, and the sent-invite ledger are built against this one.",
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
  activity: COLLABORATION_ACTIVITY,
  beats: COLLABORATION_BEATS,
  replies: COLLABORATION_REPLIES,
  pendingInvites: COLLABORATION_PENDING_INVITES,
  // The node this scenario stands for answers its control plane here, so a minted
  // invitation reveals the link a person would actually send rather than an
  // identifier that opens nothing. A bare host: the link's own form is
  // `Spec-002 §Invite Delivery`'s and the console composes it in one place.
  controlPlaneHost: "sidekicks.example",
};
