// The client-side transport contract: type-only, so it emits as a `.d.ts`.
//
// `LocalSubscriptionConsumer<T>` here is deliberately not the server-side
// `LocalSubscriptionProducer<T>` in `@ai-sidekicks/contracts`. The producer is what a daemon
// handler emits values into (`next(value)`, `complete()`, `cancel()`); the consumer is what an SDK
// caller pulls values out of (`next()`, `cancel()`, `[Symbol.asyncIterator]()`). The two shapes are
// not structurally compatible.

import type {
  HandlerContext,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseEnvelope,
} from "@ai-sidekicks/contracts";

/**
 * The byte-frame transport a `JsonRpcClient` runs over. An implementation owns the connection (Unix
 * socket, Windows named pipe, in-memory double), the framing (the same rules as the daemon's
 * `parseFrame` in `content-length-framing.ts` and `encodeFrame` in `local-ipc-gateway.ts`), and
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
   * envelope, either a response to an outbound request (told apart by `"id" in msg`) or a
   * notification such as `$/subscription/notify`. A single client owns the inbound stream, so an
   * implementation should throw if this is called more than once.
   */
  onMessage(handler: (msg: JsonRpcResponseEnvelope | JsonRpcNotification) => void): void;

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
 * The handle `JsonRpcClient.subscribe` returns synchronously. Each validated
 * `$/subscription/notify` value lands in one bounded internal queue that `next()` and `for await`
 * both drain; `cancel()` sends `$/subscription/cancel` and awaits the ack.
 *
 * The stream completes with `undefined` (after the queue drains) on a server cancel or a client
 * `cancel()`. `next()` rejects with the transport's close reason when the transport drops, and
 * with `JsonRpcSubscriptionOverflowError` when the consumer let the queue fill.
 */
export interface LocalSubscriptionConsumer<T> {
  /**
   * The daemon-issued subscription id: `""` until the initial response arrives, and populated
   * before the first `next()` or iterator tick settles. Do not read it synchronously after
   * `subscribe()` returns. A plain `string`; use `SubscriptionIdSchema` from
   * `@ai-sidekicks/contracts` to get the branded type.
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

/**
 * A typed JSON-RPC handler function, structurally identical to `Handler<P, R>` in
 * `@ai-sidekicks/contracts`. The registry has already validated `params` against the registered
 * schema, and it validates the resolved `Res` before replying. The SDK itself never invokes one:
 * the client calls handlers over the wire.
 */
export type Handler<Req, Res> = (params: Req, ctx: HandlerContext) => Promise<Res>;
