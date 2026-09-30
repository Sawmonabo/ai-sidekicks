// The wire shapes of a streaming subscription (`$/subscription/notify` and
// `$/subscription/cancel`) and the server-side `LocalSubscriptionProducer` a handler emits through.
// The runtime is `packages/runtime-daemon/src/ipc/streaming-primitive.ts`. A handler creates a
// subscription, returns its `subscriptionId` in the ack, then calls `next(value)`; each value is
// validated against the subscription's schema and sent as a notify frame. Only the owning
// connection may cancel, and the daemon drops a connection's subscriptions when it closes.

import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";

/**
 * The method name of the daemon-to-client notification carrying one subscription value. The
 * `$/` prefix marks a system method outside the user namespace. It is outbound only; the daemon
 * registers no handler for it.
 */
export const SUBSCRIPTION_NOTIFY_METHOD = "$/subscription/notify" as const;
/** The type of {@link SUBSCRIPTION_NOTIFY_METHOD}. */
export type SubscriptionNotifyMethod = typeof SUBSCRIPTION_NOTIFY_METHOD;

/**
 * The method name a client sends to tear down a subscription. The daemon registers it as
 * non-mutating, so a client can still clean up after a failed version handshake.
 */
export const SUBSCRIPTION_CANCEL_METHOD = "$/subscription/cancel" as const;
/** The type of {@link SUBSCRIPTION_CANCEL_METHOD}. */
export type SubscriptionCancelMethod = typeof SUBSCRIPTION_CANCEL_METHOD;

/** The opaque id of one subscription: a UUID string at runtime, nominally typed at compile time. */
export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };

/** Parses a {@link SubscriptionId} with the same accept set as every branded UUID id. */
export const SubscriptionIdSchema: z.ZodType<SubscriptionId, SubscriptionId> =
  brandedUuidIdSchema<SubscriptionId>("SubscriptionId");

/**
 * The ack every `*.subscribe` method returns, carrying only the `subscriptionId` the server
 * allocated; values follow as notify frames, and the ack settles before any notify for that id. A
 * method that needs more ack fields extends this interface.
 */
export interface SubscribeAckResponse {
  readonly subscriptionId: SubscriptionId;
}

/** Parses a {@link SubscribeAckResponse}; unknown fields are refused. */
export const SubscribeAckResponseSchema: z.ZodType<SubscribeAckResponse> = z
  .object({ subscriptionId: SubscriptionIdSchema })
  .strict();

/**
 * The `params` of a notify frame: the `subscriptionId` for routing and the `value` one
 * `next(value)` produced.
 */
export interface SubscriptionNotifyParams<T> {
  readonly subscriptionId: SubscriptionId;
  readonly value: T;
}

/**
 * Builds the notify `params` schema for one subscription from its `valueSchema`. Unknown fields
 * are refused, so an extra field emitted by mistake fails validation instead of leaking.
 */
export function SubscriptionNotifyParamsSchema<T>(
  valueSchema: z.ZodType<T>,
): z.ZodType<SubscriptionNotifyParams<T>> {
  return z
    .object({
      subscriptionId: SubscriptionIdSchema,
      value: valueSchema,
    })
    .strict() as unknown as z.ZodType<SubscriptionNotifyParams<T>>;
}

/**
 * The most changes one frame carries. The daemon coalesces a stream's changes into one frame per
 * short window or this many changes, whichever comes first.
 */
export const STREAM_FRAME_MAX_CHANGES = 50;

/**
 * One notify's `value` on a stream that sends changes. `changes` are those since the previous
 * frame, oldest first, each carrying its own cursor. The daemon never waits for a slow connection:
 * changes that do not fit are dropped for it and `dropped` rides the next frame that fits, so the
 * screen repairs from the daemon's record by cursor. A frame with no changes exists only after a
 * drop, once the connection has caught up; it carries `dropped` and the stream's newest `cursor`.
 * A frame with changes carries no frame-level cursor.
 */
export interface StreamFrame<Change, Cursor> {
  readonly changes: readonly Change[];
  readonly dropped?: true;
  readonly cursor?: Cursor;
}

/**
 * Builds the schema for a {@link StreamFrame} over one stream's change and
 * cursor schemas. It refuses more than {@link STREAM_FRAME_MAX_CHANGES}
 * changes, a frame with no changes that is not the caught-up drop frame, and
 * a frame-level cursor beside changes.
 */
export function StreamFrameSchema<Change, Cursor>(
  changeSchema: z.ZodType<Change>,
  cursorSchema: z.ZodType<Cursor>,
): z.ZodType<StreamFrame<Change, Cursor>> {
  return z
    .object({
      changes: z.array(changeSchema).max(STREAM_FRAME_MAX_CHANGES),
      dropped: z.literal(true).optional(),
      cursor: cursorSchema.optional(),
    })
    .strict()
    .refine(
      (frame) =>
        frame.changes.length > 0
          ? frame.cursor === undefined
          : frame.dropped === true && frame.cursor !== undefined,
      {
        message:
          "A frame carries changes and no frame cursor, or no changes with the drop mark and the newest cursor.",
      },
    ) as unknown as z.ZodType<StreamFrame<Change, Cursor>>;
}

/**
 * The `params` of a cancel call. It is a request, not a notification, so the client learns whether
 * it worked from {@link SubscriptionCancelResult}. Only the connection that owns the subscription
 * can cancel it.
 */
export interface SubscriptionCancelParams {
  readonly subscriptionId: SubscriptionId;
}

/** Parses {@link SubscriptionCancelParams}; unknown fields are refused. */
export const SubscriptionCancelParamsSchema: z.ZodType<SubscriptionCancelParams> = z
  .object({
    subscriptionId: SubscriptionIdSchema,
  })
  .strict() as unknown as z.ZodType<SubscriptionCancelParams>;

/**
 * The result of a cancel call. `canceled` is false when the id is unknown or owned by another
 * connection; the two are not told apart, so one connection cannot probe for another's
 * subscriptions.
 */
export interface SubscriptionCancelResult {
  readonly canceled: boolean;
}

/** Parses a {@link SubscriptionCancelResult}; unknown fields are refused. */
export const SubscriptionCancelResultSchema: z.ZodType<SubscriptionCancelResult> = z
  .object({
    canceled: z.boolean(),
  })
  .strict() as unknown as z.ZodType<SubscriptionCancelResult>;

/**
 * The server-side handle a handler emits through, created per subscription and owned by one
 * connection. It is distinct from the client SDK's `LocalSubscriptionConsumer`.
 */
export interface LocalSubscriptionProducer<T> {
  /** The id the handler returns to the client so it can route notify frames. */
  readonly subscriptionId: SubscriptionId;

  /**
   * Validates `value` against the subscription's schema and sends it as a notify frame. A silent
   * no-op after `complete()`, `cancel()` or the connection closing, because async producers race
   * with teardown.
   *
   * @throws StreamingValidationError when `value` fails the schema; a producer bug the daemon
   * refuses to put on the wire.
   */
  next(value: T): void;

  /**
   * Marks the subscription complete from the producer's side. It sends no frame and does not fire
   * `onCancel` handlers. Idempotent; later `next` calls are no-ops.
   */
  complete(): void;

  /**
   * Cancels from the server side: removes the subscription and fires `onCancel` handlers, without
   * sending a frame. Idempotent; later `next` calls are no-ops.
   */
  cancel(): void;

  /**
   * Registers a callback for when the subscription is cancelled from outside: by `cancel()`, by
   * the client's cancel call, or by the connection closing. It does not fire on `complete()`. A
   * handler releases upstream resources; on a cancel a throwing handler does not stop the others,
   * and its error is swallowed. Handlers run in registration order after the subscription is
   * removed. Registering on an already-cancelled subscription runs the handler at once and throws
   * its failure to the registrant. Registering the same function twice runs it twice.
   */
  onCancel(fn: () => void): void;
}
