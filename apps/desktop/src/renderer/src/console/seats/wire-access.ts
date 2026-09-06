// The one place the console names a daemon EVENT.
//
// `SidekicksBridge.daemon.subscribe` is declared over the same `never`-shaped
// Plan-007 brand its `call` sibling is: no string literal is assignable until
// Plan-007 narrows the brand to the real name union, so every caller in this
// repository casts. This module is the console's single copy, and it is a seat
// rather than any one family's module because several view families subscribe
// through it — which is well past the second use `apps/desktop/AGENTS.md` hoists
// on. When the brand narrows, exactly one file changes and the models above it do
// not.
//
// THE CALL SIDE IS NOT HERE, AND ITS ABSENCE IS THE POINT. This module used to cast
// `daemon.call` the same way, with each caller pinning the request and response
// types by hand and nothing checking that the pin matched the wire. That is now
// `bridge/daemon/daemon-reply.ts`: a registry keyed by method name, holding the contracts
// package's own schemas, parsing the request before it goes and the reply when it
// lands. A second call door here would be a second answer to which methods exist
// and what they carry — so there is one, and it is next door.
//
// WHY A SUBSCRIPTION STILL CASTS. A subscribe names a STREAM and answers with an
// unsubscribe handle; it has no reply to parse, so the registry has nothing to bind
// it to. Which names are streams and what each carries is
// `bridge/daemon/session-event-streams.ts`'s table.

import type { Unsubscribe } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../bridge/index.js";

/**
 * Subscribe to one daemon event.
 *
 * The handler's payload is typed by the caller for the same reason and from the
 * same place. A surface that treats the payload as an opaque change signal — which
 * is what presence does — types it as `void` and reads nothing out of it.
 */
export function subscribeDaemonEvent<TPayload>(
  bridge: ConsoleBridge,
  event: string,
  handler: (payload: TPayload) => void,
): Unsubscribe {
  const subscribe = bridge.sidekicks.daemon.subscribe as unknown as (
    eventName: string,
    onPayload: (payload: TPayload) => void,
  ) => Unsubscribe;
  return subscribe(event, handler);
}
