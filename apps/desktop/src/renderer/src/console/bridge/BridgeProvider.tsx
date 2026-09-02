// The bridge provider: one context, one decision, made once at mount.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge makes the fixture a
// `define`-gated build-time constant, not a runtime flag. `__SIDEKICKS_CONSOLE_FIXTURES__`
// is replaced by `electron.vite.config.ts` with a literal, so a production bundle
// contains the string `false` at that site and the whole fixture subtree — every
// scenario, the engine, the manifest — is dead code the bundler drops. A runtime
// environment variable could not do that: it would ship the fixtures to users and
// bill them for the bytes on every budget run.
//
// The context holds a `ConsoleBridge` and nothing else. No component reads
// `window.sidekicks`, and no component subscribes to a bridge event directly — the
// store's apply chokepoint is the only subscriber (`store/session-store.ts`), and
// this provider is where the two are joined.
//
// WHICH scenario the fixture plays is decided one level up, at boot, and arrives
// here as a prop that never changes for the life of the provider — see
// `scenario-selection.ts`. This module owns the other end of that seam: the
// `define`-gated handle the two Electron tiers drive the running engine through.
//
// WHY THE RESOLUTION IS STATE AND NOT A MEMO
//
// The fixture arm builds a `ScenarioEngine`, which is a mutable resource: it holds
// subscriptions, a frozen clock that has been advanced, a delivered-beat count,
// and replies parked on that clock. React documents `useMemo` as a performance
// hint whose cache it may DISCARD and recompute, so holding the engine there means
// a second engine can start at tick zero while the first one is abandoned
// mid-scenario — and every deterministic property the fixture exists for
// (replayable tick-for-tick, a screenshot pinned to an exact frame) is gone with
// it. `ConsoleRoot` states the same rule for the stores it owns. A `useState`
// initializer runs once per mounted component and its result is never recomputed,
// so the engine's identity is state rather than a cache.
//
// The other half is that a resource has an END. A memo can keep an identity and
// can never release one, so the provider replaced its bridge on a scenario change
// and disposed nothing — the superseded engine kept every sink subscribed to it,
// and a driver holding the old handle went on advancing a scenario no window was
// rendering. Replacement and teardown are therefore explicit below, and scoped:
// the provider disposes only an engine it BUILT, never one a caller handed it.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { type ConsoleClock } from "../core/index.js";
import { consoleClockFor, type ConsoleBridge } from "./console-bridge.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import { createLiveBridge, readInstalledBridge } from "./live-bridge.js";
import { consoleScenario } from "./scenario-manifest.js";
import { ScenarioFixtureControl } from "./scenario-selection.js";
import { FIRST_RUN_SCENARIO_ID } from "./scenarios/first-run.js";

/** Why the console has no bridge at all. Rendered as the "error" kind of nothing. */
export interface BridgeUnavailable {
  readonly reason: "preload-did-not-run";
  readonly detail: string;
}

export type BridgeResolution =
  | { readonly status: "ready"; readonly bridge: ConsoleBridge }
  | { readonly status: "unavailable"; readonly unavailable: BridgeUnavailable };

const BridgeContext = createContext<BridgeResolution | undefined>(undefined);

export interface SidekicksBridgeProviderProps {
  readonly children: ReactNode;
  /**
   * Override the resolved bridge. Tests and stories pass a fixture directly; the
   * app passes nothing and gets the `define`-gated resolution below.
   */
  readonly bridge?: ConsoleBridge;
  /** Which scenario the fixture plays. Ignored when fixtures are compiled out. */
  readonly scenarioId?: string;
}

/**
 * One resolved bridge, the inputs it was resolved from, and who owns its engine.
 *
 * A class rather than a bare object because the two questions a caller asks of it
 * are rules rather than fields — is this still the right resolution for these
 * props, and what does tearing it down actually mean — and both have an answer
 * that depends on whether the bridge was BUILT here or handed in. A caller's
 * bridge outlives this provider; one built here does not.
 */
class ResolvedConsoleBridge {
  readonly #suppliedBridge: ConsoleBridge | undefined;
  readonly #scenarioId: string | undefined;
  readonly #resolution: BridgeResolution;
  /** The engine this provider BUILT. `undefined` when the caller supplied one. */
  readonly #ownedEngine: ConsoleBridge["scenarioEngine"];

  public constructor(suppliedBridge: ConsoleBridge | undefined, scenarioId: string | undefined) {
    this.#suppliedBridge = suppliedBridge;
    this.#scenarioId = scenarioId;
    this.#resolution = resolveBridge(suppliedBridge, scenarioId);
    this.#ownedEngine =
      suppliedBridge === undefined && this.#resolution.status === "ready"
        ? this.#resolution.bridge.scenarioEngine
        : undefined;
  }

  public get resolution(): BridgeResolution {
    return this.#resolution;
  }

  /**
   * Is this resolution no longer the right one to serve?
   *
   * Two arms. The props it was resolved from changed, which is a deliberate
   * replacement; or its own engine has been disposed, which is the re-mint arm a
   * double mount takes — React's StrictMode tears an effect down and runs it
   * again, the teardown has already disposed the engine, and a second mount must
   * take a fresh one rather than a corpse. Same shape as the registry arm in
   * `frame/session-lifecycle.ts`.
   */
  public isSupersededBy(
    suppliedBridge: ConsoleBridge | undefined,
    scenarioId: string | undefined,
  ): boolean {
    if (suppliedBridge !== this.#suppliedBridge || scenarioId !== this.#scenarioId) {
      return true;
    }
    return this.#ownedEngine?.isDisposed === true;
  }

  /**
   * The engine this window renders against, whichever side built it. The
   * scenario control is hung on THIS one, because a driver in another process
   * reaches the running scenario through nothing else.
   */
  public get renderedEngine(): ConsoleBridge["scenarioEngine"] {
    return this.#resolution.status === "ready" ? this.#resolution.bridge.scenarioEngine : undefined;
  }

  /**
   * Tear down the engine this provider BUILT, and only that one: a bridge the
   * caller handed in outlives this component, and disposing it here would leave
   * the next render of a story or a test driving a corpse.
   */
  public disposeOwnedEngine(): void {
    this.#ownedEngine?.dispose();
  }
}

/**
 * Hang the scenario control on the page and return the teardown for both it and
 * the engine the resolution owns.
 *
 * A free function referenced ONLY under the build-time guard in the provider's
 * effect, never a method on `ResolvedConsoleBridge`: Rollup drops an unreferenced
 * function and `scenario-selection.js` with it, but it keeps every method of a class
 * that is constructed, so a method here would carry the fixture handle's name into
 * the release bundle — which `test/console/budget/release-absence.test.ts` refuses.
 *
 * The install runs from an effect rather than the constructor because React may
 * discard a render pass, and a handle installed during one would point at an engine
 * no window is reading; the effect's return is the one place removal is paired with
 * install.
 */
function installScenarioControl(
  resolved: ResolvedConsoleBridge,
  page: Record<string, unknown>,
): () => void {
  const renderedEngine = resolved.renderedEngine;
  const removeControl =
    renderedEngine === undefined
      ? undefined
      : new ScenarioFixtureControl(renderedEngine).install(page);
  return () => {
    removeControl?.();
    resolved.disposeOwnedEngine();
  };
}

/**
 * Resolve the bridge once and hand it down.
 *
 * The resolution is held as STATE, replaced only when the props it was resolved
 * from change or its own engine has been torn down — see the module header for why
 * neither a memo nor a plain re-creation is correct for a resource with a lifetime.
 */
export function SidekicksBridgeProvider(props: SidekicksBridgeProviderProps): React.JSX.Element {
  const { children, bridge, scenarioId } = props;
  const [resolved, setResolved] = useState<ResolvedConsoleBridge>(
    () => new ResolvedConsoleBridge(bridge, scenarioId),
  );

  // One effect, because replacement and installation are one decision made in one
  // order: the previous resolution's teardown has already run by the time this
  // body sees a superseded one, so the replacement never disposes something a
  // later commit still reads.
  //
  // `__SIDEKICKS_CONSOLE_FIXTURES__` is a literal at build time, so a release
  // bundle folds the install to nothing and drops `scenario-selection.js` with it.
  // The replacement arm is NOT inside that guard: the resolution is replaced under
  // the live bridge too, and a `bridge` prop that changes has to be honoured in
  // every build.
  useEffect(() => {
    if (resolved.isSupersededBy(bridge, scenarioId)) {
      setResolved(new ResolvedConsoleBridge(bridge, scenarioId));
      return undefined;
    }
    if (__SIDEKICKS_CONSOLE_FIXTURES__) {
      return installScenarioControl(resolved, globalThis as unknown as Record<string, unknown>);
    }
    return undefined;
  }, [resolved, bridge, scenarioId]);

  return <BridgeContext.Provider value={resolved.resolution}>{children}</BridgeContext.Provider>;
}

function resolveBridge(
  suppliedBridge: ConsoleBridge | undefined,
  scenarioId: string | undefined,
): BridgeResolution {
  if (suppliedBridge !== undefined) {
    return { status: "ready", bridge: suppliedBridge };
  }
  if (__SIDEKICKS_CONSOLE_FIXTURES__) {
    return {
      status: "ready",
      bridge: createFixtureBridge({
        scenario: consoleScenario(scenarioId ?? FIRST_RUN_SCENARIO_ID),
      }),
    };
  }
  const installed = readInstalledBridge();
  if (installed === undefined) {
    return {
      status: "unavailable",
      unavailable: {
        reason: "preload-did-not-run",
        detail:
          "This window loaded without its preload bridge, so it cannot reach the daemon or the control plane. Reopening the window usually fixes it; if it does not, the app needs restarting.",
      },
    };
  }
  return { status: "ready", bridge: createLiveBridge(installed) };
}

/**
 * The bridge, or a throw. A component that reaches for the bridge outside the
 * provider is a wiring bug, and a `undefined` return would let it render an empty
 * state that looks like "no data" — the exact conflation the five kinds of nothing
 * forbid.
 */
export function useConsoleBridge(): ConsoleBridge {
  const resolution = useBridgeResolution();
  if (resolution.status === "unavailable") {
    throw new Error(`console bridge unavailable: ${resolution.unavailable.detail}`);
  }
  return resolution.bridge;
}

/**
 * The clock this window runs on, pinned for the calling component's life.
 *
 * `consoleClockFor` is the one answer to which clock a window reads, and a
 * subsystem that BUILDS itself around a clock — a store, a registry — resolves it
 * once inside its own `useState` initializer. A component that has to HAND a clock
 * to something it renders has nowhere to put that pin, and the real arm of
 * `consoleClockFor` mints a fresh `RealClock` per call: read straight from a render
 * body, the value would have a new identity on every pass, and every consumer that
 * treats a clock as a resource identity would tear itself down and rebuild once per
 * render. So the resolution is `useState` for the same reason the bridge resolution
 * itself is — a resource identity is state and is never recomputed.
 *
 * A window's clock cannot change under it: the fixture arm reads the running
 * engine's frozen clock, which the provider replaces only by remounting the tree
 * below it, and every `RealClock` reads the same wall clock. So pinning loses
 * nothing.
 */
export function useConsoleClock(): ConsoleClock {
  const bridge = useConsoleBridge();
  const [clock] = useState<ConsoleClock>(() => consoleClockFor(bridge));
  return clock;
}

/** The resolution including its failure arm, for the frame's own error surface. */
export function useBridgeResolution(): BridgeResolution {
  const resolution = useContext(BridgeContext);
  if (resolution === undefined) {
    throw new Error(
      "useConsoleBridge was called outside <SidekicksBridgeProvider>. Every console surface renders inside the provider so the fixture is substitutable.",
    );
  }
  return resolution;
}
