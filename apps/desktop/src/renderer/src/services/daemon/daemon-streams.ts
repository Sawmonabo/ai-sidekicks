// The app's seam onto the daemon's subscriptions. Unlike `callDaemon`, a subscription has no
// reply to bind: it answers with an unsubscribe handle and delivers frames, so each consumer
// projects every frame through the registered schema in `@ai-sidekicks/contracts`, and the payload
// here stays `unknown`. It sits in this folder, the lowest one that can hold a `PlatformBridge`,
// because features that never import each other share it.

import type { DaemonSubscriptionEnd } from "@shared/daemon-forwarding.js";
import type { DaemonWireRequest, Unsubscribe } from "@shared/preload-api.js";
import type { PlatformBridge } from "../platform/platform-bridge.js";
import { openObservedSubscription } from "../transport/observed-subscription.js";
import type { RUN_QUEUE_EVENT_STREAM, RUN_STATE_EVENT_STREAM } from "./session-event-streams.js";

/**
 * One daemon subscription: the stream's method name and the registered request that scopes it.
 * Both run streams require a `sessionId`, so the request is not optional and an unscoped open
 * cannot be spelled.
 */
export interface DaemonStreamOpen<StreamName extends RunStreamName> {
  /** The registered stream name: the run-state stream or the queue stream. */
  readonly method: StreamName;
  /** The registered request, forwarded to the daemon as the subscription's scope. */
  readonly request: DaemonWireRequest<StreamName>;
}

/**
 * A session-scoped daemon subscription, forwarding the registered request as its scope. The open
 * is also reported to `transport/observed-subscription.ts`, so any stream opening can show the
 * transport is back. `onEnded` hears a stream that stopped without being closed, so its owner can
 * open it again from where it got to.
 */
export function subscribeDaemon<StreamName extends RunStreamName>(
  bridge: PlatformBridge,
  stream: DaemonStreamOpen<StreamName>,
  handler: (payload: unknown) => void,
  onEnded?: (end: DaemonSubscriptionEnd) => void,
): Unsubscribe {
  return openObservedSubscription(bridge.transportReconnect, () =>
    bridge.daemon.subscribe(stream.method, stream.request, handler, onEnded),
  );
}

/** The two session-scoped run streams a feature opens through {@link subscribeDaemon}. */
type RunStreamName = typeof RUN_STATE_EVENT_STREAM | typeof RUN_QUEUE_EVENT_STREAM;
