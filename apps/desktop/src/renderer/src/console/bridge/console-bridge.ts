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
//
// The subscribe seam's own vocabulary — which names are registered STREAMS, and
// which event kinds each one carries — lives in `session-event-streams.ts` rather
// than here: both sides of that seam read it, and neither of them is this file.

import type { SidekicksBridge } from "@ai-sidekicks/contracts";
import { RealClock, type ConsoleClock } from "../core/index.js";
import type { ScriptedPaneViewHost } from "./fixture/pane-view-host-script.js";
import type { GrowthOperationId, GrowthPort } from "./growth-port/index.js";
import type { ScenarioEngine } from "./scenario-runtime/index.js";

/** Which bridge the console is running against. Rendered, never inferred. */
export type ConsoleBridgeSource = "live" | "fixture";

export interface ConsoleBridge {
  /** Exactly the preload contract. Shape-identical across both sources. */
  readonly sidekicks: SidekicksBridge;
  /** The single fixture-only seam for wires the corpus has not registered. */
  readonly growth: GrowthPort;
  /**
   * Which growth operations this bridge ANSWERS rather than refuses.
   *
   * A synchronous fact beside the asynchronous port, and it earns its place: some
   * decisions have to be made before a call can be awaited. The composition root
   * has to know whether a session read exists before it builds the registry that
   * would perform one, because a registry that cannot read must not have a stream
   * bound to it at all — and under the live bridge `daemon.subscribe` throws, so
   * "bind and find out" is not a fallback, it is a crash inside a mount effect.
   *
   * Declared by the bridge that serves them, so the two cannot drift: a fixture
   * that implements an operation and forgets to publish it here is a set that
   * disagrees with a port, which is the disagreement `bridge-shape.test.ts` reads.
   */
  readonly growthServedOperations: ReadonlySet<GrowthOperationId>;
  /**
   * The scripted view host a pane publishes its rectangle to, or `undefined` where
   * no view can exist in this window.
   *
   * Beside the growth port rather than inside it, and the reason is the same one
   * that keeps the port beside `sidekicks`: this is not a wire. It is 12.11's
   * wiring-table INPUT — the thing the resolver in `browser/geometry/view-host.ts` selects
   * on — and folding it into the port would put a fabricated operation name on a
   * seam whose whole point is that `browser.setRect` is unregistered.
   *
   * Declared by the bridge that has one, so a pane cannot be handed a window it is
   * not running in: the live bridge answers `undefined` and every publish is
   * suppressed with 12.11's sentence, exactly as it is today.
   */
  readonly paneViewHostScript: ScriptedPaneViewHost | undefined;
  readonly source: ConsoleBridgeSource;
  /** Present only under the fixture, so a surface can drive playback in a story. */
  readonly scenarioEngine: ScenarioEngine | undefined;
}

/**
 * The clock every subsystem this bridge feeds has to run on.
 *
 * `Spec-023 §Console Design (Meridian)` §The fixture bridge: "the fixture clock is
 * the only clock the renderer reads in fixture mode". A window whose stores kept
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
