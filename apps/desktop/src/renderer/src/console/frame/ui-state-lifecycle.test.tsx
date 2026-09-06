// The window's database connection is opened once and closed once.
//
// The claim is not about a flag. IndexedDB's contract is that an open connection
// BLOCKS the next version upgrade, so a console that mounted twice in one renderer
// process — a test, a hot reload, a host-level remount — left a connection per mount
// and a later schema change would have waited on windows nobody was looking at. So
// every case here asserts through a WRITE rather than through `isClosed`: a store
// whose adapter is really closed refuses, and a flag that said so while the
// connection stayed open would pass an assertion about the flag.
//
// The probe records what the hook RETURNED, in the render body, on purpose: an
// effect would only see the renders that committed, and the whole question here is
// which stores were minted across a double mount.
//
// The last suite drives the OTHER thing that retires a store: the provider replacing
// the bridge it was built from. The store reads its clock off that bridge, so a
// window that kept its store across the replacement went on stamping every record —
// and ordering the LRU trim that reads only those stamps — from a scenario that had
// been switched away from.
//
// THAT CLAIM IS ABOUT EVERY COMMITTED FRAME, not about where the window settles. The
// shape this replaced settled correctly by accident: its effect listed `bridge` among
// dependencies its body never read, so a replacement closed the LIVE store and
// re-opened only because `close` happens to set `isClosed` before the same effect's
// body reads it — one frame later, with a frame pairing the new bridge and the old
// store already committed in between. An assertion about the end state passes on
// both, so the pairing is recorded per render and asserted over all of them, with the
// stamp — two scenarios declare two different `startedAtIso`, so their frozen clocks
// answer `now()` differently without a single beat being advanced — carrying the
// settled half.

import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  SidekicksBridgeProvider,
  consoleClockFor,
  createFixtureBridge,
  useConsoleBridge,
  type ConsoleBridge,
} from "../bridge/index.js";
import { FIRST_RUN_SCENARIO } from "../bridge/scenarios/first-run.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { SCHEME_PREFERENCE_KEY, type UiStateStore } from "../persistence/index.js";
import { settleReactWork } from "../core/act-settlement.test-support.js";

import { useUiStateStore } from "./ui-state-lifecycle.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";

interface StoreProbeProps {
  readonly onStore: (store: UiStateStore) => void;
}

function StoreProbe(props: StoreProbeProps): null {
  props.onStore(useUiStateStore());
  return null;
}

/**
 * Mount and let the open settle.
 *
 * Two flushes rather than one: `UiStateStore.opening` resolves a promise whose
 * continuation schedules another, and the re-mint arm adds a state update on top of
 * that.
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
  // The hook resolves its clock from the bridge, so the probe renders inside a
  // provider — a SUPPLIED fixture bridge, which the provider never disposes and
  // never re-resolves, so the double mount below stays the probe's alone.
  //
  // `StrictMode` wraps the provider rather than sitting under it, because React
  // simulates the extra unmount-and-remount for the tree it is the ROOT of: with
  // the provider outside it the probe rendered twice and its effect ran once, and
  // the double mount this file exists to drive never happened.
  const tree = (
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario: FLAGSHIP_SCENARIO })}>
      <StoreProbe onStore={record} />
    </SidekicksBridgeProvider>
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
    // Without this, a hook that handed back a store which never worked at all
    // would satisfy the case above.
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

    // The double mount really happened: the first store was closed by the
    // simulated teardown and a second was minted for the second mount. Without
    // this the case below would pass over a StrictMode that never ran.
    expect(probe.stores.length).toBeGreaterThan(1);
    expect(probe.stores.filter((store) => !store.isClosed)).toHaveLength(1);

    // And the surviving one is usable: closing on teardown without re-minting
    // would leave the window holding the corpse.
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
  readonly bridge: ConsoleBridge;
  readonly store: UiStateStore;
}

/** The probe above, plus the bridge the same render resolved. */
function PairProbe(props: { readonly onObserve: (observation: StoreObservation) => void }): null {
  props.onObserve({ bridge: useConsoleBridge(), store: useUiStateStore() });
  return null;
}

/**
 * Mount against one bridge and keep the handle that re-renders under another.
 *
 * Distinct from `mountProbe` above, which exists to drive a StrictMode double mount
 * against one fixed bridge. This one never uses StrictMode: the question is what a
 * changed `bridge` prop does, and a simulated remount on top of it would make every
 * case here ambiguous about which arm re-opened the store.
 */
function mountSwappable(bridge: ConsoleBridge): {
  readonly observed: readonly StoreObservation[];
  readonly stores: () => readonly UiStateStore[];
  readonly renderAgainst: (next: ConsoleBridge) => Promise<void>;
  readonly unmount: () => void;
} {
  const observed: StoreObservation[] = [];
  const record = (observation: StoreObservation): void => {
    observed.push(observation);
  };
  const hostFor = (against: ConsoleBridge): React.JSX.Element => (
    <SidekicksBridgeProvider bridge={against}>
      <PairProbe onObserve={record} />
    </SidekicksBridgeProvider>
  );
  const mounted = render(hostFor(bridge));
  return {
    observed,
    stores: (): readonly UiStateStore[] => [
      ...new Set(observed.map((observation) => observation.store)),
    ],
    renderAgainst: async (next: ConsoleBridge): Promise<void> => {
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
  const bridgesPerStore = new Map<UiStateStore, Set<ConsoleBridge>>();
  for (const observation of observed) {
    const bridges = bridgesPerStore.get(observation.store) ?? new Set<ConsoleBridge>();
    bridges.add(observation.bridge);
    bridgesPerStore.set(observation.store, bridges);
  }
  return [...bridgesPerStore].filter(([, bridges]) => bridges.size > 1).map(([store]) => store);
}

describe("useUiStateStore — a replaced bridge retires the store built under the old one", () => {
  it("negative control: the two bridges really do read different times", () => {
    // Without this the stamp assertions below would hold over two clocks that
    // answered identically, and a hook that ignored the replacement entirely would
    // pass them.
    const flagship = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const firstRun = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });

    expect(consoleClockFor(flagship).now()).not.toBe(consoleClockFor(firstRun).now());
  });

  it("commits no frame that writes through a store built on another bridge's clock", async () => {
    // The case the previous shape failed: it re-opened one commit late, so the render
    // that first saw the new bridge was handed the store built on the old one's clock
    // — and a record written in that frame carried a timestamp from a scenario the
    // window had already left.
    const flagship = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
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
    const flagship = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const firstRun = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const probe = mountSwappable(flagship);
    await settleReactWork();
    const retired = probe.stores().at(-1);
    expect(retired).toBeDefined();
    if (retired === undefined) {
      return;
    }
    await expect(stampWrittenThrough(retired)).resolves.toBe(consoleClockFor(flagship).now());

    await probe.renderAgainst(firstRun);

    const current = probe.stores().at(-1);
    expect(probe.stores()).toHaveLength(2);
    expect(current).not.toBe(retired);
    expect(current).toBeDefined();
    if (current === undefined) {
      return;
    }
    // Bound to the NEW bridge: the clock this store stamps from is that bridge's.
    await expect(stampWrittenThrough(current)).resolves.toBe(consoleClockFor(firstRun).now());
    // And the retired connection is closed rather than merely dropped, which is the
    // whole reason this hook owns a lifetime: an open connection blocks the next
    // version upgrade whether or not anything is still reading through it.
    expect(retired.isClosed).toBe(true);
    await expect(acceptsAWrite(retired)).resolves.toBe(false);
    await expect(acceptsAWrite(current)).resolves.toBe(true);

    probe.unmount();
    await settleReactWork();
  });

  it("answers a re-render under the same bridge with the same store", async () => {
    // The control on every case above: a hook that re-opened on each render would
    // satisfy them all and fail here, and one that never re-opened would do the
    // reverse.
    const flagship = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
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
    // The comparison is against the bridge the store is CURRENTLY held under, not
    // against the first one ever seen. A hook that remembered only its original
    // bridge would hand back the closed store here.
    const flagship = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
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
    await expect(stampWrittenThrough(third)).resolves.toBe(consoleClockFor(flagship).now());
    expect(stores.slice(0, 2).every((store) => store.isClosed)).toBe(true);

    probe.unmount();
    await settleReactWork();
  });
});
