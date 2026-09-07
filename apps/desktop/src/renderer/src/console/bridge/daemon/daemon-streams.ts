// The console's one seam onto the daemon's SUBSCRIPTIONS, and the stream names it
// opens through it.
//
// A SIBLING OF THE CALL DOOR AND NOT A HALF OF IT. `daemon-reply.ts` answers for
// calls: one request, one reply, parsed against the shape the corpus registers for
// the method. A subscription has no reply to bind — it answers with an unsubscribe
// handle and delivers frames afterwards — so a stream is projected PER FRAME by its
// consumer rather than parsed once here, which is a different failure mode with a
// different owner. The `daemon-reply-chokepoint` gate says the same thing from the
// other side: it deliberately does not scan `daemon.subscribe`. Folding the two into
// one module would have given one file two jobs and made the chokepoint's own
// exemption unreadable.
//
// WHY IT LIVES IN `bridge/` RATHER THAN BESIDE ITS FIRST CALLER. The queue feed and
// the provider-account quota feed both open streams; those two sit in different
// families with no edge between them, so `apps/desktop/AGENTS.md`'s
// hoist-on-the-second-use rule puts the helper in the lowest family that can hold a
// `ConsoleBridge` — this one.
//
// WHAT THE WIDENING DOES AND DOES NOT ADMIT. The stream name is pinned to `string`
// (the genuinely untypeable half) and the delivered payload is left `unknown`, which
// is honest: a tighter payload type here would be a fiction, and every consumer
// projects each frame through the registered schema in `@ai-sidekicks/contracts`
// before rendering a figure from it. Nothing here invents a stream name — each
// constant below is a row of a registry the corpus already publishes, quoted
// verbatim.

import type { RunQueueSubscribeRequest, RunStateSubscribeRequest } from "@ai-sidekicks/contracts";

import { ConsoleRefusalError, refuse, type Unsubscribe } from "../../core/index.js";
import type { ConsoleBridge } from "../console-bridge.js";

/** The queue's replay-then-tail stream. Session-scoped; the client fans out per run. */
export const QUEUE_SUBSCRIBE_STREAM = "run.subscribeQueue";

/** The run-state stream, carrying `RunStateChangeEvent | RunRolledBackEvent`. */
export const RUN_STATE_SUBSCRIBE_STREAM = "run.subscribeState";

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
 * The daemon subscription, taking the registered request the wire's own registry
 * pairs with the stream.
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
