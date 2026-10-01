// The console's seam onto the daemon's subscriptions. Unlike `callDaemon`, a subscription has no
// reply to bind: it answers with an unsubscribe handle and delivers frames, so each consumer
// projects every frame through the registered schema in `@ai-sidekicks/contracts`, and the payload
// here stays `unknown`. It sits in this folder, the lowest one that can hold a `PlatformBridge`,
// because features that never import each other share it.

import type { DaemonEvent, DaemonSubscribeParams } from "@ai-sidekicks/contracts";

import { type Unsubscribe } from "@renderer/lib/emitter.js";
import type { PlatformBridge } from "../platform/platform-bridge.js";
import { openObservedSubscription } from "../transport/observed-subscription.js";
import type { RUN_QUEUE_EVENT_STREAM, RUN_STATE_EVENT_STREAM } from "./session-event-streams.js";

/**
 * The provider-account registry's live tail.
 *
 * Node-scoped and takes no parameters, so no filter can second-guess the registry's scope. It
 * carries a wire notification, not a session event: a node-local act by the person on a node-local
 * registry belongs to no session's audit timeline.
 */
export const PROVIDER_ACCOUNT_SUBSCRIBE_STREAM = "providerAccount.subscribe";

/**
 * One daemon subscription: the stream's method name and the registered request that scopes it.
 * Both run streams require a `sessionId`, so the request is not optional and an unscoped open
 * cannot be spelled.
 */
export interface DaemonStreamOpen<StreamName extends RunStreamName> {
  /** The registered stream name: the run-state stream or the queue stream. */
  readonly method: StreamName;
  /** The registered request, forwarded to the daemon as the subscription's scope. */
  readonly request: DaemonSubscribeParams<StreamName>;
}

/** A node-scoped daemon subscription: its registered request scopes it to this machine. */
export function subscribeNodeDaemon<StreamName extends DaemonEvent>(
  bridge: PlatformBridge,
  streamName: StreamName,
  request: DaemonSubscribeParams<StreamName>,
  handler: (payload: unknown) => void,
): Unsubscribe {
  return openStream(bridge, streamName, request, handler);
}

/**
 * A session-scoped daemon subscription, forwarding the registered request as its scope.
 *
 * @consumedBy the run queue's and run state's live feeds
 */
export function subscribeDaemon<StreamName extends RunStreamName>(
  bridge: PlatformBridge,
  stream: DaemonStreamOpen<StreamName>,
  handler: (payload: unknown) => void,
): Unsubscribe {
  return openStream(bridge, stream.method, stream.request, handler);
}

/** The two session-scoped run streams a feature opens through {@link subscribeDaemon}. */
type RunStreamName = typeof RUN_STATE_EVENT_STREAM | typeof RUN_QUEUE_EVENT_STREAM;

/**
 * The one call into `daemon.subscribe`. The open is also reported to
 * `transport/observed-subscription.ts`, so any stream opening can show the transport is back.
 */
function openStream<StreamName extends DaemonEvent>(
  bridge: PlatformBridge,
  streamName: StreamName,
  request: DaemonSubscribeParams<StreamName>,
  handler: (payload: unknown) => void,
): Unsubscribe {
  return openObservedSubscription(bridge.transportReconnect, () =>
    bridge.daemon.subscribe(streamName, request, handler),
  );
}
