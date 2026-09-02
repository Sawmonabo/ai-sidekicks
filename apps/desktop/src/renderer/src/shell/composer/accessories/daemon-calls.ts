// The composer accessories' one seam onto the daemon, and the method strings it
// reaches through it.
//
// WHY A MODULE AND NOT A CAST AT EACH CALL SITE. `SidekicksBridge.daemon.call`
// takes `DaemonMethod`, which is a `never`-shaped brand standing in for Plan-007's
// method union, and answers `DaemonResult<M>`, which resolves to `unknown` until
// that union lands. Every caller therefore has to widen the signature, and three
// accessories widening it three ways would be three subtly different claims about
// the same wire. One widening, in one module, is one claim — and it is the same
// posture `console/frame/session-event-binder.ts` takes for the subscribe half.
//
// WHAT THE WIDENING DOES AND DOES NOT ADMIT. The method name is pinned to `string`
// (the genuinely untypeable half) and the reply is left `unknown`, which is honest:
// a tighter reply type here would be a fiction, and every caller parses the reply
// through the registered schema in `@ai-sidekicks/contracts` before rendering a
// figure from it. Nothing here invents a method name — each constant below is a row
// of a registry the corpus already publishes, quoted verbatim.

import type { Unsubscribe } from "../../../console/core/index.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";

/**
 * Participant-triggered context compaction.
 *
 * Run-addressed within the session; the daemon resolves the binding itself, which
 * is why the request carries no binding member for the console to supply.
 */
export const COMPACT_CONTEXT_METHOD = "driver.compactContext";

/**
 * Pause one run.
 *
 * `run.pause` and NOT an intervention arm. The registered
 * `InterventionRequestPayload` union is `steer | interrupt | cancel | rollback`,
 * and pause/resume are separate request types by design — so a control that sent a
 * `{ type: "pause" }` intervention would be sending a shape the wire's own
 * discriminated union has no arm for.
 */
export const RUN_PAUSE_METHOD = "run.pause";

/** Cancel one queued item. The daemon confirms; the shelf never removes ahead of it. */
export const QUEUE_CANCEL_METHOD = "run.queueCancel";

/** The queue's replay-then-tail stream. Session-scoped; the client fans out per run. */
export const QUEUE_SUBSCRIBE_STREAM = "run.subscribeQueue";

/**
 * The daemon call, with the one brand bypass the composer makes.
 *
 * Takes the bridge rather than the raw namespace so `window.sidekicks` stays inside
 * `bridge/BridgeProvider.tsx` and every accessory reaches the wire through a value
 * it was handed.
 */
export function callDaemon(
  bridge: ConsoleBridge,
  method: string,
  params: unknown,
): Promise<unknown> {
  const call = bridge.sidekicks.daemon.call as (
    method: string,
    params: unknown,
  ) => Promise<unknown>;
  return call(method, params);
}

/** The daemon subscription, widened the same way and for the same reason. */
export function subscribeDaemon(
  bridge: ConsoleBridge,
  streamName: string,
  handler: (payload: unknown) => void,
): Unsubscribe {
  const subscribe = bridge.sidekicks.daemon.subscribe as (
    event: string,
    handler: (payload: unknown) => void,
  ) => Unsubscribe;
  return subscribe(streamName, handler);
}
