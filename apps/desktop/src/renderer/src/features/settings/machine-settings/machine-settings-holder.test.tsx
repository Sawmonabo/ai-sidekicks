// Whose store a page is on, and when the holder mints or disposes one. Acquiring disposes, so
// a render React replays or abandons must never dispose the store the committed tree is
// subscribed to. The abandoned-render case needs a real React render, hence `.tsx`.

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MACHINE_SETTINGS_DEFAULTS } from "@ai-sidekicks/contracts";
import type { PreloadApi } from "@shared/preload-api.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { NEVER_SETTLES } from "@test/helpers/abandoned-pass.js";
import { machineSettingsHolder } from "./machine-settings-holder.js";
import { useMachineSettings } from "./hooks/useMachineSettings.js";
import { effectiveSettings } from "./machine-settings-snapshot.js";

/** A service whose feed never delivers and whose writes never answer. */
const UNANSWERING_SERVICE: PreloadApi["machineSettings"] = {
  read: () => NEVER_SETTLES,
  write: () => NEVER_SETTLES,
  subscribe: () => () => undefined,
};

/** A service whose feed never delivers and whose every write answers the file it holds. */
const ACCEPTING_SERVICE: PreloadApi["machineSettings"] = {
  read: () => NEVER_SETTLES,
  write: () => Promise.resolve({ ...MACHINE_SETTINGS_DEFAULTS, updatesAutomatic: false }),
  subscribe: () => () => undefined,
};

/** A fresh bridge each call over `service`, so one case's holder state is never another's. */
function freshBridge(service = UNANSWERING_SERVICE): PlatformBridge {
  const { bridge } = createFixtureBridge({
    scenario: unscriptedScenario("machine-settings-binding"),
  });
  return { ...bridge, machineSettings: service };
}

/**
 * The window a probe is mounted in: that bridge's provider.
 *
 * Passed as the render's wrapper so it holds still across a `rerender`: a case that replaces
 * the probe's bridge replaces only the prop.
 */
function windowOf(bridge: PlatformBridge): {
  readonly wrapper: ReturnType<typeof bridgeWrapper>;
} {
  const { scenarioEngine } = createFixtureBridge({
    scenario: unscriptedScenario("machine-settings-window"),
  });
  return { wrapper: bridgeWrapper(bridge, scenarioEngine.clock) };
}

/** The smallest page there is: it binds the settings and renders whether they answered. */
function PreferenceProbe(props: { readonly bridge: PlatformBridge }): React.JSX.Element {
  const preferences = useMachineSettings(props.bridge);
  return (
    <span data-testid="reading">
      {preferences.snapshot.reading === undefined ? "not-read" : "read"}
    </span>
  );
}

/** A sibling that fails the render pass the probe has already rendered into. */
function AbandoningSibling(): React.JSX.Element {
  throw new Error("this render never commits");
}

/** Let the acquiring effect run. */
async function settle(): Promise<void> {
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

describe("machine settings binding — acquisition happens after the commit", () => {
  it("leaves the committed store live when a render is abandoned", async () => {
    // Negative control on the `useMemo` form: a render-time lookup would dispose
    // `firstStore` for a pass that never committed.
    const firstBridge = freshBridge();
    const { rerender } = render(<PreferenceProbe bridge={firstBridge} />, windowOf(firstBridge));
    await settle();
    const firstStore = machineSettingsHolder.storeIfCurrent(firstBridge);
    expect(firstStore).toBeDefined();

    const abandonedBridge = freshBridge();
    // Left uncaught rather than wrapped in an error boundary: the boundary records a render
    // failure as a tripwire and this tier throws on one. React reports the discarded pass
    // through `console.error`.
    const consoleErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => {
      rerender(
        <>
          <PreferenceProbe bridge={abandonedBridge} />
          <AbandoningSibling />
        </>,
      );
    }).toThrow("this render never commits");
    consoleErrors.mockRestore();

    expect(firstStore?.isDisposed).toBe(false);
    expect(machineSettingsHolder.storeIfCurrent(firstBridge)).toBe(firstStore);
    expect(machineSettingsHolder.storeIfCurrent(abandonedBridge)).toBeUndefined();
  });
});

describe("machine settings — the store belongs to the window, not to a page", () => {
  it("hands one bridge the same store however many pages ask", async () => {
    // Guards against a store per calling component, which died with its page.
    const bridge = freshBridge();
    const firstPagesStore = machineSettingsHolder.acquire(bridge);

    const secondPagesStore = machineSettingsHolder.acquire(bridge);

    expect(secondPagesStore).toBe(firstPagesStore);
  });

  it("gives two bridges two stores, and disposes the one it superseded exactly once", () => {
    // A scenario swap replaces the bridge; the old store is superseded and dropped, so asking
    // again mints a live store instead of returning a terminal one.
    const first = freshBridge();
    const second = freshBridge();
    const firstStore = machineSettingsHolder.acquire(first);
    // Counted, since `dispose` is idempotent and `isDisposed` would look the same after
    // repeated disposal.
    const disposals = vi.spyOn(firstStore, "dispose");

    const secondStore = machineSettingsHolder.acquire(second);
    machineSettingsHolder.acquire(second);

    expect(secondStore).not.toBe(firstStore);
    expect(disposals).toHaveBeenCalledTimes(1);
    expect(firstStore.isDisposed).toBe(true);
    expect(secondStore.isDisposed).toBe(false);

    const rebuilt = machineSettingsHolder.acquire(first);
    expect(rebuilt).not.toBe(firstStore);
    expect(rebuilt.isDisposed).toBe(false);
  });
});

describe("machine settings — a superseded store", () => {
  it("negative control: a superseded store's own reply writes nothing", async () => {
    // Guards against a disposal flag nobody reads: a late reply would publish the old bridge's
    // answer over the new store.
    const first = freshBridge(ACCEPTING_SERVICE);
    const second = freshBridge(ACCEPTING_SERVICE);
    const firstStore = machineSettingsHolder.acquire(first);
    machineSettingsHolder.acquire(second);

    await firstStore.choose("updatesAutomatic", false);

    expect(firstStore.snapshot().reading).toBeUndefined();
    expect(effectiveSettings(firstStore.snapshot()).updatesAutomatic).toBe(
      MACHINE_SETTINGS_DEFAULTS.updatesAutomatic,
    );
  });
});

describe("machine settings — the lookup a render body performs", () => {
  it("answers nothing for a bridge the holder is not on, and disposes nothing", () => {
    // Purity: a render body calls this for passes React may replay or abandon, and an acquiring
    // form would dispose the committed store.
    const committedBridge = freshBridge();
    const committed = machineSettingsHolder.acquire(committedBridge);
    const replacementBridge = freshBridge();

    expect(machineSettingsHolder.storeIfCurrent(replacementBridge)).toBeUndefined();
    expect(committed.isDisposed).toBe(false);
    expect(machineSettingsHolder.storeIfCurrent(committedBridge)).toBe(committed);
  });
});
