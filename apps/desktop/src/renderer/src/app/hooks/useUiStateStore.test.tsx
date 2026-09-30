// The window's database connection is opened once and closed once. An open IndexedDB connection
// blocks the next version upgrade, so cases assert through a write, not `isClosed`: a store whose
// adapter is really closed refuses. The probe records what the hook returned in the render body,
// because an effect would see only committed renders and the question is which stores a double
// mount minted.
//
// The last suite drives the provider replacing the bridge: the store reads its clock off that
// bridge, so a kept store would stamp records, and order the LRU trim, from a scenario switched
// away from. The claim is about every committed frame, so the pairing is recorded per render; the
// stamp carries the settled half, since two scenarios declare different `startedAtIso`.

import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import { FIRST_RUN_SCENARIO } from "../../../../../fixtures/scenarios/first-run.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { SCHEME_PREFERENCE_KEY } from "@renderer/store/persistence/persistence-adapter.js";
import { type UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { settle as settleReactWork } from "@test/helpers/settle.js";

import { useUiStateStore } from "./useUiStateStore.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";

/** The sink a probe reports each returned store to. */
interface StoreProbeProps {
  readonly onStore: (store: UiStateStore) => void;
}

/** Renders the hook and reports the store it returned. */
function StoreProbe(props: StoreProbeProps): null {
  props.onStore(useUiStateStore());
  return null;
}

/**
 * Mount, then flush twice: `UiStateStore.opening` chains two promises and the re-mint adds an
 * update.
 */
async function mountProbe(strict: boolean): Promise<{
  readonly unmount: () => void;
  readonly stores: readonly UiStateStore[];
}> {
  const stores: UiStateStore[] = [];
  const record = (store: UiStateStore): void => {
    if (!stores.includes(store)) {
      stores.push(store);
    }
  };
  // The hook reads its clock from the bridge, so the probe renders inside a provider with a
  // supplied fixture bridge, which the provider never disposes or re-resolves. `StrictMode`
  // wraps the provider because React simulates the remount only for the tree it roots.
  const fixture = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
  const tree = (
    <FixtureBridgeProvider fixture={fixture}>
      <StoreProbe onStore={record} />
    </FixtureBridgeProvider>
  );
  let mounted: ReturnType<typeof render> | undefined;
  await act(async () => {
    mounted = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    await crossMacrotaskBoundary();
  });
  if (mounted === undefined) {
    throw new Error("the probe never mounted");
  }
  const toUnmount = mounted;
  return {
    unmount: () => {
      toUnmount.unmount();
    },
    stores,
  };
}

/** Does this store still have a connection to write through? */
async function acceptsAWrite(store: UiStateStore): Promise<boolean> {
  const result = await store.writeGlobal(SCHEME_PREFERENCE_KEY, "scheme", "dark");
  return result.outcome === "written";
}

afterEach(() => {
  cleanup();
});

describe("useUiStateStore — the connection is closed with the window", () => {
  it("closes the store on unmount, so nothing is left blocking an upgrade", async () => {
    const probe = await mountProbe(false);
    const store = probe.stores.at(-1);
    expect(store).toBeDefined();
    if (store === undefined) {
      return;
    }

    probe.unmount();
    await settleReactWork();

    expect(store.isClosed).toBe(true);
    const result = await store.writeGlobal(SCHEME_PREFERENCE_KEY, "scheme", "dark");
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("adapter-unavailable");
    }
  });

  it("negative control: the same write lands while the window is still up", async () => {
    // Without this, a store that never worked would satisfy the case above.
    const probe = await mountProbe(false);
    const store = probe.stores.at(-1);
    expect(store).toBeDefined();
    if (store === undefined) {
      return;
    }

    await expect(acceptsAWrite(store)).resolves.toBe(true);

    probe.unmount();
    await settleReactWork();
  });
});

describe("useUiStateStore — a StrictMode double mount leaves exactly one open store", () => {
  it("re-mints the store its own teardown closed, and leaves no second one open", async () => {
    const probe = await mountProbe(true);

    // The double mount happened: the simulated teardown closed the first store and the second
    // mount minted another.
    expect(probe.stores.length).toBeGreaterThan(1);
    expect(probe.stores.filter((store) => !store.isClosed)).toHaveLength(1);

    // The survivor is usable; closing without re-minting would leave the window holding a
    // closed store.
    const surviving = probe.stores.at(-1);
    expect(surviving).toBeDefined();
    if (surviving === undefined) {
      return;
    }
    await expect(acceptsAWrite(surviving)).resolves.toBe(true);

    probe.unmount();
    await settleReactWork();
    expect(probe.stores.every((store) => store.isClosed)).toBe(true);
  });
});

/** What one committed render was handed, read in the render body rather than after. */
interface StoreObservation {
  readonly bridge: PlatformBridge;
  readonly store: UiStateStore;
}

/** Reports the bridge and the store the same render resolved. */
function PairProbe(props: { readonly onObserve: (observation: StoreObservation) => void }): null {
  props.onObserve({ bridge: usePlatformBridge(), store: useUiStateStore() });
  return null;
}

/**
 * Mount against one bridge and keep the handle that re-renders under another.
 *
 * It never uses StrictMode, so a simulated remount cannot make a case ambiguous about which arm
 * re-opened the store.
 */
function mountSwappable(fixture: FixtureBridge): {
  readonly observed: readonly StoreObservation[];
  readonly stores: () => readonly UiStateStore[];
  readonly renderAgainst: (next: FixtureBridge) => Promise<void>;
  readonly unmount: () => void;
} {
  const observed: StoreObservation[] = [];
  const record = (observation: StoreObservation): void => {
    observed.push(observation);
  };
  const hostFor = (against: FixtureBridge): React.JSX.Element => (
    <FixtureBridgeProvider fixture={against}>
      <PairProbe onObserve={record} />
    </FixtureBridgeProvider>
  );
  const mounted = render(hostFor(fixture));
  return {
    observed,
    stores: (): readonly UiStateStore[] => [
      ...new Set(observed.map((observation) => observation.store)),
    ],
    renderAgainst: async (next: FixtureBridge): Promise<void> => {
      await act(async () => {
        mounted.rerender(hostFor(next));
        await crossMacrotaskBoundary();
      });
    },
    unmount: (): void => {
      mounted.unmount();
    },
  };
}

/** The clock reading stamped on a record written through this store. */
async function stampWrittenThrough(store: UiStateStore): Promise<number | undefined> {
  await store.writeGlobal(SCHEME_PREFERENCE_KEY, "scheme", "dark");
  const record = await store.readGlobal(SCHEME_PREFERENCE_KEY);
  return record?.updatedAt;
}

/** The stores a committed frame rendered under more than one bridge. */
function storesSharedAcrossBridges(observed: readonly StoreObservation[]): readonly UiStateStore[] {
  const bridgesPerStore = new Map<UiStateStore, Set<PlatformBridge>>();
  for (const observation of observed) {
    const bridges = bridgesPerStore.get(observation.store) ?? new Set<PlatformBridge>();
    bridges.add(observation.bridge);
    bridgesPerStore.set(observation.store, bridges);
  }
  return [...bridgesPerStore].filter(([, bridges]) => bridges.size > 1).map(([store]) => store);
}

describe("useUiStateStore — a replaced bridge retires the store built under the old one", () => {
  it("negative control: the two bridges really do read different times", () => {
    // Without this the stamp assertions would hold over two identical clocks and pass for a
    // hook that ignored the replacement.
    const flagship = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
    const firstRun = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });

    expect(flagship.scenarioEngine.clock.now()).not.toBe(firstRun.scenarioEngine.clock.now());
  });

  it("commits no frame that writes through a store built on another bridge's clock", async () => {
    // Re-opening one commit late would hand the first render under the new bridge a store on
    // the old clock, stamping a record from a scenario the window had left.
    const flagship = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
    const firstRun = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const probe = mountSwappable(flagship);
    await settleReactWork();

    await probe.renderAgainst(firstRun);
    await probe.renderAgainst(flagship);

    expect(storesSharedAcrossBridges(probe.observed)).toStrictEqual([]);

    probe.unmount();
    await settleReactWork();
  });

  it("opens a store on the new bridge's clock and closes the one it replaced", async () => {
    const flagship = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
    const firstRun = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const probe = mountSwappable(flagship);
    await settleReactWork();
    const retired = probe.stores().at(-1);
    expect(retired).toBeDefined();
    if (retired === undefined) {
      return;
    }
    await expect(stampWrittenThrough(retired)).resolves.toBe(flagship.scenarioEngine.clock.now());

    await probe.renderAgainst(firstRun);

    const current = probe.stores().at(-1);
    expect(probe.stores()).toHaveLength(2);
    expect(current).not.toBe(retired);
    expect(current).toBeDefined();
    if (current === undefined) {
      return;
    }
    // Bound to the new bridge's clock.
    await expect(stampWrittenThrough(current)).resolves.toBe(firstRun.scenarioEngine.clock.now());
    // The retired connection is closed, not merely dropped, since an open one blocks the next
    // version upgrade.
    expect(retired.isClosed).toBe(true);
    await expect(acceptsAWrite(retired)).resolves.toBe(false);
    await expect(acceptsAWrite(current)).resolves.toBe(true);

    probe.unmount();
    await settleReactWork();
  });

  it("answers a re-render under the same bridge with the same store", async () => {
    // Control: a hook that re-opened on every render would pass the cases above and fail here.
    const flagship = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
    const probe = mountSwappable(flagship);
    await settleReactWork();

    await probe.renderAgainst(flagship);
    await probe.renderAgainst(flagship);

    expect(probe.observed.length).toBeGreaterThan(2);
    expect(probe.stores()).toHaveLength(1);
    const only = probe.stores()[0];
    expect(only).toBeDefined();
    if (only === undefined) {
      return;
    }
    expect(only.isClosed).toBe(false);
    await expect(acceptsAWrite(only)).resolves.toBe(true);

    probe.unmount();
    await settleReactWork();
  });

  it("re-opens on the way back, rather than reviving the store it closed", async () => {
    // Compared against the bridge the store is currently held under, not the first one seen.
    const flagship = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
    const firstRun = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const probe = mountSwappable(flagship);
    await settleReactWork();
    const first = probe.stores().at(-1);

    await probe.renderAgainst(firstRun);
    await probe.renderAgainst(flagship);

    const stores = probe.stores();
    const third = stores.at(-1);
    expect(stores).toHaveLength(3);
    expect(third).not.toBe(first);
    expect(third).toBeDefined();
    if (third === undefined) {
      return;
    }
    expect(third.isClosed).toBe(false);
    await expect(stampWrittenThrough(third)).resolves.toBe(flagship.scenarioEngine.clock.now());
    expect(stores.slice(0, 2).every((store) => store.isClosed)).toBe(true);

    probe.unmount();
    await settleReactWork();
  });
});
