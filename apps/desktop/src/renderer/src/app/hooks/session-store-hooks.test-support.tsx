// What every session-lifecycle suite needs before it can render anything: the probe component
// that does what the frame does and reports what it saw, and the bridge host it renders inside.
// Helpers with a single reader stay beside that reader.

import { useRef, type ReactNode } from "react";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { type ScenarioEngine } from "@renderer/services/daemon/engine.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { EntityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { type SessionSnapshotReader } from "@renderer/store/session/open-session-entry.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import {
  RUN_LIFECYCLE_PROJECTOR_OWNER,
  RUN_LIFECYCLE_PROJECTORS,
} from "@renderer/store/session-events/run-lifecycle-projector.js";
import { useActiveSessionStore } from "./useActiveSessionStore.js";
import { useSessionStoreRegistry } from "./useSessionStoreRegistry.js";
import { fixtureSessionSnapshot } from "@renderer/services/daemon/session-snapshot.fixture.js";

/** What a probe saw on one render: the window's registry and the active session's store. */
export interface Observation {
  readonly registry: SessionStoreRegistry;
  readonly store: SessionStore | undefined;
}

/** The session a probe opens, the observer it reports to, and an optional projector board. */
export interface SessionProbeProps {
  readonly sessionId: string;
  readonly onObserve: (observation: Observation) => void;
  /**
   * The fold this probe's stores open with; absent means the run-lifecycle projectors the
   * console composes. Optional here because the probe stands in for `AppProviders`; a case about
   * the fold passes its own, which keeps it out of the process-wide board.
   */
  readonly projectorRegistry?: EntityProjectorRegistry;
}

/** One fixture bridge and the provider that serves it, for a case that drives both. */
export interface FixtureBridgeHarness {
  readonly bridge: PlatformBridge;
  readonly scenarioEngine: ScenarioEngine;
  readonly wrapper: (props: { readonly children: ReactNode }) => React.JSX.Element;
}

/** The flagship scenario's base state for a session, standing in for the window's read. */
const readFlagshipSession: SessionSnapshotReader = (sessionId) =>
  Promise.resolve(fixtureSessionSnapshot(CONCURRENT_STREAMING_SCENARIO, sessionId));

/** A component that does exactly what the frame does, and reports what it saw. */
export function SessionProbe(props: SessionProbeProps): null {
  const projectorRegistry = useDefaultedProjectorRegistry(props.projectorRegistry);
  const registry = useSessionStoreRegistry(projectorRegistry, readFlagshipSession);
  const store = useActiveSessionStore(registry, props.sessionId);
  props.onObserve({ registry, store });
  return null;
}

/**
 * A fixture bridge and the provider around it.
 *
 * Built once per case and closed over, because the provider resolves on bridge identity: a new
 * fixture per render would restart the scenario engine and reset the frozen clock.
 */
export function fixtureBridgeHarness(): FixtureBridgeHarness {
  const { bridge, scenarioEngine } = createFixtureBridge({
    scenario: CONCURRENT_STREAMING_SCENARIO,
  });
  return {
    bridge,
    scenarioEngine,
    wrapper: function FixtureBridgeHost(props: {
      readonly children: ReactNode;
    }): React.JSX.Element {
      return (
        <PlatformBridgeProvider bridge={bridge} clock={scenarioEngine.clock}>
          {props.children}
        </PlatformBridgeProvider>
      );
    },
  };
}

/** The provider alone, for the cases that never touch the scenario's clock. */
export function fixtureBridgeWrapper(): (props: {
  readonly children: ReactNode;
}) => React.JSX.Element {
  return fixtureBridgeHarness().wrapper;
}

/** The probe's newest observation; throws when it never rendered. */
export function lastObservation(observed: readonly Observation[]): Observation {
  const observation = observed.at(-1);
  if (observation === undefined) {
    throw new Error("the probe never rendered");
  }
  return observation;
}

/**
 * The caller's projector board, or a fresh one seeded the way the console seeds its own.
 *
 * Held in a ref so the board is stable across renders, and fresh per mount rather than module
 * scope so one case's probe kinds never reach another's.
 */
function useDefaultedProjectorRegistry(
  supplied: EntityProjectorRegistry | undefined,
): EntityProjectorRegistry {
  const fallbackRef = useRef<EntityProjectorRegistry>(undefined);
  if (supplied !== undefined) {
    return supplied;
  }
  if (fallbackRef.current === undefined) {
    const fallback = new EntityProjectorRegistry();
    fallback.registerAll(RUN_LIFECYCLE_PROJECTORS, RUN_LIFECYCLE_PROJECTOR_OWNER);
    fallbackRef.current = fallback;
  }
  return fallbackRef.current;
}
