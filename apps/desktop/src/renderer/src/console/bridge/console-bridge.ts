// What the console holds instead of `window.desktopBridge`.
//
// The fixture has to be shape-identical to `DesktopBridge`. The cheapest way to
// keep a claim like that true is to make it a type: both bridges below ARE
// `DesktopBridge`, so a namespace added to the contract breaks the fixture at
// compile time rather than at review time.
//
// The subscribe seam's own vocabulary — which names are registered STREAMS, and
// which event kinds each one carries — lives in `session-event-streams.ts` and the
// kind tables beside it rather than here: both sides of that seam read them, and
// neither of them is this file.

import type { DesktopBridge, Unsubscribe } from "@ai-sidekicks/contracts";
import { RealClock, type ConsoleClock } from "../core/index.js";
import type { ScenarioEngine } from "./scenario/runtime/index.js";
import type { TransportReconnectSignal } from "./transport/transport-reconnect.js";

/** Which bridge the console is running against. Rendered, never inferred. */
export type ConsoleBridgeSource = "live" | "fixture";

/**
 * Subscribe to the attention plane's movement. Returns the disposer the caller owes.
 *
 * The shape `store/session/open-session-signal.ts` already publishes for the stores half of
 * the same question — a callback that carries nothing and a handle that releases it —
 * so a consumer can hold both halves without narrowing on two vocabularies at once.
 */
export type AttentionPlaneSubscribe = (onAttentionChange: () => void) => Unsubscribe;

export interface ConsoleBridge {
  /** Exactly the preload contract. Shape-identical across both sources. */
  readonly desktopBridge: DesktopBridge;
  /**
   * The attention plane moving, as one opaque change signal over every session this
   * bridge can name.
   *
   * BESIDE THE SESSION STORES RATHER THAN INSTEAD OF THEM, and the gap it closes is
   * the whole reason it exists. The console's other signal over attention is
   * `store/session/open-session-signal.ts`, which watches the stores this window has OPEN —
   * so a session the node reports and nobody in this window ever opened has no store
   * to move, and its approval, its input request, and its failed run reached the
   * badge, the centre, and the banner never. The projection read is fanned out over
   * every session this window can NAME, and this is the signal on the same set.
   *
   * OPAQUE, because the only consumer re-reads the whole projection: nothing about
   * which session moved travels with the call, exactly as the open-session signal
   * carries nothing about which store did.
   *
   * ANSWERED BY EVERY BRIDGE, so no caller branches on the source. A bridge that
   * publishes no attention plane hands back a disposer and signals nothing, which is
   * a reading rather than a refusal: it is not declining to say when attention moved,
   * it holds no attention plane whose movement it could report.
   */
  readonly attentionSubscribe: AttentionPlaneSubscribe;
  /**
   * The window's one transport-reconnect signal.
   *
   * Not a wire: the preload contract exposes no connection state, so a
   * `DesktopBridge` member for one would make the fixture shape-identical to
   * something the preload does not have.
   *
   * BOTH HALVES, deliberately. The observers that report into it live above this
   * family (the seat every view family subscribes through, and the session-event
   * binder) and inside it (this family's own stream door, and the fixture's scripted
   * outages), and a bridge publishing only the subscribe view would leave them nothing
   * to report to. Readings take the `TransportReconnectObservable` view declared at the
   * floor, which is subscribe-only.
   */
  readonly transportReconnect: TransportReconnectSignal;
  readonly source: ConsoleBridgeSource;
  /** Present only under the fixture, so a surface can drive playback in a story. */
  readonly scenarioEngine: ScenarioEngine | undefined;
}

/**
 * The clock every subsystem this bridge feeds has to run on.
 *
 * The fixture clock is the only clock the renderer reads in fixture mode. A window
 * whose stores kept
 * their own `RealClock` broke that sentence without looking like it — apply
 * coalescing and every refresh deadline ran on wall time while scenario beats
 * advanced on frozen time, so a screenshot or an endurance step taken straight
 * after `advance()` could observe either side of a drain depending on how fast the
 * runner happened to be.
 *
 * It reads the running engine rather than the source tag, because the engine is
 * what OWNS the frozen clock: a bridge tagged `fixture` with no engine has no
 * frozen time to share, and answering with one would be an invented reading. The
 * real arm mints a fresh `RealClock` per caller, which is not a second time base —
 * every instance reads the same wall clock — and matches what each subsystem
 * defaulted to before this seam existed.
 */
export function consoleClockFor(bridge: ConsoleBridge): ConsoleClock {
  return bridge.scenarioEngine?.clock ?? new RealClock();
}
