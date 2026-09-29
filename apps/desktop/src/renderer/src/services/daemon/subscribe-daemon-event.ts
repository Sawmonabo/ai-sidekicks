// The one place the console names a daemon EVENT.
//
// `PlatformBridge.daemon.subscribe` is declared over the same `never`-shaped brand
// its `call` sibling is: no string literal is assignable until that brand narrows to
// the real name union, so every caller in this repository casts. This module is the
// console's single copy, and it sits in `services/daemon/` rather than in any one
// feature because several features subscribe through it, and a helper a second
// feature needs is hoisted rather than written twice. When the brand narrows,
// exactly one file changes and the models above it do not.
//
// THE CALL SIDE IS NOT HERE. `services/daemon/daemon-reply.ts` answers calls: a
// registry keyed by method name, holding the contracts package's own schemas,
// parsing the request before it goes and the reply when it lands. A second call path
// here would be a second answer to which methods exist and what they carry.
//
// WHY A SUBSCRIPTION STILL CASTS. A subscribe names a STREAM and answers with an
// unsubscribe handle; it has no reply to parse, so the registry has nothing to bind
// it to. Which names are streams is `services/daemon/session-event-streams.ts`'s
// table, and what each carries is `services/daemon/session-event-stream-kinds.ts`'s.
import type { Unsubscribe } from "@shared/preload-api.js";

import { openObservedSubscription } from "../transport/observed-subscription.js";
import { type PlatformBridge } from "../platform/platform-bridge.js";

/**
 * Subscribe to one daemon event.
 *
 * The handler's payload is typed by the caller for the same reason and from the
 * same place. A caller that treats the payload as an opaque change signal — which
 * is what presence does — types it as `void` and reads nothing out of it.
 *
 * THE OPEN IS REPORTED, through `services/transport/observed-subscription.ts`, which
 * holds what an open proves. Every feature that subscribes reaches the wire here, so
 * this is one of the console's few live readings of whether the transport is there
 * at all — and the window's retry of a session whose own bind
 * failed depends on a reading taken somewhere other than that binding.
 *
 * @consumedBy a view that listens for one daemon event
 */
export function subscribeDaemonEvent<TPayload>(
  bridge: PlatformBridge,
  event: string,
  handler: (payload: TPayload) => void,
): Unsubscribe {
  const subscribe = bridge.daemon.subscribe as unknown as (
    eventName: string,
    onPayload: (payload: TPayload) => void,
  ) => Unsubscribe;
  return openObservedSubscription(bridge.transportReconnect, () => subscribe(event, handler));
}
