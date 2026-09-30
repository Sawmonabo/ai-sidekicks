// The console's one seam onto the daemon's SUBSCRIPTIONS, and the stream names it
// opens through it.
//
// A SIBLING OF `callDaemon` AND NOT A HALF OF IT. `daemon-reply.ts` answers for
// calls: one request, one reply, parsed against the shape the corpus registers for
// the method. A subscription has no reply to bind — it answers with an unsubscribe
// handle and delivers frames afterwards — so a stream is projected PER FRAME by its
// consumer rather than parsed once here, which is a different failure mode with a
// different owner. Folding the two into one module would give one file two jobs.
//
// WHY IT LIVES IN `services/daemon/` RATHER THAN BESIDE ITS FIRST CALLER. The queue
// feed and the provider-account quota feed both open streams, and they belong to
// different features, which never import each other, so the helper they share sits
// in the lowest folder that can hold a `PlatformBridge`: this one.
//
// WHAT THE PAYLOAD TYPE ADMITS. Every stream name is a `DaemonEvent`, a subscription
// in the daemon's method map. The delivered payload is left `unknown`: every consumer
// projects each frame through the registered schema in `@ai-sidekicks/contracts`
// before rendering a figure from it. The two run-stream names are
// `session-event-streams.ts`'s, the one place a subscription name is spelled.

import type { DaemonEvent, DaemonSubscribeParams } from "@ai-sidekicks/contracts";

import { type Unsubscribe } from "@renderer/lib/emitter.js";
import type { PlatformBridge } from "../platform/platform-bridge.js";
import { openObservedSubscription } from "../transport/observed-subscription.js";
import type { RUN_QUEUE_EVENT_STREAM, RUN_STATE_EVENT_STREAM } from "./session-event-streams.js";

/**
 * The provider-account registry's live tail.
 *
 * Read-shaped, node-scoped, and takes no parameters at all — a filter member would
 * be a second place the node's own registry scope is decided. It carries a WIRE
 * NOTIFICATION and never a session event: the registry is un-evented by design,
 * because a node-local operator act on a node-local registry belongs to no session's
 * audit timeline.
 */
export const PROVIDER_ACCOUNT_SUBSCRIBE_STREAM = "providerAccount.subscribe";

/**
 * One daemon subscription, as the registry declares it: the stream's method name
 * and the registered request that scopes it.
 *
 * Both `run.*` streams are session-scoped — their registered requests each require a
 * `sessionId` — so the request is not optional here and a caller cannot spell an
 * unscoped open.
 */
export interface DaemonStreamOpen<StreamName extends RunStreamName> {
  /** The registered stream name: the run-state stream or the queue stream. */
  readonly method: StreamName;
  /** The registered request, forwarded to the daemon as the subscription's scope. */
  readonly request: DaemonSubscribeParams<StreamName>;
}

/**
 * A node-scoped daemon subscription: a stream whose registered request scopes it to
 * this machine and therefore carries no session at all.
 *
 * Two functions, one open — `openStream` is the only place either reaches
 * `bridge.daemon.subscribe`.
 */
export function subscribeNodeDaemon<StreamName extends DaemonEvent>(
  bridge: PlatformBridge,
  streamName: StreamName,
  request: DaemonSubscribeParams<StreamName>,
  handler: (payload: unknown) => void,
): Unsubscribe {
  return openStream(bridge, streamName, request, handler);
}

/**
 * The daemon subscription, taking the registered request the wire's own registry
 * pairs with the stream and forwarding it as the subscription's scope.
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
 * The one call into `daemon.subscribe`, shared by both scoped entry points.
 *
 * The open is REPORTED as well as taken. Every stream this module opens is a reading of
 * the same transport, and `transport/observed-subscription.ts` holds what such a
 * reading proves — a node-scoped tail opening is the returning edge a window with no
 * bindable session has no other way to observe.
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
