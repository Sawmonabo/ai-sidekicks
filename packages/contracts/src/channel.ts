// The channel's opening frames: the device's profile offer, the machine's answer, and the
// code for no common profile. A profile is one full Noise protocol name. Both ends put the
// offer and answer, byte for byte, into the handshake prologue, so a relay that dropped or
// reordered a profile makes the handshake fail on both ends rather than settle on another.
import { z } from "zod";

/** The channel frame format this build speaks. */
export const CHANNEL_VERSION = 1;

/** The profiles this build runs, in order of preference. */
export const CHANNEL_PROFILES = ["Noise_KK_25519_ChaChaPoly_SHA256"] as const;
/** One profile this build runs. */
export type ChannelProfile = (typeof CHANNEL_PROFILES)[number];

/** The Noise specification caps a protocol name at 255 bytes. */
const NOISE_PROTOCOL_NAME_MAX_LEN = 255;
/** A device offers only what it runs, so a longer list is not an offer. */
const CHANNEL_OFFER_MAX_PROFILES = 16;

/**
 * The connection's first frame. `profiles` names every profile the device runs, in
 * its order of preference. A profile this build does not know is still a valid
 * offer: a newer device offers a profile an older machine skips.
 */
export interface ChannelOffer {
  channelVersion: number;
  profiles: string[];
}
/** Parses a {@link ChannelOffer}; a profile named twice is refused. */
export const ChannelOfferSchema: z.ZodType<ChannelOffer, ChannelOffer> = z
  .object({
    channelVersion: z.number().int().positive(),
    profiles: z
      .array(
        z
          .string()
          .max(NOISE_PROTOCOL_NAME_MAX_LEN)
          .regex(
            /^Noise_[A-Za-z0-9+]+_[A-Za-z0-9+]+_[A-Za-z0-9+]+_[A-Za-z0-9+]+$/u,
            "a profile is a Noise protocol name",
          ),
      )
      .min(1)
      .max(CHANNEL_OFFER_MAX_PROFILES)
      .refine(
        (profiles) => new Set(profiles).size === profiles.length,
        "each profile is offered once",
      ),
  })
  .strict();

/** The machine's answer: the first offered profile it also runs. */
export interface ChannelAnswer {
  profile: ChannelProfile;
}
/** Parses a {@link ChannelAnswer}. */
export const ChannelAnswerSchema: z.ZodType<ChannelAnswer> = z
  .object({ profile: z.enum(CHANNEL_PROFILES) })
  .strict();

/** The machine runs none of the offered profiles, and closes the connection. */
export type ChannelNoCommonProfileCode = "channel.no_common_profile";
/** The machine runs none of the offered profiles, and closes the connection. */
export const CHANNEL_NO_COMMON_PROFILE_CODE: ChannelNoCommonProfileCode =
  "channel.no_common_profile";
