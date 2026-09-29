// What every session-lifecycle suite needs before it can render anything.
//
// One home for the two roles more than one of the sibling suites plays: the probe
// component that does exactly what the frame does and reports what it saw, and the
// bridge host it renders inside. It holds nothing a single suite uses — the event
// builders, the store-identity comparison, and the diagnostics handle each have one
// reader and stay beside it.

import { useRef, type ReactNode } from "react";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
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
   * `AppProviders` and every case that is not about the fold would otherwise have to
   * compose one to say nothing about it. A case that IS about the fold passes its
   * own, which is also what keeps it out of the process-wide board.
   */
  readonly projectorRegistry?: EntityProjectorRegistry;
}

/** One fixture bridge and the provider that serves it, for a case that drives both. */
export interface FixtureBridgeHarness {
  readonly bridge: ConsoleBridge;
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
 * Built once per case and closed over, because the provider resolves on bridge
 * IDENTITY: a wrapper that made a new fixture on every render would restart the
 * scenario engine mid-pass and reset the frozen clock underneath it.
 */
export function fixtureBridgeHarness(): FixtureBridgeHarness {
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
  return {
    bridge,
    wrapper: function FixtureBridgeHost(props: {
      readonly children: ReactNode;
    }): React.JSX.Element {
      return <PlatformBridgeProvider bridge={bridge}>{props.children}</PlatformBridgeProvider>;
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

/**
 * The caller's projector board, or a fresh one seeded the way the console seeds its
 * own.
 *
 * A ref rather than a construction in the render body, on `AppProviders`'s own
 * precedent for the frame and draft stores: the hook below keys its plumbing on this
 * identity, so a board rebuilt on every render would re-mint the window's registry
 * under it. Fresh per mount rather than module-scope, so one case's probe kinds never
 * reach another's.
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
