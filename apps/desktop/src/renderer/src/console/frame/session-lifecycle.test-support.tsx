// What every session-lifecycle suite needs before it can render anything.
//
// One home for the two roles more than one of the sibling suites plays: the probe
// component that does exactly what the frame does and reports what it saw, and the
// bridge host it renders inside. It holds nothing a single suite uses — the event
// builders, the store-identity comparison, and the diagnostics handle each have one
// reader and stay beside it.

import type { ReactNode } from "react";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  type ConsoleBridge,
} from "../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import type { SessionStore, SessionStoreRegistry } from "../store/index.js";
import { useActiveSessionStore, useSessionStoreRegistry } from "./session-lifecycle.js";

export interface Observation {
  readonly registry: SessionStoreRegistry;
  readonly store: SessionStore | undefined;
}

export interface SessionProbeProps {
  readonly sessionId: string;
  readonly onObserve: (observation: Observation) => void;
}

/** A component that does exactly what the frame does, and reports what it saw. */
export function SessionProbe(props: SessionProbeProps): null {
  const registry = useSessionStoreRegistry();
  const store = useActiveSessionStore(registry, props.sessionId);
  props.onObserve({ registry, store });
  return null;
}

/** One fixture bridge and the provider that serves it, for a case that drives both. */
export interface FixtureBridgeHarness {
  readonly bridge: ConsoleBridge;
  readonly wrapper: (props: { readonly children: ReactNode }) => React.JSX.Element;
}

/**
 * A fixture bridge and the provider around it.
 *
 * Built once per case and closed over, because the provider resolves on bridge
 * IDENTITY: a wrapper that made a new fixture on every render would restart the
 * scenario engine mid-pass and reset the frozen clock underneath it.
 */
export function fixtureBridgeHarness(): FixtureBridgeHarness {
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  return {
    bridge,
    wrapper: function FixtureBridgeHost(props: {
      readonly children: ReactNode;
    }): React.JSX.Element {
      return <SidekicksBridgeProvider bridge={bridge}>{props.children}</SidekicksBridgeProvider>;
    },
  };
}

/** The provider alone, for the cases that never touch the scenario's clock. */
export function fixtureBridgeWrapper(): (props: {
  readonly children: ReactNode;
}) => React.JSX.Element {
  return fixtureBridgeHarness().wrapper;
}

export function lastObservation(observed: readonly Observation[]): Observation {
  const observation = observed.at(-1);
  if (observation === undefined) {
    throw new Error("the probe never rendered");
  }
  return observation;
}
