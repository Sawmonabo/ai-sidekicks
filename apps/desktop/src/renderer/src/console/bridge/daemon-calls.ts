// The console's one seam onto the daemon, and the method strings it reaches
// through it.
//
// WHY A MODULE AND NOT A CAST AT EACH CALL SITE. `SidekicksBridge.daemon.call`
// takes `DaemonMethod`, which is a `never`-shaped brand standing in for Plan-007's
// method union, and answers `DaemonResult<M>`, which resolves to `unknown` until
// that union lands. Every caller therefore has to widen the signature, and three
// surfaces widening it three ways would be three subtly different claims about the
// same wire. One widening, in one module, is one claim.
//
// WHY IT LIVES IN `bridge/` RATHER THAN BESIDE ITS FIRST CALLER. The composer
// accessories widened it first and the runs pane needs the same widening; those two
// sit in different families with no edge between them, so `apps/desktop/AGENTS.md`'s
// hoist-on-the-second-use rule puts the helper in the lowest family that can hold a
// `ConsoleBridge` — this one. A copy in each family would be the two-implementations
// case that rule exists to prevent, and a helper in a VIEW family would make every
// other family deep-import a sibling's subtree to reach the wire.
//
// WHAT THE WIDENING DOES AND DOES NOT ADMIT. The method name is pinned to `string`
// (the genuinely untypeable half) and the reply is left `unknown`, which is honest:
// a tighter reply type here would be a fiction, and every caller parses the reply
// through the registered schema in `@ai-sidekicks/contracts` before rendering a
// figure from it. Nothing here invents a method name — each constant below is a row
// of a registry the corpus already publishes, quoted verbatim.

import type { Unsubscribe } from "../core/index.js";
import type { ConsoleBridge } from "./console-bridge.js";

/**
 * Participant-triggered context compaction.
 *
 * Run-addressed within the session; the daemon resolves the binding itself, which
 * is why the request carries no binding member for the console to supply.
 */
export const COMPACT_CONTEXT_METHOD = "driver.compactContext";

/**
 * The bound provider's own command and skill enumeration.
 *
 * Agent-addressed within the session, because one agent can hold several live
 * bindings at once and the daemon fans out across them — the reply's group list is
 * what carries that back, each group naming the `(driverName, providerAccountId)` it
 * was read under. The console never sends a binding member: the request schema is
 * strict and admits none.
 *
 * A LIVE READ, held for the composer's current target and nothing longer. There is
 * no registry behind it and none is wanted: a stored copy would need invalidation,
 * staleness, and reconciliation machinery whose only purpose is to re-derive what one
 * read gives.
 */
export const LIST_PROVIDER_COMMANDS_METHOD = "driver.listProviderCommands";

/**
 * Which capabilities each bound driver declares.
 *
 * The two driver-gated run controls — steer and rollback — read their flags from
 * this reply. Pause, resume, interrupt, and cancel are orchestration-layer and are
 * never gated on it.
 */
export const DRIVER_LIST_CAPABILITIES_METHOD = "driver.listCapabilities";

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

/** Resume one paused run. `run.pause`'s sibling verb, and never a reread or reattach. */
export const RUN_RESUME_METHOD = "run.resume";

/** The one method every intervention travels: steer, interrupt, cancel, rollback. */
export const RUN_INTERVENE_METHOD = "run.intervene";

/** The queue's canonical snapshot. The only `query` in the run-control registry. */
export const QUEUE_LIST_METHOD = "run.queueList";

/** Cancel one queued item. The daemon confirms; no surface removes a row ahead of it. */
export const QUEUE_CANCEL_METHOD = "run.queueCancel";

/** The queue's replay-then-tail stream. Session-scoped; the client fans out per run. */
export const QUEUE_SUBSCRIBE_STREAM = "run.subscribeQueue";

/** The run-state stream, carrying `RunStateChangeEvent | RunRolledBackEvent`. */
export const RUN_STATE_SUBSCRIBE_STREAM = "run.subscribeState";

/**
 * The daemon call, with the one brand bypass the console makes.
 *
 * Takes the bridge rather than the raw namespace so `window.sidekicks` stays inside
 * `bridge/BridgeProvider.tsx` and every surface reaches the wire through a value it
 * was handed.
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
