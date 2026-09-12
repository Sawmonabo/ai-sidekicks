// The channel plane's values: what a channel is FOR, and how its agents are held.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys; this file is the domain's own text.
//
// WHY THESE ARE THE CONSOLE'S AND NOT THE CONTRACT PACKAGE'S. `packages/contracts`
// ships `ChannelState` and `MAIN_CHANNEL_NAME` and the console reads both from
// there. What it does not ship is the audience or the rest of the configuration —
// `ChannelListResponseChannel` is exactly `{id, name?, state, userCount}` —
// so the vocabulary below is the console's single declaration of a shape no code
// package carries.

/**
 * Who reads a channel.
 *
 * Two values and no third. `users` means this session's sidekicks read the
 * channel; `humans-only` means no sidekick ever does. The distinction is a DAEMON
 * obligation and never renderer etiquette — a console that derived an audience from
 * what happened to be in a channel would be asserting a fact nobody sent it, and
 * getting it wrong puts a sidekick in a room that was supposed to have none.
 */
export const GROWTH_CHANNEL_AUDIENCES = ["users", "humans-only"] as const;

/** One audience. Derived from the tuple, never restated. */
export type GrowthChannelAudience = (typeof GROWTH_CHANNEL_AUDIENCES)[number];

/**
 * A channel's whole policy, every member of it fixed at creation.
 *
 * Optional throughout because the wire's own shape is: each absent member means the
 * session's default rather than a value the console may fill in.
 */
export interface GrowthChannelConfig {
  readonly moderation?: {
    readonly preTurnGate?: boolean;
    readonly postTurnReview?: boolean;
  };
  readonly audience?: GrowthChannelAudience;
  readonly turnsPerAgent?: number;
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
