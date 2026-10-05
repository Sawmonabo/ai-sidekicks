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
  SessionId,
  SessionReadRequest,
  SessionReadResponse,
  SessionStreamFrame,
} from "@ai-sidekicks/contracts/session/session";
import type {
  SessionCreateRequest,
  SessionCreateResponse,
} from "@ai-sidekicks/contracts/session/directory";
import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";
import { SESSION_DIRECTORY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/directory";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/session";

import {
  callMethod,
  subscribeMethod,
  withCancelFailure,
  type JsonRpcClient,
} from "./transport/json-rpc-client.js";
import type { LocalSubscriptionConsumer } from "./transport/types.js";

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
 * again with it as `afterCursor` catches up on exactly the missing events and on.
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

/**
 * Subscribe options. Without `afterCursor` the daemon catches up from the start of the session;
 * with it, from the event strictly after that cursor. `signal` cancels the subscription early and
 * releases the daemon's subscription entry.
 */
export interface SessionSubscribeOptions {
  readonly sessionId: SessionId;
  readonly afterCursor?: EventCursor | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The typed session operations a client calls on the daemon. */
export interface SessionClient {
  /** Create a session with its lead; resolves with the new session's id and starting state. */
  create(request: SessionCreateRequest): Promise<SessionCreateResponse>;
  /** Read one session's snapshot from the daemon's record, never from a client cache. */
  read(request: SessionReadRequest): Promise<SessionReadResponse>;
  /**
   * Follow one session's events in ascending order. Each call opens a fresh daemon subscription;
   * the iteration ends in `SessionStreamDroppedError` when the daemon dropped changes for it.
   */
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
      callMethod(client, SESSION_DIRECTORY_METHOD_DESCRIPTORS["session.create"], request),
    read: (request) => callMethod(client, SESSION_METHOD_DESCRIPTORS["session.read"], request),
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

  const subscription = subscribeMethod(
    client,
    SESSION_DIRECTORY_METHOD_DESCRIPTORS["session.subscribe"],
    params,
  );

  // A listener, not a check inside the loop: the consumer parks on `next()` between values, so a
  // loop check would only fire after the next value lands. `cancel()` never rejects: a failed
  // cancel ends the subscription with its error, which that parked `next()` then throws.
  let abortListener: (() => void) | undefined;
  if (options.signal !== undefined) {
    const sig = options.signal;
    abortListener = (): void => {
      void subscription.cancel();
    };
    sig.addEventListener("abort", abortListener, { once: true });
    // The signal may have aborted before the listener was added; without this re-check the
    // subscription stays live and the loop parks forever on a canceled stream.
    if (sig.aborted) {
      sig.removeEventListener("abort", abortListener);
      // Over a socket the subscribe reply has not arrived yet, so this cancel waits for it and
      // then cancels on the wire.
      const cancelFailure = await cancelAndReadFailure(subscription);
      if (cancelFailure !== undefined) {
        throw cancelFailure;
      }
      return;
    }
  }

  // Frames are pulled with `next()` rather than `for await`: leaving a `for await` on a throw
  // cancels the subscription itself and discards that cancel's failure.
  let loopThrew = false;
  try {
    let lastCursor = options.afterCursor;
    // A canceled subscription still hands back queued frames, so the abort is read before each
    // frame and change, through a function: a property read stays narrowed to false across `yield`.
    const consumerAborted = (): boolean => options.signal?.aborted === true;
    for (let frame = await subscription.next(); frame !== undefined && !consumerAborted(); ) {
      // The drop mark rides the first frame after the gap, so it is raised
      // before that frame's changes: yielding them would hide the hole.
      if (frame.dropped === true) {
        throw new SessionStreamDroppedError(lastCursor);
      }
      for (const change of frame.changes) {
        if (consumerAborted()) {
          return;
        }
        lastCursor = change.cursor;
        yield { eventId: change.cursor, event: change.event };
      }
      frame = await subscription.next();
    }
  } catch (loopError) {
    loopThrew = true;
    throw withCancelFailure(loopError, await cancelAndReadFailure(subscription));
  } finally {
    if (abortListener !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener("abort", abortListener);
    }
    // A completed stream and the consumer's `break` leave through here alone; `break` reaches no
    // other block, so a failed cancel can surface only by being thrown here.
    if (!loopThrew) {
      const cancelFailure = await cancelAndReadFailure(subscription);
      if (cancelFailure !== undefined) {
        // eslint-disable-next-line no-unsafe-finally -- a failure after `break` surfaces only here
        throw cancelFailure;
      }
    }
  }
}

/**
 * Cancels the subscription and returns the error it ended with, or `undefined` when it ended
 * cleanly. `cancel()` records a failed cancel on the subscription rather than rejecting, so the
 * error is read by draining it: once canceled, `next()` hands back any queued frames, which the
 * stream no longer wants, and then ends or throws the error.
 */
async function cancelAndReadFailure(
  subscription: LocalSubscriptionConsumer<SessionStreamFrame<SessionEvent>>,
): Promise<unknown> {
  await subscription.cancel();
  try {
    while ((await subscription.next()) !== undefined) {
      // A frame queued before the cancel; the stream has ended, so it is not yielded.
    }
  } catch (subscriptionError) {
    return subscriptionError;
  }
  return undefined;
}
