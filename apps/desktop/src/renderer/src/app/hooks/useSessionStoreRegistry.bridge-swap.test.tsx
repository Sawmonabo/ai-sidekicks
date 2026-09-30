// The window's plumbing belongs to the bridge it was built from. `PlatformBridgeProvider`
// replaces its resolution when the `bridge` prop changes (a reconnect, the fixture's scenario
// switch), and a hook that did not re-mint the registry and subscriber in that same render would
// commit a frame pairing the new bridge with the old plumbing: a live session that never changes.
// The claim is about every committed frame, not where the window settles, so each case records
// which bridge every render was handed alongside which registry and asserts over all of them.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixture } from "@test/helpers/fixture-bridge.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { EntityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { type SessionSnapshotReader } from "@renderer/store/session/open-session-entry.js";
import { type SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { useSessionStoreRegistry } from "./useSessionStoreRegistry.js";

const readNothing: SessionSnapshotReader = () => Promise.resolve(undefined);

/** What one committed render was handed, read in the render body rather than after. */
interface Observation {
  readonly bridge: PlatformBridge;
  readonly registry: SessionStoreRegistry;
}

/** The projector board and the observer a probe reports to. */
interface RegistryProbeProps {
  readonly projectorRegistry: EntityProjectorRegistry;
  readonly onObserve: (observation: Observation) => void;
}

/** A component that owns a window's plumbing and reports what it was handed. */
function RegistryProbe(props: RegistryProbeProps): null {
  const bridge = usePlatformBridge();
  const registry = useSessionStoreRegistry(props.projectorRegistry, readNothing);
  props.onObserve({ bridge, registry });
  return null;
}

/** The bridge the host currently serves, plus the probe's props. */
interface SwapHostProps extends RegistryProbeProps {
  readonly bridge: PlatformBridge;
}

/** Provides one bridge to a probe. */
function SwapHost(props: SwapHostProps): React.JSX.Element {
  return (
    <PlatformBridgeProvider bridge={props.bridge}>
      <RegistryProbe projectorRegistry={props.projectorRegistry} onObserve={props.onObserve} />
    </PlatformBridgeProvider>
  );
}

/** A mounted window and the handles to re-render or unmount it. */
interface SwapHarness {
  /** Every committed render, in order. */
  readonly observed: readonly Observation[];
  /** Every distinct registry that answered a render, in the order it appeared. */
  readonly registries: () => readonly SessionStoreRegistry[];
  /** Re-render under a bridge, and optionally a different projector board. */
  readonly renderAgainst: (
    bridge: PlatformBridge,
    projectorRegistry?: EntityProjectorRegistry,
  ) => void;
  readonly unmount: () => void;
}

/**
 * Mount a window against one bridge and keep the handle that re-renders it under another.
 *
 * The projector board is built once and empty: which fold a store opens with is the
 * registry-wiring suite's subject, and only the last case here varies the board on purpose.
 */
function mountAgainst(bridge: PlatformBridge): SwapHarness {
  const observed: Observation[] = [];
  const record = (observation: Observation): void => {
    observed.push(observation);
  };
  const firstBoard = new EntityProjectorRegistry();
  const hostFor = (against: PlatformBridge, board: EntityProjectorRegistry): React.JSX.Element => (
    <SwapHost bridge={against} projectorRegistry={board} onObserve={record} />
  );
  const mounted = render(hostFor(bridge, firstBoard));
  return {
    observed,
    registries: (): readonly SessionStoreRegistry[] => [
      ...new Set(observed.map((observation) => observation.registry)),
    ],
    renderAgainst: (next: PlatformBridge, board: EntityProjectorRegistry = firstBoard): void => {
      mounted.rerender(hostFor(next, board));
    },
    unmount: (): void => {
      mounted.unmount();
    },
  };
}

describe("useSessionStoreRegistry — the plumbing follows the bridge", () => {
  it("never hands one registry to two different bridges", () => {
    // A plumbing that outlived its bridge is one registry two bridges both rendered against.
    const harness = mountAgainst(createFixture().bridge);

    harness.renderAgainst(createFixture().bridge);

    const bridgesPerRegistry = new Map<SessionStoreRegistry, Set<PlatformBridge>>();
    for (const observation of harness.observed) {
      const bridges = bridgesPerRegistry.get(observation.registry) ?? new Set<PlatformBridge>();
      bridges.add(observation.bridge);
      bridgesPerRegistry.set(observation.registry, bridges);
    }
    const shared = [...bridgesPerRegistry.values()].filter((bridges) => bridges.size > 1);
    expect(shared).toStrictEqual([]);

    harness.unmount();
  });

  it("re-mints the plumbing under a new bridge and disposes the one it replaced", () => {
    const harness = mountAgainst(createFixture().bridge);
    const retired = harness.registries().at(-1);
    expect(retired).toBeDefined();
    if (retired === undefined) {
      return;
    }

    harness.renderAgainst(createFixture().bridge);

    const current = harness.registries().at(-1);
    expect(harness.registries()).toHaveLength(2);
    expect(current).not.toBe(retired);
    // Dropping is not enough: an undisposed registry leaves its apply queues and refresh
    // schedulers running against a bridge nobody reads.
    expect(retired.isDisposed).toBe(true);
    expect(current?.isDisposed).toBe(false);

    harness.unmount();
  });

  it("answers a re-render under the same bridge with the same registry", () => {
    // Control: a hook that re-minted on every render would pass the cases above and fail here.
    const bridge = createFixture().bridge;
    const harness = mountAgainst(bridge);

    harness.renderAgainst(bridge);
    harness.renderAgainst(bridge);

    expect(harness.observed.length).toBeGreaterThan(2);
    expect(harness.registries()).toHaveLength(1);
    expect(harness.registries()[0]?.isDisposed).toBe(false);

    harness.unmount();
  });

  it("re-mints again on the way back, rather than reviving the one it disposed", () => {
    // Compared against the bridge the plumbing is currently held under, not the first one seen;
    // remembering only the original bridge would hand back the disposed registry.
    const serving = createFixture().bridge;
    const harness = mountAgainst(serving);
    const first = harness.registries().at(-1);

    harness.renderAgainst(createFixture().bridge);
    harness.renderAgainst(serving);

    const registries = harness.registries();
    const third = registries.at(-1);
    expect(registries).toHaveLength(3);
    expect(third).not.toBe(first);
    expect(third?.isDisposed).toBe(false);
    expect(registries.slice(0, 2).every((registry) => registry.isDisposed)).toBe(true);

    harness.unmount();
  });

  it("leaves live plumbing alone when a dependency that is not its subject changes", () => {
    // The projector board is not the plumbing's subject: the registry snapshots it at
    // construction, and disposing the live registry for a board change would leave every
    // `useOpenSessionStore` consumer reading through a disposed one.
    const bridge = createFixture().bridge;
    const harness = mountAgainst(bridge);
    const live = harness.registries().at(-1);
    expect(live).toBeDefined();

    harness.renderAgainst(bridge, new EntityProjectorRegistry());

    expect(harness.registries()).toHaveLength(1);
    expect(harness.registries()[0]).toBe(live);
    expect(live?.isDisposed).toBe(false);

    // Negative control: a new bridge still retires it, so the claim is about which dependency
    // decides, not a hook that stopped re-minting.
    harness.renderAgainst(createFixture().bridge);
    expect(harness.registries()).toHaveLength(2);
    expect(live?.isDisposed).toBe(true);

    harness.unmount();
  });

  it("disposes the registry it is holding when the window goes away", () => {
    const harness = mountAgainst(createFixture().bridge);
    harness.renderAgainst(createFixture().bridge);
    expect(harness.registries().at(-1)?.isDisposed).toBe(false);

    harness.unmount();

    expect(harness.registries().every((registry) => registry.isDisposed)).toBe(true);
  });
});
