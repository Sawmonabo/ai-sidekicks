// The typed `session.*` client over the daemon transport: `create`, `read`
// and `subscribe`, wrapping a caller-built `JsonRpcClient`.
//
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
 * Subscribe options. Without `afterCursor` the daemon replays from the start of the session; with
 * it, from the event strictly after that cursor. `signal` cancels the subscription early and
 * releases the daemon's subscription entry.
 */
export interface SessionSubscribeOptions {
  readonly sessionId: SessionId;
  readonly afterCursor?: EventCursor | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The `session.*` JSON-RPC method names the daemon registers. */
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
 * Adapts `JsonRpcClient.subscribe` into an `AsyncIterable<SessionEventEnvelope>`: unpacks each
 * frame into its changes, ends on a drop mark, and cancels the subscription on `break` or abort.
 */
async function* daemonSubscribe(
  client: JsonRpcClient,
  options: SessionSubscribeOptions,
): AsyncIterable<SessionEventEnvelope> {
  // An already-aborted signal must not touch the wire: `client.subscribe` sends the request and
  // reserves a daemon-side subscription entry synchronously.
  if (options.signal?.aborted === true) {
    return;
  }

  // Spread conditionally so an omitted `afterCursor` stays off the request under
  // `exactOptionalPropertyTypes`.
  const params = {
    sessionId: options.sessionId,
    ...(options.afterCursor !== undefined ? { afterCursor: options.afterCursor } : {}),
  };

  const subscription = client.subscribe<SessionStreamFrame<SessionEvent>>(
    SESSION_METHOD_SUBSCRIBE,
    params,
    SESSION_STREAM_FRAME_SCHEMA,
  );

  // A listener, not a check inside the loop: the consumer parks on `next()` between values, so a
  // loop check would only fire after the next value lands.
  let abortListener: (() => void) | undefined;
  if (options.signal !== undefined) {
    const sig = options.signal;
    abortListener = (): void => {
      void subscription.cancel().catch(() => undefined);
    };
    sig.addEventListener("abort", abortListener, { once: true });
    // The signal may have aborted before the listener was added; without this re-check the
    // subscription stays live and the loop parks forever on a canceled stream.
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
    // Cancel is idempotent; this covers the early-throw path.
    await subscription.cancel().catch(() => undefined);
  }
}
