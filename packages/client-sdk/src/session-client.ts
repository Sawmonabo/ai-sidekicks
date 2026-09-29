// The typed `session.*` client over the daemon transport: `create`, `read`
// and `subscribe`, wrapping a caller-built `JsonRpcClient`.
//
//   * `create()` returns a session id; `read()` against the same id returns the
//     same session.
//   * `subscribe()` yields events in ascending sequence and resumes strictly
//     after a consumer-held `afterCursor` on reconnect. The daemon sends them
//     in frames; a frame marking that changes were dropped for this connection
//     ends the iteration with `SessionStreamDroppedError`, and resubscribing
//     after its `lastCursor` fills the gap from the daemon's record.
//   * A reconnect restores from the daemon's authoritative projection:
//     `subscribe()` issues a fresh wire request on every call and the client
//     holds no event cache, so it never shadows the server's state.
//
// Byte-level framing and the socket or pipe stay with the caller's
// `ClientTransport`.

import type {
  EventCursor,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionEvent,
  SessionId,
  SessionReadRequest,
  SessionReadResponse,
  SessionStreamFrame,
} from "@ai-sidekicks/contracts";
import {
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  SessionEventSchema,
  SessionReadRequestSchema,
  SessionReadResponseSchema,
  SessionStreamFrameSchema,
} from "@ai-sidekicks/contracts";

import type { JsonRpcClient } from "./transport/json-rpc-client.js";

/**
 * One delivered session event with the cursor the consumer retains for an
 * `afterCursor` reconnect.
 */
export interface SessionEventEnvelope {
  readonly eventId: EventCursor;
  readonly event: SessionEvent;
}

/**
 * Ends a session subscription whose connection fell behind: the daemon dropped
 * changes for it rather than wait. `lastCursor` is the cursor of the last event
 * this subscription delivered (or the one it started after), so subscribing
 * again with it as `afterCursor` replays exactly the missing events and on.
 */
export class SessionStreamDroppedError extends Error {
  readonly lastCursor: EventCursor | undefined;

  constructor(lastCursor: EventCursor | undefined) {
    super(
      "The daemon dropped session changes for this subscription; resubscribe after lastCursor.",
    );
    this.name = "SessionStreamDroppedError";
    this.lastCursor = lastCursor;
  }
}

const SESSION_STREAM_FRAME_SCHEMA = SessionStreamFrameSchema(SessionEventSchema);

/**
 * Subscribe options. Without `afterCursor` the daemon replays from the start of
 * the session (within its retention window); with it, from the event strictly
 * after that cursor. `signal` cancels the subscription early and releases the
 * daemon's subscription entry.
 */
export interface SessionSubscribeOptions {
  readonly sessionId: SessionId;
  readonly afterCursor?: EventCursor | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The `session.*` JSON-RPC method names, shared with the daemon's handlers. */
const SESSION_METHOD_CREATE = "session.create";
const SESSION_METHOD_READ = "session.read";
const SESSION_METHOD_SUBSCRIBE = "session.subscribe";

/** The typed session operations a client calls on the daemon. */
export interface SessionClient {
  create(request: SessionCreateRequest): Promise<SessionCreateResponse>;
  read(request: SessionReadRequest): Promise<SessionReadResponse>;
  subscribe(options: SessionSubscribeOptions): AsyncIterable<SessionEventEnvelope>;
}

/**
 * Build a `SessionClient` over a daemon transport. The caller is responsible
 * for wiring the underlying `ClientTransport` (Unix socket, Windows named
 * pipe, in-memory test double) and instantiating the `JsonRpcClient` —
 * including completing the `daemon.hello` handshake before the first
 * mutating call.
 *
 * Daemon-side `$/subscription/notify` frames carry the `SessionEvent` with no
 * cursor envelope, so the subscription synthesizes each cursor from the
 * event's id.
 */
export function createDaemonSessionClient(client: JsonRpcClient): SessionClient {
  return {
    create: (request) =>
      client.call(
        SESSION_METHOD_CREATE,
        request,
        SessionCreateRequestSchema,
        SessionCreateResponseSchema,
      ),
    read: (request) =>
      client.call(
        SESSION_METHOD_READ,
        request,
        SessionReadRequestSchema,
        SessionReadResponseSchema,
      ),
    subscribe: (options) => daemonSubscribe(client, options),
  };
}

/**
 * Daemon-side subscribe — wraps `JsonRpcClient.subscribe` and adapts its
 * `LocalSubscriptionConsumer` of session stream frames into an
 * `AsyncIterable<SessionEventEnvelope>`. The async generator unpacks each
 * frame into its changes, ends on a drop mark, and owns signal-driven cancel (so
 * `for await ... break` releases the daemon's `StreamingPrimitive` entry
 * via `LocalSubscriptionConsumer.cancel()`).
 */
async function* daemonSubscribe(
  client: JsonRpcClient,
  options: SessionSubscribeOptions,
): AsyncIterable<SessionEventEnvelope> {
  // Pre-abort fast-exit: if the caller's signal is ALREADY aborted, do not
  // touch the wire. Returning from an async generator yields zero items, so
  // the caller's `for await` exits immediately. This keeps timeout / circuit-
  // breaker paths from spending a daemon round-trip on a subscription they
  // intend to cancel before any data flows. Must precede `client.subscribe`
  // because that call synchronously sends the `session.subscribe` envelope
  // and reserves a server-side `StreamingPrimitive` entry.
  if (options.signal?.aborted === true) {
    return;
  }

  // Conditional spread keeps `afterCursor` off the envelope under
  // `exactOptionalPropertyTypes: true` when omitted.
  const params = {
    sessionId: options.sessionId,
    ...(options.afterCursor !== undefined ? { afterCursor: options.afterCursor } : {}),
  };

  const subscription = client.subscribe<SessionStreamFrame<SessionEvent>>(
    SESSION_METHOD_SUBSCRIBE,
    params,
    SESSION_STREAM_FRAME_SCHEMA,
  );

  // Wire the caller's AbortSignal through to the subscription's cancel.
  // We use `addEventListener("abort", ...)` rather than checking
  // `signal.aborted` mid-loop because the underlying `LocalSubscriptionConsumer`
  // parks on `next()` between value arrivals — a polling check inside
  // `for await` would only fire AFTER the next value lands. (The
  // pre-aborted case is handled above before `client.subscribe` runs.)
  let abortListener: (() => void) | undefined;
  if (options.signal !== undefined) {
    const sig = options.signal;
    abortListener = (): void => {
      void subscription.cancel().catch(() => undefined);
    };
    sig.addEventListener("abort", abortListener, { once: true });
    // Race-close: if the signal aborted between the pre-abort check and this
    // addEventListener (e.g., during client.subscribe()'s synchronous envelope
    // dispatch + StreamingPrimitive reservation), the listener missed the
    // abort event. Re-check sig.aborted now and fire the same cancel path
    // the listener would have. Without this, the daemon's subscription stays
    // live and the for-await parks indefinitely on a caller-canceled stream.
    // Use truthy `sig.aborted` (NOT `=== true`) — `sig` is already narrowed to
    // `AbortSignal` by the `options.signal !== undefined` block, so TS knows
    // `sig.aborted` is `boolean`. The `=== true` discipline only matters when
    // the type might widen via optional chaining.
    if (sig.aborted) {
      sig.removeEventListener("abort", abortListener);
      void subscription.cancel().catch(() => undefined);
      return;
    }
  }

  try {
    let lastCursor = options.afterCursor;
    for await (const frame of subscription) {
      // The drop mark rides the first frame after the gap, so it is raised
      // before that frame's changes: yielding them would hide the hole.
      if (frame.dropped === true) {
        throw new SessionStreamDroppedError(lastCursor);
      }
      for (const change of frame.changes) {
        lastCursor = change.cursor;
        yield { eventId: change.cursor, event: change.event };
      }
    }
  } finally {
    if (abortListener !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener("abort", abortListener);
    }
    // `for await ... return` already invoked the iterator's `return()`,
    // which calls `subscription.cancel()`. The post-loop cancel here is
    // idempotent (per `LocalSubscriptionConsumer.cancel()`'s documented contract)
    // and covers the early-throw case.
    await subscription.cancel().catch(() => undefined);
  }
}
