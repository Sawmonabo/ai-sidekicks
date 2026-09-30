// A scheme that could not be saved is a scheme the person is told about. The frame applies the
// preference at once and then asks the durable store to keep it; `UiStateStore` declares a write
// failure as a returned value, so nothing on screen would say a choice was lost at the next
// reload. Cases drive the real hook against a real `UiStateStore` whose `MemoryPersistenceAdapter`
// has a zero-byte ceiling, which refuses every write with the `quota-exceeded` the durable adapter
// raises. Each asserts that the scheme is applied and that the banner says it will not come back.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { MemoryPersistenceAdapter } from "@renderer/store/persistence/memory-persistence-adapter.js";
import { SCHEME_PREFERENCE_KEY } from "@renderer/store/persistence/persistence-adapter.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { type SchemePreference } from "@renderer/styles/tokens.js";
import { useSchemePreference, type UseSchemePreferenceResult } from "./useSchemePreference.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";

/** A store whose every write is refused for quota, exactly as a full disk does. */
function storeThatCannotWrite(): UiStateStore {
  return new UiStateStore({
    adapter: new MemoryPersistenceAdapter({ capacityBytes: 0 }),
    clock: new ManualClock(1_000),
  });
}

/** A store whose writes land. */
function storeThatWrites(): UiStateStore {
  return new UiStateStore({
    adapter: new MemoryPersistenceAdapter(),
    clock: new ManualClock(1_000),
  });
}

/** What the probe reads and reports: the two stores and the hook result sink. */
interface SchemeProbeProps {
  readonly frameStore: WindowStore;
  readonly uiStateStore: UiStateStore;
  readonly onResult: (result: UseSchemePreferenceResult) => void;
}

/** Mounts the real hook and reports its result each render. */
function SchemeProbe(props: SchemeProbeProps): null {
  props.onResult(useSchemePreference(props.frameStore, props.uiStateStore));
  return null;
}

/** Mount the real hook and let the hydration read land. */
async function mountScheme(
  frameStore: WindowStore,
  uiStateStore: UiStateStore,
): Promise<{ readonly choose: (preference: SchemePreference) => Promise<void> }> {
  let latestResult: UseSchemePreferenceResult | undefined;
  await act(async () => {
    render(
      <SchemeProbe
        frameStore={frameStore}
        uiStateStore={uiStateStore}
        onResult={(latest) => {
          latestResult = latest;
        }}
      />,
    );
    await crossMacrotaskBoundary();
  });
  return {
    choose: async (preference) => {
      await act(async () => {
        latestResult?.chooseScheme(preference);
        await crossMacrotaskBoundary();
      });
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("useSchemePreference — a refused write is disclosed, never discarded", () => {
  it("keeps the chosen scheme and raises a banner saying it will not persist", async () => {
    const frameStore = new WindowStore();
    const probe = await mountScheme(frameStore, storeThatCannotWrite());

    await probe.choose("dark");

    // The choice stands for this window.
    expect(frameStore.getState().schemePreference).toBe("dark");

    const banners = frameStore.getState().banners;
    expect(banners).toHaveLength(1);
    expect(banners[0]?.code).toBe("quota-exceeded");
    // Applied here, and gone after a reload.
    expect(banners[0]?.detail).toContain("applies to this window");
    expect(banners[0]?.detail).toContain("reload");
    // The store's own sentence is carried whole.
    expect(banners[0]?.detail).toContain("past its 0-byte ceiling");
  });

  it("replaces its own banner when the scheme is changed again and refused again", async () => {
    const frameStore = new WindowStore();
    const probe = await mountScheme(frameStore, storeThatCannotWrite());

    await probe.choose("dark");
    await probe.choose("light");

    expect(frameStore.getState().schemePreference).toBe("light");
    expect(frameStore.getState().banners).toHaveLength(1);
  });

  it("negative control: a write that lands raises nothing", async () => {
    // Without this, a hook that raised a banner on every choice would pass both cases above.
    const frameStore = new WindowStore();
    const uiStateStore = storeThatWrites();
    const probe = await mountScheme(frameStore, uiStateStore);

    await probe.choose("dark");

    expect(frameStore.getState().schemePreference).toBe("dark");
    expect(frameStore.getState().banners).toStrictEqual([]);
    expect((await uiStateStore.readGlobal(SCHEME_PREFERENCE_KEY))?.value).toBe("dark");
  });
});

describe("useSchemePreference — hydration is a pure read", () => {
  it("applies a stored preference at mount", async () => {
    const uiStateStore = storeThatWrites();
    await uiStateStore.writeGlobal(SCHEME_PREFERENCE_KEY, "scheme", "dark");
    const frameStore = new WindowStore();

    await mountScheme(frameStore, uiStateStore);

    expect(frameStore.getState().schemePreference).toBe("dark");
  });

  it("never writes the default back over what it read", async () => {
    // A `schemePreference` effect could not tell a choice from the hydration that applied a
    // stored one, and would write the default over it before the read settles.
    const uiStateStore = storeThatWrites();
    await uiStateStore.writeGlobal(SCHEME_PREFERENCE_KEY, "scheme", "dark");
    const frameStore = new WindowStore();

    await mountScheme(frameStore, uiStateStore);

    expect((await uiStateStore.readGlobal(SCHEME_PREFERENCE_KEY))?.value).toBe("dark");
  });
});
