// The one place this family names a daemon method or a daemon event.
//
// `SidekicksBridge.daemon.call` is declared `call<M extends DaemonMethod>(method: M,
// params: DaemonParams<M>): Promise<DaemonResult<M>>`, where `DaemonMethod` is a
// `never`-shaped Plan-007 brand and `DaemonResult<M>` widens to `unknown`. No string
// literal is assignable to that brand until Plan-007 narrows it to the real method
// union, so every caller in this repository casts — the two shipped Tier-1
// components each carry their own copy of the cast and their own paragraph
// explaining it.
//
// This module is the family's single copy. Two surfaces here reach the wire
// (`channel.list` and `presence.read` / `presence.subscribe`), which is the second
// use, and `apps/desktop/AGENTS.md` hoists on the second use. When the brand
// narrows, exactly one file changes and the models above it do not.
//
// THE CAST NARROWS RATHER THAN ERASES. Params and result are pinned to the
// contracts package's own request and response types at each call site, so the only
// untyped thing left is the method NAME — the genuinely untypeable part. There is
// deliberately NO runtime validation: the response schemas live in
// `@ai-sidekicks/contracts` and are Zod, and pulling a validator into the renderer
// to re-decide a question the daemon already answered would buy a second authority
// with kilobytes of bundle. The shipped roster took the same position for the same
// reason.

import type { Unsubscribe } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../bridge/index.js";

/**
 * Call one daemon method with a typed request and a typed response.
 *
 * `TResponse` is the caller's claim about what the daemon returns, and the caller
 * takes it from `@ai-sidekicks/contracts` rather than writing a shape here.
 */
export async function callDaemonMethod<TRequest, TResponse>(
  bridge: ConsoleBridge,
  method: string,
  request: TRequest,
): Promise<TResponse> {
  const call = bridge.sidekicks.daemon.call as unknown as (
    methodName: string,
    params: TRequest,
  ) => Promise<TResponse>;
  return call(method, request);
}

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
