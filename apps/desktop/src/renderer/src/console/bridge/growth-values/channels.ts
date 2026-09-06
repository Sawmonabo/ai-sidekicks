// The channel plane's values: what a channel is FOR, who it is for, and — where it
// is a direct channel — which two humans it is between.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys; this file is the domain's own text.
//
// WHY THESE ARE THE CONSOLE'S AND NOT THE CONTRACT PACKAGE'S. `packages/contracts`
// ships `ChannelState` and `MAIN_CHANNEL_NAME` and the console reads both from
// there. What it does not ship is the audience, the kind, or the member pair —
// `ChannelListResponseChannel` is exactly `{id, name?, state, participantCount}` —
// so the three vocabularies below are the console's single declaration of shapes
// `Spec-016 §Interfaces And Contracts` registers and no code package carries. They
// leave this module the day `channel.rosterRead` lands.

/**
 * Who reads a channel, as `Spec-016` closes the set.
 *
 * Two values and no third. `participants` means this session's agents read the
 * channel; `humans-only` means no agent ever does. The distinction is a DAEMON
 * obligation and never renderer etiquette — a console that derived an audience from
 * who happened to be in a channel would be asserting a fact nobody sent it, and
 * getting it wrong puts an agent in a room that was supposed to have none.
 */
export const GROWTH_CHANNEL_AUDIENCES = ["participants", "humans-only"] as const;

/** One audience. Derived from the tuple, never restated. */
export type GrowthChannelAudience = (typeof GROWTH_CHANNEL_AUDIENCES)[number];

/**
 * The two-value channel-kind domain.
 *
 * A `direct` channel is the immutable two-human pair fixed at creation; everything
 * else is `general`. The daemon forces `humans-only` on the direct kind and refuses
 * a conflicting audience, so the console never offers one there.
 */
export const GROWTH_CHANNEL_KINDS = ["general", "direct"] as const;

/** One channel kind. Derived from the tuple, never restated. */
export type GrowthChannelKind = (typeof GROWTH_CHANNEL_KINDS)[number];

/**
 * How agents take turns in a channel, as `Spec-016` closes the set.
 *
 * Create-time-fixed like every other member of the configuration: V1 registers no
 * channel-configuration mutation at all, so a channel whose rhythm turns out wrong
 * is replaced rather than reconfigured.
 */
export const GROWTH_CHANNEL_TURN_POLICIES = ["free-form", "round-robin", "moderated"] as const;

/** One turn policy. Derived from the tuple, never restated. */
export type GrowthChannelTurnPolicy = (typeof GROWTH_CHANNEL_TURN_POLICIES)[number];

/**
 * A channel's whole policy, every member of it fixed at creation.
 *
 * Optional throughout because the wire's own shape is: each absent member means the
 * session's default rather than a value the console may fill in. `audience` is the
 * one member the directory RENDERS, and its absence is why the roster read exists.
 */
export interface GrowthChannelConfig {
  readonly turnPolicy?: GrowthChannelTurnPolicy;
  readonly roundRobinOrder?: readonly string[];
  readonly moderation?: {
    readonly preTurnGate?: boolean;
    readonly postTurnReview?: boolean;
  };
  readonly audience?: GrowthChannelAudience;
  readonly turnsPerAgent?: number;
}

/**
 * One channel as the roster read carries it.
 *
 * `memberPair` is present exactly when `kind` is `direct`, in the canonical order
 * the daemon fixed at creation — the console never re-orders it, because the order
 * carries no meaning and re-sorting would make one pair read as two.
 *
 * THE NON-DISCLOSURE FILTER IS THE DAEMON'S AND IS INVISIBLE HERE. A direct channel
 * is omitted from this reply for a caller outside its pair, so there is no shape
 * here for a hidden row and therefore no way to count one.
 */
export interface GrowthChannelRosterEntry {
  readonly id: string;
  readonly name?: string;
  readonly kind: GrowthChannelKind;
  readonly memberPair?: readonly [string, string];
  readonly config: GrowthChannelConfig;
}

/** What creating a channel answers with. The identity every later read is keyed by. */
export interface GrowthChannelCreateReceipt {
  readonly channelId: string;
  readonly state: string;
  readonly createdAt: string;
}

/** What a lifecycle move answers with: the channel, and the state it is now in. */
export interface GrowthChannelLifecycleReceipt {
  readonly channelId: string;
  readonly state: string;
}
