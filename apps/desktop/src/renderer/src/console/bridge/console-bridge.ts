// What the console holds instead of `window.sidekicks`.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge requires the fixture to
// be "shape-identical to `SidekicksBridge`". The cheapest way to keep a claim like
// that true is to make it a type: both bridges below ARE `SidekicksBridge`, so a
// namespace added to the contract breaks the fixture at compile time rather than at
// review time.
//
// The growth port sits BESIDE the bridge rather than inside it, for the same
// reason. Folding unregistered wires into `SidekicksBridge` would put methods on the
// preload contract that the preload does not expose — the fixture would then be
// shape-identical to a lie. Beside it, the two surfaces stay honest: `sidekicks` is
// exactly what the preload gives, `growth` is exactly what it does not.

import type { SidekicksBridge } from "@ai-sidekicks/contracts";
import type { GrowthPort } from "./growth-port.js";
import type { ScenarioEngine } from "./scenario.js";

/** Which bridge the console is running against. Rendered, never inferred. */
export type ConsoleBridgeSource = "live" | "fixture";

/**
 * The registered daemon stream a console session is projected from.
 *
 * `session.subscribe` is the replay-then-tail event stream the method registry
 * already carries, named here verbatim rather than invented: a console that
 * subscribed to a string the daemon does not serve would get silence that is
 * indistinguishable from a quiet session.
 *
 * It lives in this module rather than beside its one caller because BOTH sides of
 * the subscribe seam need it. `frame/session-event-binder.ts` passes it to
 * `daemon.subscribe`; `fixture-bridge.ts` has to recognise it to answer the way
 * the daemon would. Two copies of the string would let the producer and the
 * consumer drift apart while every test still passed.
 */
export const SESSION_EVENT_STREAM = "session.subscribe";

/**
 * Subscription names that carry a session's WHOLE event stream.
 *
 * `daemon.subscribe(name, handler)` names either one event type or a stream of
 * them, and the two answer differently: a stream delivers every event of the
 * session, an event type delivers only its own. Closed, and one member today —
 * the console subscribes to nothing else.
 */
const WHOLE_SESSION_EVENT_STREAMS: readonly string[] = [SESSION_EVENT_STREAM];

/** Does this subscription name carry a session's whole stream rather than one type? */
export function isSessionEventStream(subscriptionName: string): boolean {
  return WHOLE_SESSION_EVENT_STREAMS.includes(subscriptionName);
}

export interface ConsoleBridge {
  /** Exactly the preload contract. Shape-identical across both sources. */
  readonly sidekicks: SidekicksBridge;
  /** The single fixture-only seam for wires the corpus has not registered. */
  readonly growth: GrowthPort;
  readonly source: ConsoleBridgeSource;
  /** Present only under the fixture, so a surface can drive playback in a story. */
  readonly scenarioEngine: ScenarioEngine | undefined;
}
