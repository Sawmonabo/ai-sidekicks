// A scheme that could not be saved is a scheme the person is told about.
//
// The act has two halves and only one of them can fail: the frame applies the
// preference to this window's store synchronously, and then asks the durable store
// to keep it. `UiStateStore.write` declares its failure as a returned VALUE, so a
// caller that fires it and walks away cannot tell a stored preference from one the
// disk refused — the window looked right, and the choice was gone at the next
// reload with nothing on screen having said so.
//
// So each case here drives the real hook against a real `UiStateStore` whose adapter
// is real too: `MemoryPersistenceAdapter` with a zero-byte ceiling refuses every
// write with the same `quota-exceeded` the durable adapter raises, which is what
// makes this path reachable at all without a stand-in for the store under test.
//
// Two things are asserted together every time, because either alone is the wrong
// behaviour: the scheme IS applied, and the banner says it will not come back.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import {
  MemoryPersistenceAdapter,
  SCHEME_PREFERENCE_KEY,
  UiStateStore,
} from "../persistence/index.js";
import { FrameStore } from "../store/index.js";
import { type SchemePreference } from "../tokens/index.js";
import { useSchemePreference, type SchemePreferenceSurface } from "./scheme-preference.js";
import { drainMicrotasks } from "../bridge/fixture/fixture-bridge.test-support.js";

/** A store whose every write is refused for quota, exactly as a full disk does. */
function storeThatCannotWrite(): UiStateStore {
  return new UiStateStore({
    adapter: new MemoryPersistenceAdapter({ capacityBytes: 0 }),
    clock: new ManualClock(1_000),
  });
}

function storeThatWrites(): UiStateStore {
  return new UiStateStore({
    adapter: new MemoryPersistenceAdapter(),
    clock: new ManualClock(1_000),
  });
}

interface SchemeProbeProps {
  readonly frameStore: FrameStore;
  readonly uiStateStore: UiStateStore;
  readonly onSurface: (surface: SchemePreferenceSurface) => void;
}

function SchemeProbe(props: SchemeProbeProps): null {
  props.onSurface(useSchemePreference(props.frameStore, props.uiStateStore));
  return null;
}

/** Mount the real hook and let the hydration read land. */
async function mountScheme(
  frameStore: FrameStore,
  uiStateStore: UiStateStore,
): Promise<{ readonly choose: (preference: SchemePreference) => Promise<void> }> {
  let surface: SchemePreferenceSurface | undefined;
  await act(async () => {
    render(
      <SchemeProbe
        frameStore={frameStore}
        uiStateStore={uiStateStore}
        onSurface={(latest) => {
          surface = latest;
        }}
      />,
    );
    await drainMicrotasks();
  });
  return {
    choose: async (preference) => {
      await act(async () => {
        surface?.chooseScheme(preference);
        await drainMicrotasks();
      });
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("useSchemePreference — a refused write is disclosed, never discarded", () => {
  it("keeps the chosen scheme and raises a banner saying it will not persist", async () => {
    const frameStore = new FrameStore();
    const probe = await mountScheme(frameStore, storeThatCannotWrite());

    await probe.choose("dark");

    // The choice stands for this window — that half of the act succeeded.
    expect(frameStore.getState().schemePreference).toBe("dark");

    const banners = frameStore.getState().banners;
    expect(banners).toHaveLength(1);
    expect(banners[0]?.code).toBe("quota-exceeded");
    // Both facts, in one sentence: applied here, and gone after a reload.
    expect(banners[0]?.detail).toContain("applies to this window");
    expect(banners[0]?.detail).toContain("reload");
    // And the store's own sentence, carried whole rather than reworded.
    expect(banners[0]?.detail).toContain("past its 0-byte ceiling");
  });

  it("replaces its own banner when the scheme is changed again and refused again", async () => {
    const frameStore = new FrameStore();
    const probe = await mountScheme(frameStore, storeThatCannotWrite());

    await probe.choose("dark");
    await probe.choose("light");

    expect(frameStore.getState().schemePreference).toBe("light");
    expect(frameStore.getState().banners).toHaveLength(1);
  });

  it("negative control: a write that lands raises nothing", async () => {
    // Without this, a hook that banner-ed every choice would satisfy both cases
    // above while reporting a failure on every successful write.
    const frameStore = new FrameStore();
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
    const frameStore = new FrameStore();

    await mountScheme(frameStore, uiStateStore);

    expect(frameStore.getState().schemePreference).toBe("dark");
  });

  it("never writes the default back over what it read", async () => {
    // The defect a `schemePreference` effect would reintroduce: it cannot tell the
    // person's choice from the hydration that just applied a stored one, so it
    // writes the default over the stored preference in the window before the read
    // settles.
    const uiStateStore = storeThatWrites();
    await uiStateStore.writeGlobal(SCHEME_PREFERENCE_KEY, "scheme", "dark");
    const frameStore = new FrameStore();

    await mountScheme(frameStore, uiStateStore);

    expect((await uiStateStore.readGlobal(SCHEME_PREFERENCE_KEY))?.value).toBe("dark");
  });
});
