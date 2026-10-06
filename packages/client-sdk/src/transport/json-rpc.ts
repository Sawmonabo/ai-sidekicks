// Typed JSON-RPC client over a pluggable byte-frame transport, with the transport interface it
// runs over and the subscription handle it returns: `call` and `subscribe` validate
// every outbound payload with Zod before the wire write and every inbound payload before it
// reaches the caller. Validation errors surface; they are never swallowed. A subscription holds
// at most `maxQueuedValuesPerSubscription` unread values, so a stalled consumer cannot grow memory
// without bound.
//
// Works at the JSON-RPC envelope layer above the transport's framing. It does not perform the
// `daemon.hello` handshake: the caller negotiates a version and passes it as `protocolVersion`.
// It is the inverse of the daemon's `mapJsonRpcError`: numeric error codes come back as a typed
// `JsonRpcRemoteError`.

import type {
  JsonRpcErrorData,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseEnvelope,
  JsonRpcServerMessage,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import type {
  MethodDescriptor,
  SubscriptionMethodDescriptor,
} from "@ai-sidekicks/contracts/method-descriptor";
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  SUBSCRIPTION_CANCEL_METHOD,
  SUBSCRIPTION_END_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
  SubscriptionCancelResultSchema,
  SubscriptionEndParamsSchema,
  SubscriptionIdSchema,
  type SubscriptionId,
  SubscriptionNotifyParamsSchema,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { z } from "zod";
import type { ZodType } from "zod";

// The transport and the subscription handle

/**
 * The byte-frame transport a `JsonRpcClient` runs over. An implementation owns the connection (Unix
 * socket, Windows named pipe, in-memory double), the framing (`FrameAccumulator` and `encodeFrame`
 * from `@ai-sidekicks/contracts/content-length-framing`, which the daemon uses too), and
 * backpressure on outbound writes. The client works on JSON-RPC envelopes above the framing and
 * never sees bytes.
 */
export interface ClientTransport {
  /**
   * Send a JSON-RPC envelope to the daemon: JSON-encode it, frame it with the LSP
   * `Content-Length: <bytes>\r\n\r\n<body>` header, and write the bytes.
   *
   * The return may be synchronous, a native promise (a socket write that awaits drain) or any
   * thenable; callers wrap it in `Promise.resolve` because `PromiseLike` guarantees only `.then`.
   */
  send(envelope: JsonRpcRequest | JsonRpcNotification): void | PromiseLike<void>;

  /**
   * Register the inbound message dispatcher. The transport calls it exactly once per parsed
   * envelope, either a response to an outbound request (told apart by `"id" in message`) or a
   * notification such as `$/subscription/notify`. A single client owns the inbound stream, so an
   * implementation should throw if this is called more than once.
   */
  onMessage(handler: (message: JsonRpcServerMessage) => void): void;

  /**
   * Register a close observer, called exactly once when the transport disconnects. `reason`
   * carries the underlying error; a clean shutdown passes `undefined`. The client rejects every
   * in-flight request with a transport-closed error.
   */
  onClose(handler: (reason?: Error) => void): void;

  /**
   * Shut the transport down; resolves once the connection is fully torn down. Afterward the
   * `onClose` handler has fired, `send()` must throw, and the instance is single-use.
   */
  close(): Promise<void>;
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

// Typed error classes

/**
 * Thrown when the daemon returns a JSON-RPC error response. `code` is the numeric error code,
 * `message` the daemon-sanitized text, and `data` the optional structured `{ type, fields? }`.
 * Distinct from `JsonRpcSchemaError`, which flags validation failures inside the SDK.
 */
export class JsonRpcRemoteError extends Error {
  /** The JSON-RPC numeric error code. */
  public readonly code: number;
  /**
   * The structured `{ type, fields? }` from the wire's `error.data`, or `undefined` for a bare
   * numeric error. Switch on the dotted `data.type` rather than the coarse numeric `code`.
   */
  public readonly data: JsonRpcErrorData | undefined;

  public constructor(code: number, message: string, data: JsonRpcErrorData | undefined) {
    super(message);
    this.name = "JsonRpcRemoteError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Thrown when Zod validation fails at the SDK boundary. `phase` says which surface failed:
 * caller `params` (caller bug, nothing was sent), daemon `result`, or streaming `value` (both
 * mean the daemon sent malformed data).
 */
export class JsonRpcSchemaError extends Error {
  /** Which validation surface failed. */
  public readonly phase: "params" | "result" | "value";
  /** The originating Zod issue payload (raw `ZodError.issues`). */
  public readonly issues: ReadonlyArray<unknown>;

  public constructor(phase: "params" | "result" | "value", message: string, issues: unknown) {
    super(message);
    this.name = "JsonRpcSchemaError";
    this.phase = phase;
    this.issues = Array.isArray(issues) ? issues : [];
  }
}

/**
 * Thrown by every in-flight `call` and `next()` when the transport disconnects. `cause` carries
 * the transport's reason; it is unset for a clean shutdown.
 */
export class JsonRpcTransportClosedError extends Error {
  public constructor(reason: Error | undefined) {
    super(
      reason !== undefined ? `Transport closed: ${reason.message}` : "Transport closed",
      reason !== undefined ? { cause: reason } : undefined,
    );
    this.name = "JsonRpcTransportClosedError";
  }
}

/**
 * Ends a subscription whose consumer left `maxQueuedValues` values unread. The client canceled it
 * on the daemon; values queued before the overflow are still delivered first.
 */
export class JsonRpcSubscriptionOverflowError extends Error {
  /** The bound the consumer reached, from `JsonRpcClientOptions.maxQueuedValuesPerSubscription`. */
  public readonly maxQueuedValues: number;

  public constructor(maxQueuedValues: number) {
    super(
      `${String(maxQueuedValues)} unread values filled the subscription's queue; it was canceled.`,
    );
    this.name = "JsonRpcSubscriptionOverflowError";
    this.maxQueuedValues = maxQueuedValues;
  }
}

// Pending request entry

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  /**
   * Set for a subscribe-init request. `#handleResponse` registers the subscription synchronously
   * so a response and its first `$/subscription/notify`, parsed from one transport read, do not
   * lose the notification to the unknown-id drop. Registration is skipped if the consumer already
   * canceled.
   *
   * A required `| undefined` rather than optional, so `exactOptionalPropertyTypes` narrows
   * correctly.
   */
  readonly subscriptionInitState: SubscriptionState<unknown> | undefined;
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

interface SubscriptionState<T> {
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
class LocalSubscriptionHandle<T> implements LocalSubscriptionConsumer<T> {
  readonly #state: SubscriptionState<T>;
  readonly #cancel: () => Promise<void>;

  public constructor(state: SubscriptionState<T>, cancelFn: () => Promise<void>) {
    this.#state = state;
    this.#cancel = cancelFn;
  }

  public get subscriptionId(): string {
    return this.#state.subscriptionId;
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
 * validated `value` against `state.valueSchema`; `#handleNotification` does that with the wrapper
 * schema. Only a registered subscription receives values, and a registered one is always active:
 * every path that ends it also untracks it, before any value can arrive.
 */
function pushSubscriptionValue<T>(state: SubscriptionState<T>, value: T): void {
  const waiter = state.waiters.shift();
  if (waiter !== undefined) {
    waiter.resolve(value);
    return;
  }
  state.queue.push(value);
}

/** Ends a subscription cleanly and resolves every waiter with `undefined`. Idempotent. */
function completeSubscription<T>(state: SubscriptionState<T>): void {
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
function completeSubscriptionWithError<T>(state: SubscriptionState<T>, error: Error): void {
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

// JsonRpcClient

/** Constructor options for `JsonRpcClient`. */
export interface JsonRpcClientOptions {
  /**
   * The protocol version sent on every request envelope (ISO 8601 `YYYY-MM-DD`). Required: the
   * daemon rejects a non-handshake request without a valid one. There is no default because the
   * version is negotiated with `daemon.hello`; the caller passes the acknowledged version, and
   * the handshake request itself is exempt from the check.
   */
  readonly protocolVersion: string;
  /**
   * The most values one subscription holds unread. When a value arrives with the queue full and no
   * `next()` waiting, the subscription is canceled on the daemon and ends with
   * `JsonRpcSubscriptionOverflowError`. Required because the right bound depends on the caller's
   * workload: how large its values are and how far behind its consumer may fall.
   */
  readonly maxQueuedValuesPerSubscription: number;
}

/**
 * Typed JSON-RPC client for one `ClientTransport`, with `call<P, R>` and `subscribe<P, T>`. The
 * constructor registers the transport's inbound and close handlers, so use one client per
 * transport.
 */
export class JsonRpcClient {
  readonly #transport: ClientTransport;
  readonly #protocolVersion: string;
  readonly #maxQueuedValuesPerSubscription: number;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #subscriptions = new Map<string, SubscriptionState<unknown>>();
  #nextId = 1;
  #closed = false;
  #closeReason: Error | undefined = undefined;

  public constructor(transport: ClientTransport, opts: JsonRpcClientOptions) {
    this.#transport = transport;
    this.#protocolVersion = opts.protocolVersion;
    this.#maxQueuedValuesPerSubscription = opts.maxQueuedValuesPerSubscription;

    // The transport allows one inbound handler; this is it.
    transport.onMessage((message) => {
      this.#handleInbound(message);
    });

    // Closing rejects all in-flight requests and ends all subscriptions.
    transport.onClose((reason) => {
      this.#handleClose(reason);
    });
  }

  /**
   * Issues a typed JSON-RPC request and resolves with the validated result.
   *
   * @throws JsonRpcSchemaError when `params` fail `paramsSchema` (phase `"params"`, nothing sent)
   *   or the result fails `resultSchema` (phase `"result"`).
   * @throws JsonRpcRemoteError when the daemon answers with an error.
   * @throws JsonRpcTransportClosedError when the transport is or becomes closed.
   */
  public async call<P, R>(
    method: string,
    params: P,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
  ): Promise<R> {
    return this.#issueRequest(method, params, paramsSchema, resultSchema, undefined);
  }

  /**
   * Shared pipeline for `call` and `subscribe`: validate params, allocate an id, park a pending
   * entry and send. `subscriptionInitState` is carried on the entry so `#handleResponse` can
   * register the subscription synchronously.
   */
  async #issueRequest<P, R>(
    method: string,
    params: P,
    paramsSchema: ZodType<P>,
    resultSchema: ZodType<R>,
    subscriptionInitState: SubscriptionState<unknown> | undefined,
  ): Promise<R> {
    // Fail fast on bad params before any wire I/O.
    const paramsParsed = paramsSchema.safeParse(params);
    if (!paramsParsed.success) {
      throw paramsSchemaError(method, paramsParsed.error.issues);
    }

    // Refuse calls made after close so callers see a typed error.
    if (this.#closed) {
      throw new JsonRpcTransportClosedError(this.#closeReason);
    }

    const id = this.#allocateId();
    const envelope = this.#buildRequestEnvelope(id, method, paramsParsed.data);

    // Park the entry before sending so a transport that answers synchronously cannot beat it.
    return new Promise<R>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (raw: unknown) => {
          // Validate the result before resolving the caller.
          const resultParsed = resultSchema.safeParse(raw);
          if (!resultParsed.success) {
            reject(
              new JsonRpcSchemaError(
                "result",
                `Response result for ${method} failed schema validation`,
                resultParsed.error.issues,
              ),
            );
            return;
          }
          resolve(resultParsed.data);
        },
        reject,
        subscriptionInitState,
      });

      // If send fails, drop the pending entry and surface the error.
      try {
        const sendResult = this.#transport.send(envelope);
        // `send` may return a cross-realm Promise or a non-native thenable, so test for `then`
        // instead of `instanceof Promise`.
        if (
          sendResult !== undefined &&
          sendResult !== null &&
          typeof (sendResult as { then?: unknown }).then === "function"
        ) {
          // A thenable may lack `.catch`; a direct call would throw here and delete the
          // pending entry even though the send may have succeeded.
          // `Promise.resolve` turns any thenable into a native Promise.
          Promise.resolve(sendResult as PromiseLike<void>).catch((err: unknown) => {
            this.#pending.delete(id);
            reject(asError(err));
          });
        }
      } catch (err) {
        this.#pending.delete(id);
        reject(asError(err));
      }
    });
  }

  /**
   * Opens a typed streaming subscription. Returns the handle synchronously; `subscriptionId` is
   * empty until the init response arrives, which happens before the first value resolves, so do
   * not read it synchronously. Each `$/subscription/notify` value is validated against
   * `valueSchema` before it is queued.
   *
   * @throws JsonRpcSchemaError when `params` fail `paramsSchema` (phase `"params"`), thrown from
   *   this call before anything is sent, so a bad request never yields a live-looking handle.
   */
  public subscribe<P, T>(
    method: string,
    params: P,
    paramsSchema: ZodType<P>,
    valueSchema: ZodType<T>,
  ): LocalSubscriptionConsumer<T> {
    const paramsParsed = paramsSchema.safeParse(params);
    if (!paramsParsed.success) {
      throw paramsSchemaError(method, paramsParsed.error.issues);
    }

    const state: SubscriptionState<T> = {
      status: "pending",
      subscriptionId: "",
      valueSchema,
      queue: [],
      waiters: [],
      error: undefined,
      cancelInFlight: undefined,
    };

    // Cast through `unknown`: `T` sits in a contravariant position on the waiter callbacks, so
    // `SubscriptionState<T>` is not assignable to `SubscriptionState<unknown>`. The map only
    // routes by id.
    const dispatcherState = state as unknown as SubscriptionState<unknown>;

    // Going through `#issueRequest` lets `#handleResponse` register the subscription
    // synchronously, so a valid init needs no handling here: a registration deferred to a later
    // microtask would lose a notification that arrives in the same transport read as the response.
    const initAck = this.#issueRequest(
      method,
      paramsParsed.data,
      passthroughSchema,
      subscribeInitResultSchema,
      dispatcherState,
    );
    void initAck.catch((err: unknown) => {
      completeSubscriptionWithError(state, asError(err));
    });

    return new LocalSubscriptionHandle<T>(state, () => this.#cancelSubscription(state, initAck));
  }

  // Internals

  #allocateId(): number {
    const id = this.#nextId;
    this.#nextId += 1;
    return id;
  }

  #buildRequestEnvelope(id: JsonRpcId, method: string, params: unknown): JsonRpcRequest {
    // `params` is omitted when undefined; `protocolVersion` is always sent.
    const envelope: JsonRpcRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      protocolVersion: this.#protocolVersion,
      ...(params !== undefined ? { params } : {}),
    };
    return envelope;
  }

  #handleInbound(message: JsonRpcServerMessage): void {
    // Only responses carry an `id`.
    if ("id" in message) {
      this.#handleResponse(message);
      return;
    }
    this.#handleNotification(message);
  }

  #handleResponse(response: JsonRpcResponseEnvelope): void {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      // Unknown id: drop it rather than crash on a misbehaving peer.
      return;
    }
    this.#pending.delete(response.id);
    if ("error" in response) {
      pending.reject(
        new JsonRpcRemoteError(response.error.code, response.error.message, response.error.data),
      );
      return;
    }

    // Register a subscribe-init subscription right here, not in a later microtask. The daemon
    // writes the init response before the first notify, and a stream socket can deliver both in
    // one read, so `#handleNotification` runs before any microtask. Parsing with the same
    // schema as the resolve path keeps a malformed init from ever registering. Skipped when the
    // consumer already canceled; that cancel sends the wire cancel once the id is known.
    if (pending.subscriptionInitState !== undefined) {
      const initParse = subscribeInitResultSchema.safeParse(response.result);
      const state = pending.subscriptionInitState;
      if (initParse.success && state.cancelInFlight === undefined) {
        const sid = initParse.data.subscriptionId;
        state.subscriptionId = sid;
        state.status = "active";
        this.#subscriptions.set(sid, state);
      }
    }

    pending.resolve(response.result);
  }

  #handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === SUBSCRIPTION_END_METHOD) {
      this.#handleEnd(notification.params);
      return;
    }
    if (notification.method !== SUBSCRIPTION_NOTIFY_METHOD) {
      // Only the subscription frames are understood; drop anything else.
      return;
    }
    // Route by `subscriptionId` first, then validate the whole frame against the schema of
    // the subscription it belongs to, so the value keeps its type `T`.
    const params = notification.params;
    if (typeof params !== "object" || params === null) {
      return;
    }
    const subscriptionIdRaw = (params as { subscriptionId?: unknown }).subscriptionId;
    if (typeof subscriptionIdRaw !== "string" || subscriptionIdRaw.length === 0) {
      return;
    }
    const state = this.#subscriptions.get(subscriptionIdRaw);
    if (state === undefined) {
      // A notification for a subscription we no longer track (canceled, failed init): drop.
      return;
    }
    // One parse validates the wrapper and the per-subscription `value`.
    const wrapperSchema = SubscriptionNotifyParamsSchema(state.valueSchema);
    const parsed = wrapperSchema.safeParse(params);
    // A failed value or a full queue ends the subscription and cancels it on the daemon. No
    // cancel can be in flight here: every cancel untracks the subscription first.
    if (!parsed.success) {
      state.cancelInFlight = this.#emitCancelRpc(
        state,
        new JsonRpcSchemaError(
          "value",
          "Streaming notification frame failed schema validation",
          parsed.error.issues,
        ),
      );
      return;
    }
    if (state.waiters.length === 0 && state.queue.length >= this.#maxQueuedValuesPerSubscription) {
      state.cancelInFlight = this.#emitCancelRpc(
        state,
        new JsonRpcSubscriptionOverflowError(this.#maxQueuedValuesPerSubscription),
      );
      return;
    }
    // The wrapper parse already validated `value` against `state.valueSchema`.
    pushSubscriptionValue(state, parsed.data.value);
  }

  // The daemon ended a subscription: queued values stay readable, then `next()` returns
  // `undefined` for `completed` or rejects with the daemon's error for `refused`. The daemon has
  // already dropped it, so no cancel is sent; a frame for an id no longer tracked is dropped.
  #handleEnd(params: unknown): void {
    const subscriptionIdRaw =
      typeof params === "object" && params !== null
        ? (params as { subscriptionId?: unknown }).subscriptionId
        : undefined;
    const state =
      typeof subscriptionIdRaw === "string"
        ? this.#subscriptions.get(subscriptionIdRaw)
        : undefined;
    if (state === undefined) {
      return;
    }
    this.#subscriptions.delete(state.subscriptionId);
    const parsed = SubscriptionEndParamsSchema.safeParse(params);
    if (!parsed.success) {
      completeSubscriptionWithError(
        state,
        new JsonRpcSchemaError(
          "value",
          "Streaming end frame failed schema validation",
          parsed.error.issues,
        ),
      );
      return;
    }
    if (parsed.data.reason === "completed") {
      completeSubscription(state);
      return;
    }
    const { code, message, data } = parsed.data.error;
    completeSubscriptionWithError(state, new JsonRpcRemoteError(code, message, data));
  }

  #handleClose(reason: Error | undefined): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeReason = reason;

    const transportError = new JsonRpcTransportClosedError(reason);

    for (const [, entry] of this.#pending) {
      entry.reject(transportError);
    }
    this.#pending.clear();

    // A non-clean close errors the subscriptions; a clean one completes them.
    for (const [, state] of this.#subscriptions) {
      if (reason !== undefined) {
        completeSubscriptionWithError(state, transportError);
      } else {
        completeSubscription(state);
      }
    }
    this.#subscriptions.clear();
  }

  /**
   * Cancels a subscription on the daemon and resolves once that settles; safe to call repeatedly.
   * Terminal state returns immediately and a cancel already in flight is awaited rather than sent
   * twice. Before the init response there is no id to cancel, so it waits for the init and then
   * cancels on the wire; an init that fails ends the subscription with that error instead.
   */
  async #cancelSubscription<T>(
    state: SubscriptionState<T>,
    initAck: Promise<{ subscriptionId: SubscriptionId }>,
  ): Promise<void> {
    if (state.status === "completed" || state.status === "errored") {
      return;
    }
    if (state.cancelInFlight !== undefined) {
      return state.cancelInFlight;
    }
    // Stored before any await so a concurrent caller sees it.
    state.cancelInFlight =
      state.status === "pending"
        ? initAck.then(
            (ack) => {
              state.subscriptionId = ack.subscriptionId;
              return this.#emitCancelRpc(state, undefined);
            },
            (err: unknown) => {
              completeSubscriptionWithError(state, asError(err));
            },
          )
        : this.#emitCancelRpc(state, undefined);
    return state.cancelInFlight;
  }

  /**
   * Untracks a subscription, sends its wire cancel and ends it: with `endingError` when the client
   * ends it for a failure, cleanly otherwise. A failed cancel is recorded as the terminal error, as
   * the `cause` of `endingError` when there is one.
   */
  async #emitCancelRpc<T>(
    state: SubscriptionState<T>,
    endingError: Error | undefined,
  ): Promise<void> {
    // Untracked before the wire cancel, so frames racing it hit the unknown-id drop.
    this.#subscriptions.delete(state.subscriptionId);
    try {
      await this.call(
        SUBSCRIPTION_CANCEL_METHOD,
        { subscriptionId: state.subscriptionId },
        // The id was validated when the init registered it; the daemon validates the params.
        passthroughSchema,
        SubscriptionCancelResultSchema,
      );
    } catch (err) {
      completeSubscriptionWithError(
        state,
        endingError === undefined ? asError(err) : withCancelFailure(endingError, err),
      );
      return;
    }
    if (endingError === undefined) {
      completeSubscription(state);
    } else {
      completeSubscriptionWithError(state, endingError);
    }
  }
}

/**
 * Calls one daemon method by its contract descriptor, so the method name and both schemas come
 * from the table the daemon registers from.
 */
export function callMethod<RequestType, ResponseType>(
  client: JsonRpcClient,
  descriptor: MethodDescriptor<string, RequestType, ResponseType>,
  params: RequestType,
): Promise<ResponseType> {
  return client.call(
    descriptor.method,
    params,
    descriptor.requestSchema,
    descriptor.responseSchema,
  );
}

/**
 * Opens one daemon subscription by its contract descriptor: params are checked against its request
 * schema and each value against its emission schema.
 *
 * @throws JsonRpcSchemaError when `params` fail the request schema, before anything is sent.
 */
export function subscribeMethod<RequestType, EmissionType>(
  client: JsonRpcClient,
  descriptor: SubscriptionMethodDescriptor<string, RequestType, unknown, EmissionType>,
  params: RequestType,
): LocalSubscriptionConsumer<EmissionType> {
  return client.subscribe(
    descriptor.method,
    params,
    descriptor.requestSchema,
    descriptor.emissionSchema,
  );
}

/**
 * The error a subscription ends with when canceling it failed too: `error` carrying the cancel's
 * failure as `cause` when it has none yet, or both in an `AggregateError`.
 */
export function withCancelFailure<ErrorType>(
  error: ErrorType,
  cancelFailure: unknown,
): ErrorType | AggregateError {
  if (cancelFailure === undefined || cancelFailure === error) {
    return error;
  }
  if (error instanceof Error && error.cause === undefined) {
    error.cause = cancelFailure;
    return error;
  }
  return new AggregateError(
    [error, cancelFailure],
    "The subscription failed, and canceling it failed too.",
  );
}

function paramsSchemaError(method: string, issues: unknown): JsonRpcSchemaError {
  return new JsonRpcSchemaError(
    "params",
    `Request params for ${method} failed schema validation`,
    issues,
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// Internal helper schemas

/** Accepts any value; used for params already validated or validated by the daemon. */
const passthroughSchema: ZodType<unknown> = z.unknown();

/**
 * Subscribe-init response: at least `{ subscriptionId }` as a UUID. `.loose()` lets a handler add
 * fields (such as a cursor) that the typed wrappers read. `#handleResponse` uses this same schema,
 * so registration and validation cannot disagree.
 */
const subscribeInitResultSchema: ZodType<{ subscriptionId: SubscriptionId }> = z
  .object({
    subscriptionId: SubscriptionIdSchema,
  })
  .loose();
