// The four writes this surface offers, bound to the port that carries them.
//
// ONE COORDINATOR FOR THE THREE LIFECYCLE MOVES, and that is the registered shape
// rather than a convenience: a mute, an unmute and an archive differ in which verb
// they reach and never in what they carry, so the three share one request and one
// single-flight round. The coordinator's rule — exactly one act unsettled at a time,
// the refusal keyed to the row that asked — is then a rule about this whole list,
// which is what it has to be: two rows settling in either order against one directory
// is a list that can disagree with itself.
//
// WHY A REJECTION IS SETTLED HERE. `WireMutationCoordinator` has no `catch`, and it
// is right not to: the daemon call door answers a refusal as a VALUE and never as a
// throw. The growth port is the seam where that stops being true — a scenario that
// scripts a daemon refusal throws it verbatim and unwrapped, and the live seam will
// throw the same shape the day the wire lands and these become ordinary bridge calls.
// Left unsettled, such a rejection escapes the coordinator's `await`, the pending key
// is never released, and every control on the list stays shut for the life of the
// window behind a spinner over an answer that already arrived. So the promise is
// settled through `settleGrowthRead` — the console's ONE reader of that seam, which
// keeps the daemon's own dotted code as the refusal's own rather than stamping a
// growth-scoped one over it. That last part is the whole reason the surfaces below
// can name `channel.not_found` and `channel.inactive` at all.
//
// NOTHING IS APPLIED BEFORE THE CALL RETURNS. Every receipt below is the daemon's
// own, and what a surface does with one is that surface's business; this module
// performs the call and reads nothing into it.

import { growthMutation, type WireMutation } from "../mutation-coordinator.js";
import {
  settleGrowthRead,
  type ConsoleBridge,
  type DaemonReply,
  type GrowthChannelCreateReceipt,
  type GrowthChannelLifecycleReceipt,
  type GrowthOperationSignatures,
} from "../../bridge/index.js";

/**
 * The three lifecycle moves, declared once with the union derived from the tuple.
 *
 * Closed at three because the registered plane is: `channel.mute`, `channel.unmute`
 * and `channel.archive` are the whole of what a channel's lifecycle takes, and there
 * is no pause-channel and no mute-participant verb anywhere in the corpus for a
 * fourth member to name.
 */
export const CHANNEL_LIFECYCLE_ACTIONS = ["mute", "unmute", "archive"] as const;

/** One lifecycle move. Derived from the tuple, never restated. */
export type ChannelLifecycleAction = (typeof CHANNEL_LIFECYCLE_ACTIONS)[number];

/** What one lifecycle move takes: the channel, and which of the three verbs to reach. */
export interface ChannelLifecycleRequest {
  readonly channelId: string;
  readonly action: ChannelLifecycleAction;
}

/** What creating a channel takes, read off the growth registry rather than restated. */
export type ChannelCreateRequest = GrowthOperationSignatures["channelCreate"]["request"];

/**
 * Which growth operation each move reaches.
 *
 * A total record over the closed tuple rather than a switch, so a fourth action
 * added to that tuple fails to compile here instead of falling through to a default
 * that would silently send the wrong verb.
 */
const OPERATION_BY_ACTION: Readonly<
  Record<ChannelLifecycleAction, "channelMute" | "channelUnmute" | "channelArchive">
> = {
  mute: "channelMute",
  unmute: "channelUnmute",
  archive: "channelArchive",
};

/**
 * The wire codes these surfaces ROUTE on, spelled once.
 *
 * Named rather than left as literals at the sites that compare them: a code is a next
 * move — a channel that is GONE goes somewhere different from a name the daemon will
 * not accept — and one wire string in two positions is two places to edit it. Nothing
 * here paraphrases them; the daemon's code and the daemon's sentence both render
 * verbatim, and these constants only decide WHERE.
 *
 * `channel.inactive` is deliberately absent, and its absence is the rule rather than
 * an omission: nothing compares against it, because a refusal that routes nowhere
 * special renders where it was raised. A constant for it would be a name for a
 * decision no code makes.
 */
export const CHANNEL_NOT_FOUND_CODE = "channel.not_found";
export const CHANNEL_NAME_RESERVED_CODE = "channel.name_reserved";

/** One lifecycle move, as the shape a coordinator consumes. */
export function channelLifecycleMutation(
  bridge: ConsoleBridge,
): WireMutation<ChannelLifecycleRequest, GrowthChannelLifecycleReceipt> {
  return async (request) =>
    await settledWrite(
      growthMutation(bridge, OPERATION_BY_ACTION[request.action])({ channelId: request.channelId }),
    );
}

/** One create, as the shape a coordinator consumes. */
export function channelCreateMutation(
  bridge: ConsoleBridge,
): WireMutation<ChannelCreateRequest, GrowthChannelCreateReceipt> {
  return async (request) => await settledWrite(growthMutation(bridge, "channelCreate")(request));
}

/**
 * The growth port's fourth settlement, folded onto the two the coordinator narrows on.
 *
 * `settleGrowthRead` is generic over whatever the promise answers, so what arrives
 * here is either the reply `growthMutation` already mapped or the refusal a rejection
 * became — and the refusal is a `ConsoleRefusal`, so the fold is a widening rather
 * than a translation and nothing is paraphrased on the way through.
 */
async function settledWrite<TValue>(
  write: Promise<DaemonReply<TValue>>,
): Promise<DaemonReply<TValue>> {
  const settlement = await settleGrowthRead(write);
  return settlement.status === "unavailable"
    ? { status: "refused", refusal: settlement }
    : settlement;
}
