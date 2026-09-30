// The channel's first frame goes into the handshake's prologue byte for byte, so an offer must
// parse on a machine that does not know every profile in it, and must refuse the malformed
// offers a relay could forge.
import { describe, expect, it } from "vitest";

import { ChannelOfferSchema, CHANNEL_PROFILES, CHANNEL_VERSION } from "../channel.js";

const TODAY = CHANNEL_PROFILES[0];
const HYBRID = "Noise_XXhfs_25519+MLKEM768_ChaChaPoly_SHA256";

describe("the channel offer", () => {
  it("accepts a newer device's offer that leads with a profile this build does not run", () => {
    expect(
      ChannelOfferSchema.safeParse({ channelVersion: CHANNEL_VERSION, profiles: [HYBRID, TODAY] })
        .success,
    ).toBe(true);
  });

  it("refuses an empty offer, a repeated profile and a name that is not a Noise protocol", () => {
    for (const profiles of [[], [TODAY, TODAY], ["TLS_AES_128_GCM_SHA256"]]) {
      expect(
        ChannelOfferSchema.safeParse({ channelVersion: CHANNEL_VERSION, profiles }).success,
      ).toBe(false);
    }
  });
});
