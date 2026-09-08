// The channel plane: creating one, moving one through its lifecycle, and reading the
// three facts about one that `channel.list` has never carried.
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
  GrowthChannelKind,
  GrowthChannelLifecycleReceipt,
  GrowthChannelRosterEntry,
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
  //
  // The create request carries the kind and the pair TOGETHER because the wire's own
  // validation couples them: a `direct` channel REQUIRES exactly two distinct human
  // participants and refuses every agent-turn member, and a `general` channel refuses
  // the pair. The console does not enforce either — it collects what the form offers
  // for the kind that is selected and lets the daemon refuse — but the shape has to
  // be able to carry both arms or the direct form has nowhere to put its picker's
  // answer.
  //
  // The pair is a two-element tuple rather than a list, because "exactly two" is the
  // rule and a list would let a caller send three and discover it on the wire.
  channelCreate: {
    request: {
      readonly sessionId: string;
      readonly name?: string;
      readonly kind?: GrowthChannelKind;
      readonly memberPair?: readonly [string, string];
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
  // The roster read is SESSION-scoped and carries no channel id, exactly as the
  // registered shape is: it answers for every channel the caller may see, and the
  // daemon's own non-disclosure filter decides which those are. A per-channel form
  // would let a caller ask about a `direct` channel it is not in and learn from the
  // refusal that it exists.
  channelRosterRead: {
    request: { readonly sessionId: string };
    value: readonly GrowthChannelRosterEntry[];
  };
}
