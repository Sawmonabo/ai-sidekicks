// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The wire shapes of a streaming subscription: `$/subscription/notify`, `$/subscription/end` and `$/subscription/cancel`, and the acknowledgment every `*.subscribe` method answers with. A subscription holds only its place, never a queue, so its frames drop nothing a consumer cannot read back.

import type { JsonRpcError } from "./message.js";

/**
 * The daemon-to-client notification carrying one subscription value. The `$/` prefix marks a
 * system method outside the user namespace; the daemon registers no handler for it.
 */
export const SUBSCRIPTION_NOTIFY_METHOD = "$/subscription/notify" as const;

/**
 * The call a client sends to tear down a subscription. The daemon answers it as a read, so a
 * client can still clean up after a failed version handshake.
 */
export const SUBSCRIPTION_CANCEL_METHOD = "$/subscription/cancel" as const;

/**
 * The daemon-to-client notification that ends one subscription from the daemon's side: the
 * last frame for that id. A subscription the client cancels, or whose connection closes,
 * gets none.
 */
export const SUBSCRIPTION_END_METHOD = "$/subscription/end" as const;

/**
 * The most changes one frame carries. The daemon coalesces a stream's changes into one frame
 * per short window or this many changes, whichever comes first.
 */
export const STREAM_FRAME_MAX_CHANGES = 50 as const;

/**
 * The most events a stream over a stored record may stand behind the record's head when its
 * next frame is read; past it the stream is sent the behind frame and moved to the head.
 */
export const STREAM_BEHIND_MAX_EVENTS = 1024 as const;

/**
 * The most bytes of stored events, 1 MB, a stream over a stored record may stand behind the
 * record's head when its next frame is read; past it the stream is sent the behind frame.
 */
export const STREAM_BEHIND_MAX_BYTES = 1000000 as const;

/**
 * The opaque id of one subscription, a UUID the daemon mints.
 */
export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };
/**
 * The params of an end frame: `completed` when the stream finished, or `refused` with the error
 * the daemon ended it for.
 */
export type SubscriptionEndParams =
  | {
      reason: "completed";
      /**
       * The subscription that ended.
       */
      subscriptionId: SubscriptionId;
    }
  | {
      reason: "refused";
      /**
       * The subscription that ended.
       */
      subscriptionId: SubscriptionId;
      /**
       * Why it ended.
       */
      error: JsonRpcError;
    };

/**
 * The acknowledgment every `*.subscribe` method answers with: the id the daemon allocated.
 * Values follow as notify frames, and the acknowledgment settles before any of them.
 */
export interface SubscribeAcknowledgmentResponse {
  /**
   * The subscription's id, which routes its notify frames.
   */
  subscriptionId: SubscriptionId;
}
/**
 * The params of a notify frame: the id that routes it and one value the stream produced.
 */
export interface SubscriptionNotifyParams {
  /**
   * The subscription the value belongs to.
   */
  subscriptionId: SubscriptionId;
  /**
   * The value.
   */
  value: unknown;
}
/**
 * The params of a cancel call. It is a request, so the client learns from its result whether it
 * worked; only the connection that owns a subscription can cancel it.
 */
export interface SubscriptionCancelRequest {
  /**
   * The subscription to cancel.
   */
  subscriptionId: SubscriptionId;
}
/**
 * The result of a cancel call. `canceled` is false when the id is unknown or another
 * connection's; the two are not told apart, so one connection cannot probe for another's.
 */
export interface SubscriptionCancelResponse {
  /**
   * Whether the subscription was canceled.
   */
  canceled: boolean;
}
