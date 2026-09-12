// The presence plane's values: what the Awareness activity field carries.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys; this file is the domain's own text.
//
// ONE FIELD, AND IT IS RUN-KEYED. An agent's activity travels on the `activity.runs`
// map, edge-triggered by the owning daemon rather than timed by a receiver, and the
// snapshot below carries that one list. `channels/activity-model.ts` holds the
// clear rule the edge implies.
//
// NOTHING HERE CARRIES CONTENT. The wire forbids it, so there is no member for it to
// arrive in — not a preview, not a length. What travels is which run, where, and
// since when.
//
// `since` IS WIRE-SUPPLIED AND DISPLAY-ONLY. Awareness is skew-free
// because each receiver stamps observation time from its own clock, so a consumer
// that subtracted this from its own `now` would expire an indicator by the skew
// between two machines. The registry's own header states the same rule from the
// consuming side.

/** One live run's activity, as one entry of the `activity.runs` map carries it. */
export interface GrowthAgentActivityReading {
  readonly runId: string;
  readonly channelId: string;
  /** Wire-supplied, display-only. Never an input to an expiry decision. */
  readonly since: string;
}

/**
 * The session's live activity, as one reading.
 *
 * A SNAPSHOT AND NOT A DELTA FEED, which is the same discipline the runtime-node
 * roster read keeps: Awareness state is a map each publisher owns outright, so the honest thing
 * to hand a consumer is what that map says now. The console diffs it into its own
 * registry (`channels/activity-feed.ts`), which is where the clear rule lives —
 * and a wire that emitted edges instead would make every consumer responsible for
 * reconstructing the map from a stream it might have joined late.
 *
 * The list is REQUIRED and empty rather than optional. "No run is working" is a real
 * state of a session and an absent member is not: an optional list would let a
 * publisher that had never populated the field and one that had just seen the last
 * run finish read identically.
 */
export interface GrowthActivitySnapshot {
  readonly agentRuns: readonly GrowthAgentActivityReading[];
}

/**
 * One device behind a user's aggregated presence.
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
 * The per-device fan-out, with the summary it aggregates to.
 *
 * `aggregateState` is carried even though the summary already holds a state, because
 * the two are answers from different reads and a detail card
 * that showed only the devices would leave a reader to do the aggregation the wire
 * has already done. Where they disagree the summary is the one the reader keeps —
 * this reading is the detail behind it, never a second source of truth for it.
 */
export interface GrowthPresenceDetail {
  readonly userId: string;
  readonly devices: readonly GrowthPresenceDeviceReading[];
  readonly aggregateState: string;
}
