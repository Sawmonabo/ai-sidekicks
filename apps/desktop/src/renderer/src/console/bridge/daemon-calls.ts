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
//
// WHY THE CALL SEAM IS TOTAL. The widening already claims the reply is `unknown`
// and that the call may fail; a seam that could ALSO fail before returning a
// promise would be two failure shapes for one call, and every caller would have to
// handle both. So `callUnregisteredDaemonMethod` is `async` — an `async` function's synchronous throw
// is already a rejection — and a bridge that throws in the caller's own frame
// reaches the caller's `.catch` rather than escaping from a mount effect.

import type { RunQueueSubscribeRequest, RunStateSubscribeRequest } from "@ai-sidekicks/contracts";

import { ConsoleRefusalError, refuse, type Unsubscribe } from "../core/index.js";
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
 * The node's provider-account registry, with the durable quota rows on the reply.
 *
 * NODE-scoped and not session-scoped: the registry is the machine's, so the reply
 * describes accounts no session owns. The quota rows ride the READ because the
 * subscription beside it is a live tail rather than a snapshot replay — without them
 * a client that opened after a reading, or after a daemon restart, could reach the
 * stored windows only when another probe or run happened to produce one.
 */
export const PROVIDER_ACCOUNT_LIST_METHOD = "providerAccount.list";

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
 * The daemon call, with the one brand bypass the console makes.
 *
 * Takes the bridge rather than the raw namespace so `window.sidekicks` stays inside
 * `bridge/BridgeProvider.tsx` and every surface reaches the wire through a value it
 * was handed.
 *
 * `async` carries the totality claim above, and it is the whole reason for the
 * keyword: the shipped live preload is a Tier-1 stub that throws on every method,
 * so a non-`async` wrapper would invoke it in the caller's frame and every `.catch`
 * in the console would be unreachable against the one bridge that ships.
 */
export async function callUnregisteredDaemonMethod(
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

/** The subsystem name the subscription guard's refusal carries. */
export const DAEMON_STREAM_REFUSAL_ORIGIN = "console-daemon-stream";

/**
 * One daemon subscription, as the registry declares it: the stream's method name
 * and the registered request that scopes it.
 *
 * Both `run.*` streams are session-scoped — `RunStateSubscribeRequest` and
 * `RunQueueSubscribeRequest` are each `z.object({ sessionId }).strict()` — so the
 * request is not optional here and a caller cannot spell an unscoped open.
 */
export interface DaemonStreamOpen {
  /** The registered stream name: one of the two `*_SUBSCRIBE_STREAM` constants. */
  readonly method: string;
  /** The registered request, parsed by the caller through its own schema. */
  readonly request: RunStateSubscribeRequest | RunQueueSubscribeRequest;
}

/**
 * A node-scoped daemon subscription: a stream whose registered request scopes it to
 * this machine and therefore carries no session at all.
 *
 * A SIBLING OF `subscribeDaemon` AND NOT A WIDENING OF IT. The session guard below
 * is what keeps a session-scoped feed from ever opening with nothing to put on it,
 * and relaxing it to admit a request with no session would delete that guarantee for
 * the two `run.*` feeds in order to serve a stream that never had a session to name.
 * Two functions, one widening — `#openStream` is the only place either reaches
 * `bridge.sidekicks.daemon.subscribe`.
 */
export function subscribeNodeDaemon(
  bridge: ConsoleBridge,
  streamName: string,
  handler: (payload: unknown) => void,
): Unsubscribe {
  return openStream(bridge, streamName, handler);
}

/**
 * The daemon subscription, widened the same way `callUnregisteredDaemonMethod` is and taking the
 * registered request the wire's own registry pairs with the stream.
 *
 * WHAT HAPPENS TO THE REQUEST TODAY, EXACTLY. It is VALIDATED and HELD, and it is
 * not yet forwarded, because there is nowhere to forward it to:
 * `SidekicksBridge.daemon.subscribe<E>(event, handler)` carries an event name and a
 * handler and NO request-parameter channel, and `Spec-023 §Preload Bridge Contract`
 * pins that signature as a Tier-1 placeholder whose shape — positional parameter,
 * options bag, or an event-to-params map — is owned by Plan-007 / Plan-008 and is
 * deliberately not fixed from one caller's vantage. Widening the contract type here
 * would be that premature narrowing; widening the CONSOLE's own wrapper is not, and
 * it is what makes the day the channel lands a one-line change inside this function
 * rather than an audit of every feed. The shipped preload is a Tier-1 stub that
 * throws on every method, so no live subscription exists to leak across today.
 *
 * WHY HOLDING IT IS SAFE UNDER THE ONE BRIDGE THAT ANSWERS. The fixture is the only
 * bridge that delivers a `run.*` beat, and a fixture scenario declares exactly one
 * session — its beats are minted against that scenario's single session id — so
 * there is no second session's projection for an unscoped subscription to consume.
 * The guard below is therefore about the CALLER, not about the wire: it refuses an
 * open that names no session so a feed can never reach the day the channel lands
 * with nothing to put on it.
 */
export function subscribeDaemon(
  bridge: ConsoleBridge,
  stream: DaemonStreamOpen,
  handler: (payload: unknown) => void,
): Unsubscribe {
  const { sessionId } = stream.request;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new ConsoleRefusalError(
      refuse(
        DAEMON_STREAM_REFUSAL_ORIGIN,
        "stream-request-unscoped",
        `The ${stream.method} stream is session-scoped and was opened with no session, so the console did not open it.`,
      ),
    );
  }
  return openStream(bridge, stream.method, handler);
}

/** The one widening of `daemon.subscribe`, shared by both scoped entry points. */
function openStream(
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
