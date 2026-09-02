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

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ConsoleBridge } from "./console-bridge.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import { createLiveBridge, readInstalledBridge } from "./live-bridge.js";
import { consoleScenario } from "./scenario-manifest.js";
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
 * Resolve the bridge once and hand it down. `useMemo` with a stable dependency set
 * is load-bearing rather than decorative: re-creating the fixture would restart the
 * scenario engine on every render and reset the frozen clock mid-frame.
 */
export function SidekicksBridgeProvider(props: SidekicksBridgeProviderProps): React.JSX.Element {
  const { children, bridge, scenarioId } = props;
  const resolution = useMemo<BridgeResolution>(() => {
    if (bridge !== undefined) {
      return { status: "ready", bridge };
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
  }, [bridge, scenarioId]);

  return <BridgeContext.Provider value={resolution}>{children}</BridgeContext.Provider>;
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
