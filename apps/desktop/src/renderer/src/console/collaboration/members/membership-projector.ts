// The `participant` partition's membership fold: who was admitted, as what, and
// under what name.
//
// WHY THIS FAMILY OWNS IT
//
// `membership.created` is the one `membership.*` kind `packages/contracts` registers
// a `SessionEventSchema` payload variant for, and it carries exactly the three facts
// three of this family's surfaces were reading off nothing:
//
//   • `identityHandle` is the only NAME the wire ever states for a participant.
//     `sessionProjectionLabels` resolves a roster label through `body.name`, so with
//     no fold for it every row in the roster, every typing indicator, and every
//     direct-channel label rendered a raw participant id.
//   • `membershipId` is the identifier `membership.update` is keyed by. The ledger's
//     four controls need one and no registered READ returns one, so before this fold
//     the only rows that could carry one were the ones this window created itself.
//   • `role` is what the roster row and the ledger row both print.
//
// A view family owning a projector is the shape `console/families.ts` describes:
// the projector board is a parameter of the composition precisely so a family can
// fold the event category whose partition it reads, rather than reading the wire a
// second time beside a store that already has the event.
//
// WHAT `membership.created` DELIBERATELY DOES NOT WRITE
//
// `state`. `deriveMembershipRows` reads a participant entity's `state` as the
// MEMBERSHIP state, and `membership.created` states none — a created membership is
// not necessarily an active one, `MembershipState` has four values, and writing one
// here would be the console deciding a fact the daemon sends.
//
// AND WHY THE OTHER FOUR KINDS ARE FOLDED ALL THE SAME
//
// They were not, and the cost was a membership that had ENDED still reading as one
// that had not: a revoked participant stayed in the projection at whatever the last
// read said, so the direct-channel picker went on offering them and every create
// against them could only be refused. The four are registered in the taxonomy with no
// `SessionEventSchema` payload variant, which is what the earlier reading took as
// "nothing to read" — but the console's own event shape is the tolerant carrier's
// (`bridge/daemon/session-event-payload.ts` parses `EventEnvelopeSchema`, deliberately,
// so a type whose payload variant this console does not know still arrives whole), and
// `Spec-006 §Invite and Membership (membership_change)` states the group's payload
// shape: `{sessionId, participantId, inviteId?, previousRole?, newRole?, actor, reason?}`.
//
// So there are two facts to fold and neither is a guess. The ROLE comes off the
// payload's own `newRole`. The STATE comes off the event's KIND — a suspension states
// `suspended`, a revocation `revoked`, a reactivation `active` — which is the wire's
// own statement of the transition rather than an inference about one, and the three
// values are `MembershipState`'s and are typed as such below so a fifth cannot be
// invented here. What stays true is the sentence above it: no fold writes a state the
// wire did not state, and `membership.created` still writes none.
//
// AND IT WRITES NO SESSION CHECK. The run-lifecycle fold holds its payload to the
// envelope's session because its payloads carry a `sessionId` that could name
// another; this payload carries none — the envelope is the only statement of which
// session admitted this membership, and the store it is folded into is that session's.
//
// PURE AND TOTAL, like every projector: it reads the event and nothing else, and a
// payload it cannot key on yields no mutation rather than a throw. The event still
// lands in the timeline, which is the ledger that records it arrived.

import type { MembershipState } from "@ai-sidekicks/contracts";

import { readWireString } from "../../core/index.js";
import type {
  ConsoleEntityProjectorRegistry,
  ConsoleSessionEvent,
  EntityMutation,
  EntityProjector,
  EntityProjectorRegistry,
} from "../../store/index.js";

/** The one membership kind that carries a payload the contract declares. */
export const MEMBERSHIP_CREATED_EVENT_KIND = "membership.created";

/** The kind whose payload states a role and no state. */
export const MEMBERSHIP_ROLE_CHANGED_EVENT_KIND = "membership.role_changed";

/**
 * The membership state each remaining lifecycle kind states, by the kind's own name.
 *
 * TYPED TO THE WIRE'S UNION so the three values are the contract's rather than this
 * module's: `MembershipState` is `pending | active | suspended | revoked`, and a
 * fourth entry naming anything else does not compile. `reactivated` resolves to
 * `active` because that is what restoring a suspended membership leaves — `pending`
 * is the pre-acceptance state and the other two are what it is being restored FROM.
 */
const STATE_BY_LIFECYCLE_KIND: Readonly<Record<string, MembershipState>> = {
  "membership.suspended": "suspended",
  "membership.revoked": "revoked",
  "membership.reactivated": "active",
};

/** The name this family claims its event kinds under, so a conflict names it. */
const COLLABORATION_PROJECTOR_OWNER = "collaboration";

/**
 * Fold one admission into the participant it names.
 *
 * The three members are written only where the payload states them, because the
 * store's merge treats a present `undefined` as an erasure: an admission that
 * carried no handle would otherwise delete the name a later beat established.
 */
export const projectMembershipCreated: EntityProjector = (
  event: ConsoleSessionEvent,
): readonly EntityMutation[] => {
  const payload = event.payload;
  const participantId = readWireString(payload?.["participantId"]);
  if (participantId === undefined) {
    return [];
  }
  const identityHandle = readWireString(payload?.["identityHandle"]);
  const membershipId = readWireString(payload?.["membershipId"]);
  const role = readWireString(payload?.["role"]);
  const body = {
    ...(identityHandle === undefined ? {} : { name: identityHandle }),
    ...(membershipId === undefined ? {} : { membershipId }),
    ...(role === undefined ? {} : { role }),
  };
  return [
    {
      operation: "upsert",
      entity: {
        kind: "participant",
        id: participantId,
        touchedAt: event.occurredAt,
        // An admission with nothing readable on it still marks the participant as
        // present in this session's log — the entity is the record that they were
        // admitted, and an empty body would erase nothing because the merge is a
        // spread. It is omitted rather than written empty so the entity carries no
        // body it never had.
        ...(Object.keys(body).length === 0 ? {} : { body }),
      },
    },
  ];
};

/**
 * Fold one role change onto the participant it names.
 *
 * The ROLE ONLY, and never a state: `membership.role_changed` says a role moved and
 * says nothing about whether the membership is active, so an upsert that also carried
 * a state would reactivate a suspended row on the strength of an unrelated fact. A
 * change that states no readable role still upserts, for the same reason an admission
 * with nothing readable on it does — the entity is the record that the event reached
 * this participant, and the merge one level up leaves every member it does not name.
 */
export const projectMembershipRoleChanged: EntityProjector = (
  event: ConsoleSessionEvent,
): readonly EntityMutation[] => {
  const participantId = readWireString(event.payload?.["participantId"]);
  if (participantId === undefined) {
    return [];
  }
  const newRole = readWireString(event.payload?.["newRole"]);
  return [
    {
      operation: "upsert",
      entity: {
        kind: "participant",
        id: participantId,
        touchedAt: event.occurredAt,
        ...(newRole === undefined ? {} : { body: { role: newRole } }),
      },
    },
  ];
};

/**
 * Fold one suspension, revocation, or reactivation onto the participant it names.
 *
 * ONE PROJECTOR OVER THREE KINDS rather than three that differ by a literal, because
 * the only thing that differs between them IS the literal and it is read off the
 * event's own `kind` through {@link STATE_BY_LIFECYCLE_KIND}. Registering three
 * closures over one table would put the same table's contents in four places.
 *
 * Total over every event it can be handed: a kind the table does not name yields no
 * mutation rather than an entity with an undefined state, which is what keeps this
 * safe to register under exactly the three keys below and nowhere else.
 */
export const projectMembershipLifecycle: EntityProjector = (
  event: ConsoleSessionEvent,
): readonly EntityMutation[] => {
  const participantId = readWireString(event.payload?.["participantId"]);
  const state = STATE_BY_LIFECYCLE_KIND[event.kind];
  if (participantId === undefined || state === undefined) {
    return [];
  }
  return [
    {
      operation: "upsert",
      // `state` and `touchedAt` only. The body is deliberately absent rather than
      // empty: a transition states nothing about the handle, the identifier, or the
      // role, and the store's merge keeps every member an upsert does not name.
      entity: { kind: "participant", id: participantId, state, touchedAt: event.occurredAt },
    },
  ];
};

/**
 * The family's fold table: the five `membership.*` kinds, three of them sharing one
 * projector.
 *
 * Built from {@link STATE_BY_LIFECYCLE_KIND}'s own keys rather than restating them, so
 * the kinds this family claims and the states those kinds mean cannot fall out of step
 * — a fourth entry in that table is registered here by adding it there and nowhere
 * else.
 */
export const COLLABORATION_PROJECTORS: EntityProjectorRegistry = {
  [MEMBERSHIP_CREATED_EVENT_KIND]: projectMembershipCreated,
  [MEMBERSHIP_ROLE_CHANGED_EVENT_KIND]: projectMembershipRoleChanged,
  ...Object.fromEntries(
    Object.keys(STATE_BY_LIFECYCLE_KIND).map((kind) => [kind, projectMembershipLifecycle]),
  ),
};

/** What this family claims on the projector board, handed the board it writes into. */
export function registerCollaborationProjectors(registry: ConsoleEntityProjectorRegistry): void {
  registry.registerAll(COLLABORATION_PROJECTORS, COLLABORATION_PROJECTOR_OWNER);
}
