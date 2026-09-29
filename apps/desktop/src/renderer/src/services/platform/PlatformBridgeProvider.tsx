// The bridge provider: one context, one decision, made once at mount.
//
// A window handed a bridge plays it; one handed a composition plays what the composition
// builds; one handed neither reads the preload. The provider holds no fixture branch: the
// fixture launch is a composition built in `app/`, and a release build has none to hand
// over. The context holds a `PlatformBridge` and nothing else; no component reads
// `window.desktopBridge` or subscribes to a bridge event directly.
//
// The resolution carries the clock the window runs on beside the bridge: a composition's
// own clock, the one a caller hands over with its bridge, or one `RealClock` for a window
// that reads the preload.
//
// The resolution is state, not a memo. A composition may build a `ScenarioEngine`, a mutable
// resource (subscriptions, an advanced frozen clock, parked replies); React may discard and
// recompute a memo, which would start a second engine at tick zero mid-scenario. A resource
// also has an end, so replacement and teardown are explicit, and the provider disposes only
// what it built, never what a caller handed it.

import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { RealClock, type Clock } from "@renderer/lib/clock.js";
import { ForwardingClock } from "@renderer/lib/forwarding-clock.js";
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
   * A clock identity minted outside the tree, rebound onto the resolution's clock.
   * The composition root arms the tripwire route at module scope, before any bridge exists,
   * so its clock is a `ForwardingClock` passed in rather than reached for.
   */
  readonly clockToRebind?: ForwardingClock;
}

/**
 * Resolve the bridge once and hand it down.
 *
 * The resolution is held as STATE, replaced only when the props it was resolved
 * from change or what it built has been torn down — see the module header for why
 * neither a memo nor a plain re-creation is correct for a resource with a lifetime.
 */
export function PlatformBridgeProvider(props: PlatformBridgeProviderProps): React.JSX.Element {
  const { children, bridge, clock, composition, clockToRebind } = props;
  const [resolved, setResolved] = useState<ResolvedConsoleBridge>(
    () => new ResolvedConsoleBridge(bridge, clock, composition),
  );

  // The one clock the window reads, handed to the identity a caller armed before this
  // tree existed. From the LAYOUT phase for `useClock`'s own reason: every
  // layout effect for a commit runs before any passive effect for it, so a consumer
  // reading time from an effect reads the clock this commit resolved. An unavailable
  // resolution has no clock to hand over and leaves the identity on whatever it was
  // constructed with, which is the honest reading for a window that has no bridge.
  useLayoutEffect(() => {
    const resolution = resolved.resolution;
    if (clockToRebind === undefined || resolution.status !== "ready") {
      return;
    }
    clockToRebind.holdClock(resolution.clock);
  }, [clockToRebind, resolved]);

  // One effect, because replacement and installation are one decision made in one
  // order: the previous resolution's teardown has already run by the time this
  // body sees a superseded one, so the replacement never disposes something a
  // later commit still reads. Installed from an effect rather than during render
  // because React may discard a render pass, and a handle installed during one would
  // point at an engine no window is reading.
  useEffect(() => {
    if (resolved.isSupersededBy(bridge, clock, composition)) {
      setResolved(new ResolvedConsoleBridge(bridge, clock, composition));
      return undefined;
    }
    return resolved.install();
  }, [resolved, bridge, clock, composition]);

  return (
    <BridgeCompositionContext.Provider value={composition}>
      <BridgeContext.Provider value={resolved.resolution}>{children}</BridgeContext.Provider>
    </BridgeCompositionContext.Provider>
  );
}

/**
 * One resolved bridge, the inputs it was resolved from, and what this provider built.
 *
 * A class rather than a bare object because the two questions a caller asks of it
 * are rules rather than fields — is this still the right resolution for these
 * props, and what does tearing it down actually mean — and both have an answer
 * that depends on whether the bridge was BUILT here or handed in. A caller's
 * bridge outlives this provider; one built here does not.
 */
class ResolvedConsoleBridge {
  readonly #suppliedBridge: PlatformBridge | undefined;
  readonly #suppliedClock: Clock | undefined;
  readonly #composition: BridgeComposition | undefined;
  /** What a composition built here. `undefined` when the caller supplied the bridge. */
  readonly #composed: ComposedBridge | undefined;
  readonly #resolution: BridgeResolution;

  public constructor(
    suppliedBridge: PlatformBridge | undefined,
    suppliedClock: Clock | undefined,
    composition: BridgeComposition | undefined,
  ) {
    this.#suppliedBridge = suppliedBridge;
    this.#suppliedClock = suppliedClock;
    this.#composition = composition;
    this.#composed =
      suppliedBridge === undefined && composition !== undefined
        ? composition.createBridge()
        : undefined;
    this.#resolution = resolveBridge(suppliedBridge, suppliedClock, this.#composed);
  }

  public get resolution(): BridgeResolution {
    return this.#resolution;
  }

  /**
   * Is this resolution no longer the right one to serve?
   *
   * Two arms. The props it was resolved from changed, which is a deliberate
   * replacement; or what it built has been disposed, which is the re-mint arm a
   * double mount takes — React's StrictMode tears an effect down and runs it
   * again, the teardown has already disposed the engine, and a second mount must
   * take a fresh one rather than a corpse.
   *
   * The two window-lifetime resources one layer down answer the same pair, but in
   * two places rather than one: `app/hooks/useSessionStoreRegistry.ts` and
   * `app/hooks/useUiStateStore.ts` compare the bridge DURING the render that first
   * sees a new one — `hooks/subject-scoped/useSubjectScopedResource.ts` is what holds
   * that comparison — and keep only the disposed arm in an effect, because a resource
   * that tore itself down did so in a cleanup the preceding render could not see. This
   * one cannot split the same way: it is deciding what the bridge IS, so there is no
   * resolved subject to compare against during render.
   */
  public isSupersededBy(
    suppliedBridge: PlatformBridge | undefined,
    suppliedClock: Clock | undefined,
    composition: BridgeComposition | undefined,
  ): boolean {
    if (
      suppliedBridge !== this.#suppliedBridge ||
      suppliedClock !== this.#suppliedClock ||
      composition !== this.#composition
    ) {
      return true;
    }
    return this.#composed?.disposal.isDisposed === true;
  }

  /**
   * Put the handles for the bridge the composition built on the page, and return the
   * teardown for them and for what was built.
   *
   * A supplied bridge installs nothing: its caller owns it, and whatever a driver reads
   * about it is the caller's to put up.
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
): BridgeResolution {
  if (suppliedBridge !== undefined) {
    return { status: "ready", bridge: suppliedBridge, clock: suppliedClock ?? new RealClock() };
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
        detail:
          "This window loaded without its preload bridge, so it cannot reach the background service or the control plane. Reopening the window usually fixes it; if it does not, the app needs restarting.",
      },
    };
  }
  return { status: "ready", bridge: createLiveBridge(installed), clock: new RealClock() };
}
