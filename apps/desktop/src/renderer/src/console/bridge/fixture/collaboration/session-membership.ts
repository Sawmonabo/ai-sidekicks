// Who holds a membership in this session, at the instant the question is asked.
//
// THE FACT ONE READING SHORT OF THE TRUTH. `session-snapshot.ts` derives what a
// session already CONTAINS when a store opens on it, and that is the base state: the
// roster the scenario declares, entity for entity, at cursor zero. It is also the whole
// of what the channel plane used to count, and a base state is not an answer to "how
// many people are in this session NOW" — it is the answer to "how many were in it when
// the window opened". A playback that has since delivered a `membership.revoked` frame
// has told every reader of that session that somebody left, and a channel created after
// that frame was still reporting them as one of its members.
//
// SO THE COUNT IS A FOLD, on `channel-directory.ts`'s own rule for the plane
// beside it: the scripted reply is the state the session OPENS in and the log is what
// has happened to it since, and the answer is the second applied to the first. Never the
// first alone, which reports a roster the session has moved past, and never the log
// alone, which knows nothing about the people a scenario declares and plays no beat for.
//
// AND IT IS THE MEMBERSHIP PROJECTION'S FOLD, not a second one. `collaboration/members/`
// registers the projectors that move the store's participant partition on these same five
// kinds, and this stands where that projection cannot be reached from — the bridge sits
// below every view family on the console's DAG, so the fixture cannot import it and must
// not restate it either. What is shared is the part that can be: the payload-against-
// envelope session rules live in `core/wire-session-attribution.ts` and both readings
// consume them, under the same two arms for the same contract reasons.
//
// WHAT IS FOLDED IS PRESENCE AND NEVER STATE. The projection writes a `MembershipState`
// because a row RENDERS one — a suspended member is visibly still a row. This counts
// people, so the only transition that moves the count is the one that ends a membership:
// a suspension leaves a person in the session, a reactivation restores one a revocation
// removed, and a role change says nothing about either. Restating the four-value state
// vocabulary here to derive that would be the second declaration of a closed set the
// wire already owns.

import type { SessionEventType } from "@ai-sidekicks/contracts";

import { fixtureSessionSnapshot } from "./session-snapshot.js";
import {
  payloadContradictsSession,
  payloadNamesSession,
  readWireString,
} from "../../../core/index.js";
import type { ScenarioEngine } from "../../scenario/runtime/index.js";

/** One `membership.*` frame the census registers. Derived, so the set has one home. */
type MembershipLifecycleKind = Extract<SessionEventType, `membership.${string}`>;

/** What one delivered `membership.*` frame leaves the participant it names holding. */
type MembershipStanding = "holds" | "ended" | "unchanged";

/**
 * Where each membership frame leaves the person it names.
 *
 * TOTAL OVER THE CENSUS'S OWN `membership.` ROOT, `satisfies`-checked against it, so a
 * sixth kind the corpus registers later fails this file rather than being folded as
 * nothing. `unchanged` is a value rather than an omission for that reason: a role change
 * is a statement about a membership that already exists, and leaving it out of the table
 * would make "the kind says nothing" indistinguishable from "nobody wrote the row".
 */
const MEMBERSHIP_STANDING_BY_KIND: Readonly<Record<MembershipLifecycleKind, MembershipStanding>> =
  Object.freeze({
    "membership.created": "holds",
    "membership.role_changed": "unchanged",
    "membership.suspended": "holds",
    "membership.revoked": "ended",
    "membership.reactivated": "holds",
  } satisfies Record<MembershipLifecycleKind, MembershipStanding>);

/**
 * How many PEOPLE hold a membership in one session, as this playback has been told.
 *
 * The opening roster from the session read, moved by every `membership.*` frame
 * delivered so far. Counted off the snapshot's participant ENTITIES rather than off the
 * join log, and the difference is the agents: the join order holds everything that gets
 * a hue, and an agent is attached rather than admitted, so it appears there and holds no
 * membership. A channel's `participantCount` counts people.
 *
 * ONE READER for the whole fixture's channel plane — the act that records how many
 * people a create put in a channel, and the directory fold that answers for a creation
 * no act of this fixture performed — because two counts of one roster are free to
 * disagree about who is in it and when they left.
 */
export function fixtureSessionMembershipCount(engine: ScenarioEngine, sessionId: string): number {
  return fixtureSessionMembershipIds(engine, sessionId).size;
}

/**
 * The people holding a membership in one session, in the order the session met them.
 *
 * A set rather than a count so the fold states WHO before it states how many: the same
 * id is reachable from the declared roster and from its own `membership.created` frame —
 * every shipped scenario plays one for each of its people — and a running total would
 * count such a person twice.
 *
 * Scoped per FRAME to the session asked about, off the envelope's own attribution. A
 * scenario plays one session, so the guard is what keeps a read addressed elsewhere from
 * collecting this room's admissions into a roster for a session that has none — the same
 * scoping `fixtureSessionSnapshot` applies to the opening term.
 */
function fixtureSessionMembershipIds(
  engine: ScenarioEngine,
  sessionId: string,
): ReadonlySet<string> {
  const participantIds = new Set<string>();
  for (const entity of fixtureSessionSnapshot(engine.scenario, sessionId).entities) {
    if (entity.kind === "participant") {
      participantIds.add(entity.id);
    }
  }
  for (const event of engine.deliveredEvents()) {
    if (event.sessionId !== sessionId) {
      continue;
    }
    const standing = membershipStandingOf(event.kind);
    const participantId = readWireString(event.payload?.["participantId"]);
    if (standing === undefined || standing === "unchanged" || participantId === undefined) {
      continue;
    }
    if (!statesThisSession(event.kind, event.payload, sessionId)) {
      continue;
    }
    if (standing === "holds") {
      participantIds.add(participantId);
    } else {
      participantIds.delete(participantId);
    }
  }
  return participantIds;
}

/**
 * Whether one membership frame's PAYLOAD may be read as this session's.
 *
 * TWO ARMS, AND THE ASYMMETRY IS THE CONTRACT'S rather than this module's — the same
 * split `collaboration/members/membership-projector.ts` takes, for the same reasons.
 * `Spec-006 §Invite and Membership (membership_change)` fixes the four transitions'
 * payload at `{sessionId, participantId, …}`, so `sessionId` is a member every one of
 * them carries and a frame that omits it is malformed rather than terse.
 * `membership.created` is the one kind `packages/contracts` registers a
 * `SessionEventSchema` variant for, and that variant is `.strict()` over
 * `{membershipId, participantId, role, identityHandle}` with no `sessionId` in it at
 * all — so requiring one would refuse every real admission and empty the roster, and
 * only a PRESENT member naming somewhere else is refused.
 */
function statesThisSession(
  eventKind: string,
  payload: Readonly<Record<string, unknown>> | undefined,
  sessionId: string,
): boolean {
  return eventKind === MEMBERSHIP_CREATED_EVENT_KIND
    ? !payloadContradictsSession(payload, sessionId)
    : payloadNamesSession(payload, sessionId);
}

/** The one membership kind whose payload the contract declares, and omits a session from. */
const MEMBERSHIP_CREATED_EVENT_KIND: MembershipLifecycleKind = "membership.created";

/** Where this kind leaves a membership, or `undefined` for a kind that is not one. */
function membershipStandingOf(eventKind: string): MembershipStanding | undefined {
  return Object.hasOwn(MEMBERSHIP_STANDING_BY_KIND, eventKind)
    ? MEMBERSHIP_STANDING_BY_KIND[eventKind as MembershipLifecycleKind]
    : undefined;
}
