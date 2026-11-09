// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The channel's opening frames: the device's profile offer and the machine's answer.

/** The channel frame format this build speaks. */
export const CHANNEL_VERSION = 1 as const;

/** The profiles this build runs, in order of preference. */
export const CHANNEL_PROFILES = ["Noise_KK_25519_ChaChaPoly_SHA256"] as const;

/**
 * One profile this build runs.
 */
export type ChannelProfile = "Noise_KK_25519_ChaChaPoly_SHA256";
/**
 * A Noise protocol name, which a device may offer whether or not this build runs it.
 */
export type NoiseProtocolName = string;

/**
 * The connection's first frame: every profile the device runs, in its order of preference, each
 * once. A profile this build does not know is still a valid offer, which an older machine skips.
 */
export interface ChannelOffer {
  /**
   * The channel frame format the device speaks.
   */
  channelVersion: number;
  /**
   * The profiles, in the device's order of preference.
   *
   * @minItems 1
   * @maxItems 16
   */
  profiles:
    | [NoiseProtocolName]
    | [NoiseProtocolName, NoiseProtocolName]
    | [NoiseProtocolName, NoiseProtocolName, NoiseProtocolName]
    | [NoiseProtocolName, NoiseProtocolName, NoiseProtocolName, NoiseProtocolName]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ]
    | [
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
        NoiseProtocolName,
      ];
}
/**
 * The machine's answer: the first offered profile it also runs.
 */
export interface ChannelAnswer {
  /**
   * The profile both ends run.
   */
  profile: ChannelProfile;
}
