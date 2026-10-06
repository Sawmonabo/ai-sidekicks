// The bridge provider: one context, one decision, made once at mount. A window handed a bridge
// plays it, one handed a composition plays what the composition builds, and one handed neither
// reads the preload. The context holds a `PlatformBridge` and nothing else, and the provider
// disposes only what it built, never what a caller handed it. The resolution carries the window's
// clock beside the bridge.
//
// The resolution is state, not a memo: a composition may build a mutable `ScenarioEngine`, and
// React may discard and recompute a memo, which would start a second engine at tick zero
// mid-scenario.

import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { RealClock, type Clock, type FrameScheduling } from "#renderer/lib/clock.js";
import { ForwardingClock } from "#renderer/lib/forwarding-clock.js";
import type { PlatformBridge } from "./platform-bridge.js";
import {
  BridgeCompositionContext,
  BridgeContext,
  type BridgeComposition,
  type BridgeResolution,
  type ComposedBridge,
} from "./bridge-context.js";
import { createLiveBridge, readInstalledBridge } from "./live-bridge.js";

/** The bridge provider's props. */
export interface PlatformBridgeProviderProps {
  readonly children: ReactNode;
  /** A bridge to play as it is. Tests pass a fixture directly; a composition owns none of it. */
  readonly bridge?: PlatformBridge;
  /** The clock a supplied bridge's window runs on. Absent, it runs on real time. */
  readonly clock?: Clock;
  /** How to build the bridge when none is handed over. Absent, the window reads the preload. */
  readonly composition?: BridgeComposition;
  /**
   * Where a real-time clock takes its frames: the console's open windows, since the document the
   * provider mounts in never paints. Absent, this document's own frames.
   */
  readonly frames?: FrameScheduling;
  /**
   * A clock identity minted outside the tree, rebound onto the resolution's clock.
   * The composition root arms the tripwire route at module scope, before any bridge exists,
   * so its clock is a `ForwardingClock` passed in rather than reached for.
   */
  readonly clockToRebind?: ForwardingClock;
}

/**
 * Resolves the bridge once and hands it down. The resolution is held as state and replaced only
 * when its inputs change or what it built has been torn down.
 */
export function PlatformBridgeProvider(props: PlatformBridgeProviderProps): React.JSX.Element {
  const { children, bridge, clock, composition, frames, clockToRebind } = props;
  const [resolved, setResolved] = useState<ResolvedPlatformBridge>(
    () => new ResolvedPlatformBridge(bridge, clock, composition, frames),
  );

  // Hands the window's one clock to the identity armed before this tree existed. It runs in the
  // layout phase so every passive effect of a commit reads the clock that commit resolved. An
  // unavailable resolution has no clock, so the identity keeps the one it was constructed with.
  useLayoutEffect(() => {
    const resolution = resolved.resolution;
    if (clockToRebind === undefined || resolution.status !== "ready") {
      return;
    }
    clockToRebind.holdClock(resolution.clock);
  }, [clockToRebind, resolved]);

  // One effect because replacement and installation are one decision: the previous resolution's
  // teardown has already run when this sees a superseded one. It installs from an effect because
  // React may discard a render pass, and a handle installed then would point at an unread engine.
  useEffect(() => {
    if (resolved.isSupersededBy(bridge, clock, composition, frames)) {
      setResolved(new ResolvedPlatformBridge(bridge, clock, composition, frames));
      return undefined;
    }
    return resolved.install();
  }, [resolved, bridge, clock, composition, frames]);

  return (
    <BridgeCompositionContext.Provider value={composition}>
      <BridgeContext.Provider value={resolved.resolution}>{children}</BridgeContext.Provider>
    </BridgeCompositionContext.Provider>
  );
}

/**
 * One resolved bridge, the inputs it was resolved from, and what this provider built. A class
 * because whether it is still right for the props, and what teardown means, both depend on
 * whether the bridge was built here or handed in; a caller's bridge outlives this provider.
 */
class ResolvedPlatformBridge {
  readonly #suppliedBridge: PlatformBridge | undefined;
  readonly #suppliedClock: Clock | undefined;
  readonly #composition: BridgeComposition | undefined;
  readonly #frames: FrameScheduling | undefined;
  /** What a composition built here. `undefined` when the caller supplied the bridge. */
  readonly #composed: ComposedBridge | undefined;
  readonly #resolution: BridgeResolution;

  public constructor(
    suppliedBridge: PlatformBridge | undefined,
    suppliedClock: Clock | undefined,
    composition: BridgeComposition | undefined,
    frames: FrameScheduling | undefined,
  ) {
    this.#suppliedBridge = suppliedBridge;
    this.#suppliedClock = suppliedClock;
    this.#composition = composition;
    this.#frames = frames;
    this.#composed =
      suppliedBridge === undefined && composition !== undefined
        ? composition.createBridge()
        : undefined;
    this.#resolution = resolveBridge(
      suppliedBridge,
      suppliedClock,
      this.#composed,
      new RealClock(frames),
    );
  }

  public get resolution(): BridgeResolution {
    return this.#resolution;
  }

  /**
   * Whether this resolution is no longer the right one to serve: its inputs changed, or what it
   * built was disposed, as when StrictMode tears an effect down and reruns it and the second mount
   * must not take a disposed engine. The window-lifetime resources in `app/hooks/` compare the
   * bridge during render via `useSubjectScopedResource`; this one cannot, because it decides what
   * the bridge is and has no resolved subject to compare against.
   */
  public isSupersededBy(
    suppliedBridge: PlatformBridge | undefined,
    suppliedClock: Clock | undefined,
    composition: BridgeComposition | undefined,
    frames: FrameScheduling | undefined,
  ): boolean {
    if (
      suppliedBridge !== this.#suppliedBridge ||
      suppliedClock !== this.#suppliedClock ||
      composition !== this.#composition ||
      frames !== this.#frames
    ) {
      return true;
    }
    return this.#composed?.disposal.isDisposed === true;
  }

  /**
   * Puts the handles for a composition-built bridge on the page and returns the teardown for them
   * and for what was built. A supplied bridge installs nothing; its caller owns it.
   */
  public install(): () => void {
    const composed = this.#composed;
    if (composed === undefined) {
      return () => undefined;
    }
    const removeHandles = composed.installHandles();
    return () => {
      removeHandles();
      composed.disposal.dispose();
    };
  }
}

function resolveBridge(
  suppliedBridge: PlatformBridge | undefined,
  suppliedClock: Clock | undefined,
  composed: ComposedBridge | undefined,
  realClock: Clock,
): BridgeResolution {
  if (suppliedBridge !== undefined) {
    return { status: "ready", bridge: suppliedBridge, clock: suppliedClock ?? realClock };
  }
  if (composed !== undefined) {
    return { status: "ready", bridge: composed.bridge, clock: composed.clock };
  }
  const installed = readInstalledBridge();
  if (installed === undefined) {
    return {
      status: "unavailable",
      unavailable: {
        reason: "preload-did-not-run",
        detail: "Reopening the window usually fixes it; if it does not, the app needs restarting.",
      },
    };
  }
  return { status: "ready", bridge: createLiveBridge(installed), clock: realClock };
}
