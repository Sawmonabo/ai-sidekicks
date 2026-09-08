// The presence plane's values: what the two Awareness activity fields carry.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys; this file is the domain's own text.
//
// TWO FIELDS AND NOT ONE, ALL THE WAY DOWN. `Spec-002 §Default Behavior` carries a
// human's composing signal on the scalar `activity.typing` and an agent's on the
// run-keyed map `activity.runs`, and the two are produced by opposite machinery — a
// receiver-timed one and an edge-triggered one. The snapshot below keeps them apart
// for that reason: a single flat list of "who is busy" would make the console pick
// one expiry rule for both, which is the conflation `collaboration/activity-model.ts`
// exists to prevent.
//
// NOTHING HERE CARRIES CONTENT. `Spec-002 §Required Behavior` forbids it on the wire,
// so there is no member for it to arrive in — not a preview, not a length, not a
// keystroke count. What travels is who, where, and since when.
//
// `since` IS WIRE-SUPPLIED AND DISPLAY-ONLY on both shapes. Awareness is skew-free
// because each receiver stamps observation time from its own clock, so a consumer
// that subtracted this from its own `now` would expire an indicator by the skew
// between two machines. The registry's own header states the same rule from the
// consuming side.

/** One human composing, as the `activity.typing` field carries it. */
export interface GrowthComposingReading {
  readonly participantId: string;
  /**
   * The channel they are composing in.
   *
   * Never a membership-restricted channel: `Spec-002 §Default Behavior` suppresses
   * the WHOLE indicator publisher-side rather than blanking this member, because a
   * blanked channel id would still disclose that some private exchange is live.
   */
  readonly channelId: string;
  /** Wire-supplied, display-only. Never an input to an expiry decision. */
  readonly since: string;
}

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
 * A SNAPSHOT AND NOT A DELTA FEED, which is the same discipline the roster read
 * keeps: Awareness state is a map each publisher owns outright, so the honest thing
 * to hand a consumer is what that map says now. The console diffs it into its own
 * registry (`collaboration/activity-feed.ts`), which is where the two mechanisms'
 * clear rules live — and a wire that emitted edges instead would make every consumer
 * responsible for reconstructing the map from a stream it might have joined late.
 *
 * Both lists are REQUIRED and empty rather than optional. "Nobody is composing" is a
 * real state of a session and an absent member is not: an optional list would let a
 * publisher that had never populated the field and one that had just seen the last
 * composer stop read identically.
 */
export interface GrowthActivitySnapshot {
  readonly composing: readonly GrowthComposingReading[];
  readonly agentRuns: readonly GrowthAgentActivityReading[];
}
