// The wire shapes of a streaming subscription (`$/subscription/notify`, `$/subscription/end` and
// `$/subscription/cancel`) and the `LocalSubscriptionProducer` a daemon handler emits through: it
// returns the `subscriptionId` in the ack, then each `next(value)` is validated and sent as a
// notify frame, and a stream the daemon ends sends one end frame. Only the owning connection may
// cancel, and a closed connection drops its own.

import { z } from "zod";

import { brandedUuidIdSchema } from "../internal/branded.js";
import { JsonRpcErrorSchema, type JsonRpcError } from "./message.js";

/**
 * The method name of the daemon-to-client notification carrying one subscription value. The
 * `$/` prefix marks a system method outside the user namespace. It is outbound only; the daemon
 * registers no handler for it.
 */
export const SUBSCRIPTION_NOTIFY_METHOD = "$/subscription/notify" as const;
/**
 * The type of {@link SUBSCRIPTION_NOTIFY_METHOD}.
 *
 * @consumedBy the subscription transport's `$/subscription/notify` frames
 */
export type SubscriptionNotifyMethod = typeof SUBSCRIPTION_NOTIFY_METHOD;

/**
 * The method name a client sends to tear down a subscription. The daemon registers it as
 * non-mutating, so a client can still clean up after a failed version handshake.
 */
export const SUBSCRIPTION_CANCEL_METHOD = "$/subscription/cancel" as const;
/**
 * The type of {@link SUBSCRIPTION_CANCEL_METHOD}.
 *
 * @consumedBy the subscription transport's `$/subscription/cancel` frames
 */
export type SubscriptionCancelMethod = typeof SUBSCRIPTION_CANCEL_METHOD;

/** The opaque id of one subscription: a UUID string at runtime, nominally typed at compile time. */
export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };

/** Parses a {@link SubscriptionId} with the same accept set as every branded UUID id. */
export const SubscriptionIdSchema: z.ZodType<SubscriptionId, SubscriptionId> =
  brandedUuidIdSchema<SubscriptionId>("SubscriptionId");

/**
 * The method name of the daemon-to-client notification that ends one subscription from the
 * daemon's side. It is the last frame for that id; a subscription the client cancels, or whose
 * connection closes, gets none.
 */
export const SUBSCRIPTION_END_METHOD = "$/subscription/end" as const;

/**
 * The `params` of an end frame: `completed` when the stream finished, or `refused` with the error
 * the daemon ended it for.
 */
export type SubscriptionEndParams =
  | { readonly subscriptionId: SubscriptionId; readonly reason: "completed" }
  | {
      readonly subscriptionId: SubscriptionId;
      readonly reason: "refused";
      readonly error: JsonRpcError;
    };

/** Parses {@link SubscriptionEndParams}; unknown top-level fields are refused. */
export const SubscriptionEndParamsSchema: z.ZodType<SubscriptionEndParams> = z.discriminatedUnion(
  "reason",
  [
    z.object({ subscriptionId: SubscriptionIdSchema, reason: z.literal("completed") }).strict(),
    z
      .object({
        subscriptionId: SubscriptionIdSchema,
        reason: z.literal("refused"),
        error: JsonRpcErrorSchema,
      })
      .strict(),
  ],
);

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
 * One notify's `value` on a stream of changes: those since the previous frame, oldest first, each
 * with its own cursor. The daemon never waits for a slow connection: changes that do not fit are
 * dropped and `dropped` rides the next frame, so the screen repairs by cursor; a frame with no
 * changes is that caught-up frame and carries the stream's newest `cursor`.
 */
export interface StreamFrame<Change, Cursor> {
  readonly changes: readonly Change[];
  readonly dropped?: true | undefined;
  readonly cursor?: Cursor | undefined;
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
          "A frame carries changes and no frame cursor, or no " +
          "changes with the drop mark and the newest cursor.",
      },
    );
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
   * Marks the subscription complete from the producer's side and sends the `completed` end frame.
   * It does not fire `onCancel` handlers. Idempotent; later `next` calls are no-ops.
   */
  complete(): void;

  /**
   * Cancels from the server side: removes the subscription, sends the `refused` end frame carrying
   * `error`, or an internal error when none is given, and fires `onCancel` handlers. Idempotent;
   * later `next` calls are no-ops.
   *
   * @throws AggregateError carrying every handler failure, after all handlers ran.
   */
  cancel(error?: JsonRpcError): void;

  /**
   * Registers a callback for when the subscription is canceled from outside: by `cancel()`, by
   * the client's cancel call, or by the connection closing. It does not fire on `complete()`. A
   * handler releases upstream resources; a throwing handler does not stop the others, and the
   * cancel then throws its failure (a closed connection has no caller, so the daemon logs it).
   * Handlers run in registration order after the subscription is removed. Registering on an
   * already-canceled subscription runs the handler at once and throws its failure to the
   * registrant. Registering the same function twice runs it twice.
   */
  onCancel(fn: () => void): void;
}
