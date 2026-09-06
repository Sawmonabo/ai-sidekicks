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
// WHAT IT DELIBERATELY DOES NOT WRITE
//
// `state`. `deriveMembershipRows` reads a participant entity's `state` as the
// MEMBERSHIP state, and `membership.created` states none — a created membership is
// not necessarily an active one, `MembershipState` has four values, and writing one
// here would be the console deciding a fact the daemon sends. The four other
// `membership.*` kinds (`role_changed`, `suspended`, `revoked`, `reactivated`) are
// registered in the taxonomy with NO payload variant at all, so there is nothing to
// read a state off even where the kind's own name announces one; claiming those
// kinds here would be claiming a fold that could only guess. The membership roster
// read is where a state comes from, and where it disagrees with nothing.
//
// AND IT WRITES NO SESSION CHECK. The run-lifecycle fold holds its payload to the
// envelope's session because its payloads carry a `sessionId` that could name
// another; this payload carries none — the envelope is the only statement of which
// session admitted this membership, and the store it is folded into is that session's.
//
// PURE AND TOTAL, like every projector: it reads the event and nothing else, and a
// payload it cannot key on yields no mutation rather than a throw. The event still
// lands in the timeline, which is the ledger that records it arrived.

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

/** The family's fold table: one kind, one projector. */
export const COLLABORATION_PROJECTORS: EntityProjectorRegistry = {
  [MEMBERSHIP_CREATED_EVENT_KIND]: projectMembershipCreated,
};

/** What this family claims on the projector board, handed the board it writes into. */
export function registerCollaborationProjectors(registry: ConsoleEntityProjectorRegistry): void {
  registry.registerAll(COLLABORATION_PROJECTORS, COLLABORATION_PROJECTOR_OWNER);
}
