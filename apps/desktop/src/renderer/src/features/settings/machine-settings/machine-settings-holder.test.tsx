// Who holds the store, and when the binding acquires one.
//
// The store beside this module is proved against its own methods; what is proved here is WHOSE
// store a page is on and WHEN the holder mints or disposes one. Acquiring disposes, so
// a render React replays or abandons must never dispose the store the committed tree
// is subscribed to.
//
// The last case is about a render that never commits, which is why these cases are in
// a `.tsx` file: an abandoned render has to be a real React render, produced by a
// sibling that throws after the probe has already rendered.

import { settleScheduledRead } from "@test/helpers/scheduled-read.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { Clock } from "@renderer/lib/clock.js";
import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { NEVER_SETTLES } from "@test/helpers/abandoned-pass.js";
import { machineSettingsHolder } from "./machine-settings-holder.js";
import { useMachineSettings } from "./hooks/useMachineSettings.js";
import { MACHINE_SETTING_DEFAULTS, effectivePreference } from "./machine-settings-snapshot.js";
import type { MachineSettingsFile } from "./machine-settings-store.js";

/** A settings file whose read and write never answer. */
const UNANSWERING_SETTINGS_FILE: MachineSettingsFile = {
  read: () => NEVER_SETTLES,
  write: () => NEVER_SETTLES,
};

/** A settings file that accepts every write. */
const ACCEPTING_SETTINGS_FILE: MachineSettingsFile = {
  read: () => Promise.resolve({}),
  write: () => Promise.resolve(undefined),
};

/** A fresh bridge each call, so one case's holder state is never another's. */
function freshBridge(): FixtureBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("machine-settings-binding") });
}

/**
 * The window a probe is mounted in: that bridge's provider, on the scenario's frozen clock.
 *
 * Passed as the render's wrapper so it holds still across a `rerender`: a case that replaces
 * the probe's bridge replaces only the prop, and every store it mints runs on this clock.
 */
function windowOf(fixture: FixtureBridge): {
  readonly wrapper: ReturnType<typeof bridgeWrapper>;
} {
  return { wrapper: bridgeWrapper(fixture.bridge, fixture.scenarioEngine.clock) };
}

/** The smallest page there is: it binds the preferences and renders the reading. */
function PreferenceProbe(props: { readonly bridge: PlatformBridge }): React.JSX.Element {
  const preferences = useMachineSettings(props.bridge, UNANSWERING_SETTINGS_FILE);
  return <span data-testid="reading">{preferences.snapshot.reading.kind}</span>;
}

/** A sibling that fails the render pass the probe has already rendered into. */
function AbandoningSibling(): React.JSX.Element {
  throw new Error("this render never commits");
}

/**
 * Let the acquiring effect run and the store's scheduled opening read fire.
 *
 * The clock travels because the read is armed on the window's clock — the fixture's
 * frozen one — so a settle that only crossed boundaries would assert against a store
 * that was never given a chance to ask.
 */
async function settle(clock: Clock): Promise<void> {
  await settleScheduledRead(clock);
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

describe("machine settings binding — acquisition happens after the commit", () => {
  it("acquires the window's store from an effect and reads what it answers", async () => {
    const fixture = freshBridge();
    const { bridge } = fixture;

    const { getByTestId } = render(
      <StrictMode>
        <PreferenceProbe bridge={bridge} />
      </StrictMode>,
      windowOf(fixture),
    );
    await settle(fixture.scenarioEngine.clock);

    // Strict mode invokes the acquiring effect twice; the second invocation finds
    // the store the first one minted rather than superseding it, which is the
    // property that lets the effect carry no teardown.
    const acquired = machineSettingsHolder.storeIfCurrent(bridge);
    expect(acquired).toBeDefined();
    expect(acquired?.isDisposed).toBe(false);
    // The settings file never answers, so the read stays open.
    expect(getByTestId("reading").textContent).toBe("not-read");
  });

  it("disposes the superseded store exactly once when the bridge is replaced", async () => {
    const firstFixture = freshBridge();
    const firstBridge = firstFixture.bridge;
    const windowClock = firstFixture.scenarioEngine.clock;
    const { rerender } = render(<PreferenceProbe bridge={firstBridge} />, windowOf(firstFixture));
    await settle(windowClock);
    const firstStore = machineSettingsHolder.storeIfCurrent(firstBridge);
    expect(firstStore).toBeDefined();
    const disposals = vi.spyOn(firstStore as { dispose: () => void }, "dispose");

    const secondBridge = freshBridge().bridge;
    rerender(<PreferenceProbe bridge={secondBridge} />);
    await settle(windowClock);

    expect(disposals).toHaveBeenCalledTimes(1);
    expect(machineSettingsHolder.storeIfCurrent(secondBridge)?.isDisposed).toBe(false);
  });

  it("leaves the committed store live when a render is abandoned", async () => {
    // The negative control on the `useMemo` form. Under it the probe's render-time
    // lookup disposed `firstStore` and installed a successor for a pass that never
    // committed, so this case fails on the old code and passes on the new one.
    const firstFixture = freshBridge();
    const firstBridge = firstFixture.bridge;
    const { rerender } = render(<PreferenceProbe bridge={firstBridge} />, windowOf(firstFixture));
    await settle(firstFixture.scenarioEngine.clock);
    const firstStore = machineSettingsHolder.storeIfCurrent(firstBridge);
    expect(firstStore).toBeDefined();

    const abandonedBridge = freshBridge().bridge;
    // The failure is left UNCAUGHT rather than wrapped in an error boundary: the
    // boundary's record of a render failure is a tripwire, and this tier throws on
    // one, so catching the throw here would replace the case's subject with the
    // boundary's. React reports the pass it discarded through `console.error`.
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
    // The defect this is the negative control for: a store built per calling
    // component died with the page, so a choice made on the updates section was
    // gone by the time the notifications section asked for it — while the row said
    // it was held for the window.
    const { bridge, scenarioEngine } = freshBridge();
    const firstPagesStore = machineSettingsHolder.acquire(
      bridge,
      scenarioEngine.clock,
      UNANSWERING_SETTINGS_FILE,
    );

    const secondPagesStore = machineSettingsHolder.acquire(
      bridge,
      scenarioEngine.clock,
      UNANSWERING_SETTINGS_FILE,
    );

    expect(secondPagesStore).toBe(firstPagesStore);
  });

  it("gives two bridges two stores, and disposes the one it superseded exactly once", () => {
    // The fixture's scenario swap replaces the bridge. A store built against the old
    // one would keep answering with the old one's reading, so it is superseded
    // rather than reused — and it is dropped, so asking again mints a live store
    // rather than returning a terminal one whose replies write nothing.
    const first = freshBridge();
    const second = freshBridge();
    const firstStore = machineSettingsHolder.acquire(
      first.bridge,
      first.scenarioEngine.clock,
      UNANSWERING_SETTINGS_FILE,
    );
    // Counted rather than read off the flag: `dispose` is idempotent, so a holder
    // that disposed the same store on every ask would leave `isDisposed` looking
    // exactly as it does here.
    const disposals = vi.spyOn(firstStore, "dispose");

    const secondStore = machineSettingsHolder.acquire(
      second.bridge,
      second.scenarioEngine.clock,
      UNANSWERING_SETTINGS_FILE,
    );
    machineSettingsHolder.acquire(
      second.bridge,
      second.scenarioEngine.clock,
      UNANSWERING_SETTINGS_FILE,
    );

    expect(secondStore).not.toBe(firstStore);
    expect(disposals).toHaveBeenCalledTimes(1);
    expect(firstStore.isDisposed).toBe(true);
    expect(secondStore.isDisposed).toBe(false);

    const rebuilt = machineSettingsHolder.acquire(
      first.bridge,
      first.scenarioEngine.clock,
      UNANSWERING_SETTINGS_FILE,
    );
    expect(rebuilt).not.toBe(firstStore);
    expect(rebuilt.isDisposed).toBe(false);
  });
});

describe("machine settings — a superseded store", () => {
  it("negative control: a superseded store's own reply writes nothing", async () => {
    // Without this, the disposal above would be a flag nobody reads: a reply landing after
    // the swap would publish the old bridge's answer over the new bridge's store.
    const first = freshBridge();
    const second = freshBridge();
    const firstStore = machineSettingsHolder.acquire(
      first.bridge,
      first.scenarioEngine.clock,
      ACCEPTING_SETTINGS_FILE,
    );
    machineSettingsHolder.acquire(
      second.bridge,
      second.scenarioEngine.clock,
      ACCEPTING_SETTINGS_FILE,
    );

    await firstStore.choose("updates.automatic", false);

    expect(firstStore.snapshot().reading.kind).toBe("not-read");
    expect(effectivePreference(firstStore.snapshot(), "updates.automatic")).toBe(
      MACHINE_SETTING_DEFAULTS["updates.automatic"],
    );
  });
});

describe("machine settings — the lookup a render body performs", () => {
  it("answers the live store for the bridge it is on", () => {
    const { bridge, scenarioEngine } = freshBridge();
    const acquired = machineSettingsHolder.acquire(
      bridge,
      scenarioEngine.clock,
      UNANSWERING_SETTINGS_FILE,
    );

    expect(machineSettingsHolder.storeIfCurrent(bridge)).toBe(acquired);
  });

  it("answers nothing for a bridge the holder is not on, and disposes nothing", () => {
    // The purity claim, which is the whole of the fix: this is the call a render
    // body makes, and a render body may run for a pass React replays or abandons.
    // The acquiring form disposed the committed store and installed a successor
    // right here, so an abandoned render left the mounted pages on a disposed store.
    const { bridge: committedBridge, scenarioEngine } = freshBridge();
    const committed = machineSettingsHolder.acquire(
      committedBridge,
      scenarioEngine.clock,
      UNANSWERING_SETTINGS_FILE,
    );
    const replacementBridge = freshBridge().bridge;

    expect(machineSettingsHolder.storeIfCurrent(replacementBridge)).toBeUndefined();
    expect(committed.isDisposed).toBe(false);
    expect(machineSettingsHolder.storeIfCurrent(committedBridge)).toBe(committed);
  });

  it("negative control: acquiring the replacement is what disposes, so the two differ", () => {
    // Without this, the case above would pass over a holder that never disposed
    // anything at all — and the lookup would be pure because nothing was.
    const committedFixture = freshBridge();
    const committed = machineSettingsHolder.acquire(
      committedFixture.bridge,
      committedFixture.scenarioEngine.clock,
      UNANSWERING_SETTINGS_FILE,
    );

    const replacement = freshBridge();
    machineSettingsHolder.acquire(
      replacement.bridge,
      replacement.scenarioEngine.clock,
      UNANSWERING_SETTINGS_FILE,
    );

    expect(committed.isDisposed).toBe(true);
  });
});
