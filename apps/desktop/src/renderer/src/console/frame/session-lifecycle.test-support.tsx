// What every session-lifecycle suite needs before it can render anything.
//
// One home for the two roles more than one of the sibling suites plays: the probe
// component that does exactly what the frame does and reports what it saw, and the
// bridge host it renders inside. It holds nothing a single suite uses — the event
// builders, the store-identity comparison, and the diagnostics handle each have one
// reader and stay beside it.

import { useRef, type ReactNode } from "react";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  type ConsoleBridge,
} from "../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import {
  ConsoleEntityProjectorRegistry,
  type SessionStore,
  type SessionStoreRegistry,
} from "../store/index.js";
import { registerRunLifecycleProjectors } from "./run-lifecycle-projector.js";
import { useActiveSessionStore, useSessionStoreRegistry } from "./session-lifecycle.js";

export interface Observation {
  readonly registry: SessionStoreRegistry;
  readonly store: SessionStore | undefined;
}

export interface SessionProbeProps {
  readonly sessionId: string;
  readonly onObserve: (observation: Observation) => void;
  /**
   * The fold this probe's stores open with. Absent means "what the console composes".
   *
   * Optional HERE and required on the hook, which is the distinction that matters:
   * the hook is the production seam and takes its board from the caller so no window
   * writes into a registry it did not name, while this probe stands in for
   * `ConsoleRoot` and every case that is not about the fold would otherwise have to
   * compose one to say nothing about it. A case that IS about the fold passes its
   * own, which is also what keeps it out of the process-wide board.
   */
  readonly projectorRegistry?: ConsoleEntityProjectorRegistry;
}

/** A component that does exactly what the frame does, and reports what it saw. */
export function SessionProbe(props: SessionProbeProps): null {
  const projectorRegistry = useDefaultedProjectorRegistry(props.projectorRegistry);
  const registry = useSessionStoreRegistry(projectorRegistry);
  const store = useActiveSessionStore(registry, props.sessionId);
  props.onObserve({ registry, store });
  return null;
}

/**
 * The caller's projector board, or a fresh one seeded the way the console seeds its
 * own.
 *
 * A ref rather than a construction in the render body, on `ConsoleRoot`'s own
 * precedent for the frame and draft stores: the hook below keys its plumbing on this
 * identity, so a board rebuilt on every render would re-mint the window's registry
 * under it. Fresh per mount rather than module-scope, so one case's probe kinds never
 * reach another's.
 */
function useDefaultedProjectorRegistry(
  supplied: ConsoleEntityProjectorRegistry | undefined,
): ConsoleEntityProjectorRegistry {
  const fallbackRef = useRef<ConsoleEntityProjectorRegistry>(undefined);
  if (supplied !== undefined) {
    return supplied;
  }
  if (fallbackRef.current === undefined) {
    const fallback = new ConsoleEntityProjectorRegistry();
    registerRunLifecycleProjectors(fallback);
    fallbackRef.current = fallback;
  }
  return fallbackRef.current;
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
