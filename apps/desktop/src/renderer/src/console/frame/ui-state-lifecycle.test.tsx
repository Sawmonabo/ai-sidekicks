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

import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { SCHEME_PREFERENCE_KEY, type UiStateStore } from "../persistence/index.js";
import { useUiStateStore } from "./ui-state-lifecycle.js";

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
    await Promise.resolve();
    await Promise.resolve();
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

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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
    await settle();

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
    await settle();
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
    await settle();
    expect(probe.stores.every((store) => store.isClosed)).toBe(true);
  });
});
