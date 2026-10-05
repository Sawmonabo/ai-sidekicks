// What every session-lifecycle suite needs before it can render anything: the probe component
// that does what the frame does and reports what it saw, and the bridge host it renders inside.
// Helpers with a single reader stay beside that reader.

import { useRef, type ReactNode } from "react";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { createFixtureBridge } from "#renderer/services/platform/platform-bridge.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { EntityProjectorRegistry } from "#renderer/registries/entity-projectors/entity-projector-registry.js";
import { type SessionBaseStateReader } from "#renderer/store/session/open-session/open-session-entry.js";
import { type SessionStore } from "#renderer/store/session/session-store.js";
import { type SessionStoreRegistry } from "#renderer/store/session/session-store-registry.js";
import {
  RUN_LIFECYCLE_PROJECTOR_OWNER,
  RUN_LIFECYCLE_PROJECTORS,
} from "#renderer/store/session-events/run/lifecycle-projector.js";
import { useActiveSessionStore } from "./useActiveSessionStore.js";
import { useSessionStoreRegistry } from "./useSessionStoreRegistry.js";
import { fixtureSessionBaseState } from "#renderer/services/daemon/session/base-state.fixture.js";

/** What a probe saw on one render: the window's registry and the active session's store. */
export interface Observation {
  readonly registry: SessionStoreRegistry;
  readonly store: SessionStore | undefined;
}

/** The session a probe opens and the observer it reports to. */
export interface SessionProbeProps {
  readonly sessionId: string;
  readonly onObserve: (observation: Observation) => void;
}

/** The concurrent-streaming scenario's base state for a session, standing in for the read. */
const readConcurrentStreamingSession: SessionBaseStateReader = (sessionId) =>
  Promise.resolve(fixtureSessionBaseState(CONCURRENT_STREAMING_SCENARIO, sessionId));

/** A component that does exactly what the frame does, and reports what it saw. */
export function SessionProbe(props: SessionProbeProps): null {
  const projectorRegistry = useRunLifecycleProjectorRegistry();
  const registry = useSessionStoreRegistry(projectorRegistry, readConcurrentStreamingSession);
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
export function fixtureBridgeWrapper(): (props: {
  readonly children: ReactNode;
}) => React.JSX.Element {
  const { bridge, scenarioEngine } = createFixtureBridge({
    scenario: CONCURRENT_STREAMING_SCENARIO,
  });
  return function FixtureBridgeHost(props: { readonly children: ReactNode }): React.JSX.Element {
    return (
      <PlatformBridgeProvider bridge={bridge} clock={scenarioEngine.clock}>
        {props.children}
      </PlatformBridgeProvider>
    );
  };
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
 * A projector board seeded the way the app seeds its own.
 *
 * Held in a ref so the board is stable across renders, and fresh per mount rather than module
 * scope so one case's probe kinds never reach another's.
 */
function useRunLifecycleProjectorRegistry(): EntityProjectorRegistry {
  const boardRef = useRef<EntityProjectorRegistry>(undefined);
  if (boardRef.current === undefined) {
    const board = new EntityProjectorRegistry();
    board.registerAll(RUN_LIFECYCLE_PROJECTORS, RUN_LIFECYCLE_PROJECTOR_OWNER);
    boardRef.current = board;
  }
  return boardRef.current;
}
