// The channel plane: creating one, and moving one through its lifecycle.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The
// section and row comments below are the file's own.
//
// THE REQUESTS ARE THE REGISTERED SHAPES, NARROWED TO WHAT A CONSOLE CAN SEND. The
// create request drops nothing the daemon accepts, because the create moment is the
// only moment a channel's policy can be set and a form that could not send one of
// its members would be a form that silently fixes it. The three lifecycle requests
// carry the channel and nothing else, which is the whole of what the registered
// shape carries: a lifecycle move names no reason, no actor, and no expected state.

import type {
  GrowthChannelConfig,
  GrowthChannelCreateReceipt,
  GrowthChannelLifecycleReceipt,
} from "../growth-values/index.js";

/**
 * What a lifecycle move takes: one channel, named by the id the directory holds.
 *
 * Shared by the three moves rather than spelled three times, because the registered
 * shape IS one — a mute, an unmute and an archive differ in which verb they reach,
 * never in what they carry — and three copies of one shape drift the day one of them
 * grows a member.
 */
export interface GrowthChannelLifecycleRequest {
  readonly channelId: string;
}

export interface ChannelGrowthSignatures {
  // channels
  channelCreate: {
    request: {
      readonly sessionId: string;
      readonly name?: string;
      readonly config?: GrowthChannelConfig;
    };
    value: GrowthChannelCreateReceipt;
  };
  channelMute: {
    request: GrowthChannelLifecycleRequest;
    value: GrowthChannelLifecycleReceipt;
  };
  channelUnmute: {
    request: GrowthChannelLifecycleRequest;
    value: GrowthChannelLifecycleReceipt;
  };
  channelArchive: {
    request: GrowthChannelLifecycleRequest;
    value: GrowthChannelLifecycleReceipt;
  };
}
