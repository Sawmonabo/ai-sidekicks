// The consumer side of a daemon subscription, as `JsonRpcClient.subscribe` returns it: the handle a
// caller reads values from, the state the client fills, and the one queue `next()` and `for await`
// both drain. The client decides when a subscription opens, takes a value and ends.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { ZodType } from "zod";

// The consumer interface

/**
 * A subscribe reply: the daemon-issued `subscriptionId`, and any members the method's contract adds
 * to its acknowledgment, kept as the daemon sent them.
 */
export interface SubscribeAcknowledgment {
  readonly subscriptionId: SubscriptionId;
  readonly [member: string]: unknown;
}

/**
 * The handle `JsonRpcClient.subscribe` returns synchronously; distinct from the daemon-side
 * `LocalSubscriptionProducer<T>` in `@ai-sidekicks/contracts/jsonrpc/streaming`, which a handler
 * emits values into. Each validated
 * `$/subscription/notify` value lands in one bounded internal queue that `next()` and `for await`
 * both drain; `cancel()` sends `$/subscription/cancel` and awaits the ack.
 *
 * The stream completes with `undefined` (after the queue drains) when the daemon ends it as
 * `completed` or on a client `cancel()`. `next()` rejects with `JsonRpcRemoteError` when the
 * daemon ends it as `refused`, with the transport's close reason when the transport drops, and
 * with `JsonRpcSubscriptionOverflowError` when the consumer let the queue fill.
 */
export interface LocalSubscriptionConsumer<T> {
  /**
   * The daemon-issued subscription id: `""` until the initial response arrives, and populated
   * before the first `next()` or iterator tick settles. Do not read it synchronously after
   * `subscribe()` returns. A plain `string`; use `SubscriptionIdSchema` from
   * `@ai-sidekicks/contracts/jsonrpc/streaming` to get the branded type.
   */
  readonly subscriptionId: string;

  /**
   * The subscribe reply whole when it carries more than `subscriptionId`, such as the list a list
   * subscription opens with, for a caller to hand on ahead of the first value; `undefined` for a
   * reply that carries the id alone. Rejects as `next()` does when the subscribe itself failed.
   */
  readOpeningValue(): Promise<SubscribeAcknowledgment | undefined>;

  /**
   * Pull the next value: resolves with it, with `undefined` once the stream completes, or rejects
   * with the transport's reason when the transport closes abnormally. Do not mix `next()` with
   * iterator consumption; both drain the same queue.
   */
  next(): Promise<T | undefined>;

  /**
   * Cancel on the daemon and await its ack, waiting first for the subscribe reply if it has not
   * arrived. Never rejects: afterward `next()` drains any queued values and then returns
   * `undefined`, or throws the cancel's failure. Frames that arrive after the call are dropped.
   * Idempotent: a repeat call sends no second wire request.
   */
  cancel(): Promise<void>;

  /**
   * A fresh iterator over the same queue as `next()`, so `for await` and direct `next()` polling
   * are mutually exclusive, as are repeated `for await` blocks on one subscription.
   */
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

// Subscription state

/**
 * Lifecycle of one subscription:
 *   * `pending` - the init response has not arrived.
 *   * `active` - the id is known and notifications drain into the queue.
 *   * `completed` - canceled, ended by the daemon as `completed`, or transport closed; `next()`
 *     drains the queue, then returns `undefined`.
 *   * `errored` - the init, a value, the queue bound, the cancel or the transport failed, or the
 *     daemon ended it as `refused`; `next()` drains the queue, then rejects with the stored error.
 */
type SubscriptionStatus = "pending" | "active" | "completed" | "errored";

/** One subscription as the client tracks it and its handle reads it. */
export interface SubscriptionState<T> {
  status: SubscriptionStatus;
  subscriptionId: string;
  readonly valueSchema: ZodType<T>;
  /** Queued values awaiting consumption. */
  readonly queue: Array<T>;
  /** Pending consumer awaiters (one per `next()` call past the queue). */
  readonly waiters: Array<{
    readonly resolve: (value: T | undefined) => void;
    readonly reject: (error: Error) => void;
  }>;
  /** Set when status becomes `errored`. */
  error: Error | undefined;
  /**
   * Set once a cancel starts, by the consumer or by the client ending a failed subscription, so a
   * second `cancel()` awaits the same promise and no second wire cancel is sent.
   */
  cancelInFlight: Promise<void> | undefined;
}

// Subscription handle

/**
 * The `LocalSubscriptionConsumer<T>` returned to callers. A class so the async iterator can close
 * over the same state and `subscriptionId` can be filled in after the init response.
 */
export class LocalSubscriptionHandle<T> implements LocalSubscriptionConsumer<T> {
  readonly #state: SubscriptionState<T>;
  readonly #cancel: () => Promise<void>;
  readonly #initAck: Promise<SubscribeAcknowledgment>;

  public constructor(
    state: SubscriptionState<T>,
    cancelFn: () => Promise<void>,
    initAck: Promise<SubscribeAcknowledgment>,
  ) {
    this.#state = state;
    this.#cancel = cancelFn;
    this.#initAck = initAck;
  }

  public get subscriptionId(): string {
    return this.#state.subscriptionId;
  }

  public readOpeningValue(): Promise<SubscribeAcknowledgment | undefined> {
    return this.#initAck.then((acknowledgment) =>
      Object.keys(acknowledgment).some((member) => member !== "subscriptionId")
        ? acknowledgment
        : undefined,
    );
  }

  public next(): Promise<T | undefined> {
    return pullFromSubscription(this.#state);
  }

  public cancel(): Promise<void> {
    return this.#cancel();
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    const state = this.#state;
    const cancel = (): Promise<void> => this.#cancel();
    return {
      next(): Promise<IteratorResult<T>> {
        return pullFromSubscription(state).then(
          (value): IteratorResult<T> =>
            value === undefined ? { value: undefined, done: true } : { value, done: false },
        );
      },
      // `for await ... break` lands here; cancel so the daemon releases the subscription.
      async return(): Promise<IteratorResult<T>> {
        await cancel();
        return { value: undefined, done: true };
      },
    };
  }
}

/**
 * Pull the next value from a subscription's queue or park a waiter. Resolves `undefined` once the
 * subscription completed and the queue is drained; rejects if it errored.
 */
function pullFromSubscription<T>(state: SubscriptionState<T>): Promise<T | undefined> {
  // Queued values are surfaced even after completion or error.
  if (state.queue.length > 0) {
    // `shift()` is defined here; `noUncheckedIndexedAccess` widens it to `T | undefined`.
    const value = state.queue.shift() as T;
    return Promise.resolve(value);
  }
  if (state.status === "completed") {
    return Promise.resolve(undefined);
  }
  if (state.status === "errored" && state.error !== undefined) {
    return Promise.reject(state.error);
  }
  return new Promise<T | undefined>((resolve, reject) => {
    state.waiters.push({ resolve, reject });
  });
}

/**
 * Push an already-validated value to a waiting consumer, or queue it. The caller must have
 * validated `value` against `state.valueSchema`; the client's notification handler does that with
 * the wrapper schema. Only a registered subscription receives values, and a registered one is
 * always active: every path that ends it also untracks it, before any value can arrive.
 */
export function pushSubscriptionValue<T>(state: SubscriptionState<T>, value: T): void {
  const waiter = state.waiters.shift();
  if (waiter !== undefined) {
    waiter.resolve(value);
    return;
  }
  state.queue.push(value);
}

/** Ends a subscription cleanly and resolves every waiter with `undefined`. Idempotent. */
export function completeSubscription<T>(state: SubscriptionState<T>): void {
  if (state.status === "completed" || state.status === "errored") {
    return;
  }
  state.status = "completed";
  // Queued values stay consumable.
  while (state.waiters.length > 0) {
    const waiter = state.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(undefined);
    }
  }
}

/**
 * Ends a subscription with `error`, rejects every waiter and stores it so later `next()` calls
 * reject too. Idempotent.
 */
export function completeSubscriptionWithError<T>(state: SubscriptionState<T>, error: Error): void {
  if (state.status === "completed" || state.status === "errored") {
    return;
  }
  state.status = "errored";
  state.error = error;
  while (state.waiters.length > 0) {
    const waiter = state.waiters.shift();
    if (waiter !== undefined) {
      waiter.reject(error);
    }
  }
}
