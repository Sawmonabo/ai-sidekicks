// The membership plane's values: the identifier a membership control is keyed by,
// and the per-device detail behind one participant's presence.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys; this file is the domain's own text.
//
// WHY A MEMBERSHIP ROSTER ENTRY IS A VALUE AT ALL. `membership.update` names a
// `membershipId`, and every registered shape that carries one answers a JOIN or a
// WRITE — the session create, the invite accept, the update's own request and reply.
// A window that neither created nor joined the session in this process therefore
// holds an identifier for no membership but its own, and the four controls collapse
// to an absence on every other row. This is the shape of the read that fixes it.

/**
 * One membership as the roster read carries it.
 *
 * The role and the state ride along because the read that supplies the identifier is
 * the read that knows them, and a surface asking two reads for one row would have to
 * decide what to draw while they disagreed. Both are optional for the honest reason:
 * a producer that has an identifier and no role is telling the truth about what it
 * holds, and the console renders the absence rather than defaulting into a role.
 */
export interface GrowthMembershipRosterEntry {
  readonly participantId: string;
  readonly membershipId: string;
  readonly role?: string;
  readonly state?: string;
}

/**
 * One device behind a participant's aggregated presence.
 *
 * `deviceId` is wire-verbatim and is rendered as such: it is an opaque identifier the
 * console has no vocabulary for, and a friendly name here would be invented.
 */
export interface GrowthPresenceDeviceReading {
  readonly deviceId: string;
  readonly state: string;
  readonly lastSeen: string;
}

/**
 * One participant's per-device fan-out, with the summary it aggregates to.
 *
 * `aggregateState` is carried even though the roster already holds a state for this
 * participant, because the two are answers from different reads and a detail card
 * that showed only the devices would leave a reader to do the aggregation the wire
 * has already done. Where they disagree the summary is the one the roster row keeps —
 * this reading is the detail behind it, never a second source of truth for it.
 */
export interface GrowthPresenceDetail {
  readonly participantId: string;
  readonly devices: readonly GrowthPresenceDeviceReading[];
  readonly aggregateState: string;
}
