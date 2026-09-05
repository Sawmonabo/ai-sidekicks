// Who holds the store, and when the binding acquires one.
//
// The store next door is proved against its own methods; what is proved here is
// WHOSE store a page is on and WHEN the holder mints or disposes one — the two
// questions the module split apart from the state machine. The binding used to acquire the store from a `useMemo` over
// the bridge, and acquiring disposes: a replacement bridge disposed the store the
// committed tree was subscribed to and installed a successor, so a render React
// replayed or abandoned left every mounted page reading and choosing into a disposed
// store while the holder held one that was never committed.
//
// The last case is about a render that never commits, which is why these cases are
// in a `.tsx` file rather than beside the store's own unit cases: an abandoned render
// has to be a real React render, and it is produced the only way a test can produce
// one — a sibling that throws after the probe has already rendered.

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  unscriptedScenario,
} from "../../../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge, GrowthPort } from "../../../bridge/index.js";
import { consoleShellPreferences, useShellPreferences } from "./shell-preferences-holder.js";
import { SHELL_PREFERENCE_DEFAULTS, effectivePreference } from "./shell-preference-snapshot.js";

/** The carrier nobody has registered, which is every carrier this console has. */
const REFUSING_CARRIER: Partial<GrowthPort> = {
  shellConfigRead: growthRefusing("shellConfigRead"),
  shellConfigWrite: growthRefusing("shellConfigWrite"),
};

/** A fresh bridge each call, so one case's holder state is never another's. */
function refusingBridge(): ConsoleBridge {
  return fixtureBridgeWithGrowth(unscriptedScenario("shell-preferences-binding"), REFUSING_CARRIER);
}

/** The smallest page there is: it binds the preferences and renders the reading. */
function PreferenceProbe(props: { readonly bridge: ConsoleBridge }): React.JSX.Element {
  const preferences = useShellPreferences(props.bridge);
  return <span data-testid="reading">{preferences.snapshot.reading.kind}</span>;
}

/** A sibling that fails the render pass the probe has already rendered into. */
function AbandoningSibling(): React.JSX.Element {
  throw new Error("this render never commits");
}

/** Let the acquiring effect run and the carrier's refusal land. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("shell preferences binding — acquisition happens after the commit", () => {
  it("acquires the window's store from an effect and reads what it answers", async () => {
    const bridge = refusingBridge();

    const { getByTestId } = render(
      <StrictMode>
        <PreferenceProbe bridge={bridge} />
      </StrictMode>,
    );
    await settle();

    // Strict mode invokes the acquiring effect twice; the second invocation finds
    // the store the first one minted rather than superseding it, which is the
    // property that lets the effect carry no teardown.
    const acquired = consoleShellPreferences.storeIfCurrent(bridge);
    expect(acquired).toBeDefined();
    expect(acquired?.isDisposed).toBe(false);
    expect(getByTestId("reading").textContent).toBe("unavailable");
  });

  it("disposes the superseded store exactly once when the bridge is replaced", async () => {
    const firstBridge = refusingBridge();
    const { rerender } = render(<PreferenceProbe bridge={firstBridge} />);
    await settle();
    const firstStore = consoleShellPreferences.storeIfCurrent(firstBridge);
    expect(firstStore).toBeDefined();
    const disposals = vi.spyOn(firstStore as { dispose: () => void }, "dispose");

    const secondBridge = refusingBridge();
    rerender(<PreferenceProbe bridge={secondBridge} />);
    await settle();

    expect(disposals).toHaveBeenCalledTimes(1);
    expect(consoleShellPreferences.storeIfCurrent(secondBridge)?.isDisposed).toBe(false);
  });

  it("leaves the committed store live when a render is abandoned", async () => {
    // The negative control on the `useMemo` form. Under it the probe's render-time
    // lookup disposed `firstStore` and installed a successor for a pass that never
    // committed, so this case fails on the old code and passes on the new one.
    const firstBridge = refusingBridge();
    const { rerender } = render(<PreferenceProbe bridge={firstBridge} />);
    await settle();
    const firstStore = consoleShellPreferences.storeIfCurrent(firstBridge);
    expect(firstStore).toBeDefined();

    const abandonedBridge = refusingBridge();
    // The failure is left UNCAUGHT rather than wrapped in a surface boundary: the
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
    expect(consoleShellPreferences.storeIfCurrent(firstBridge)).toBe(firstStore);
    expect(consoleShellPreferences.storeIfCurrent(abandonedBridge)).toBeUndefined();
  });
});

describe("shell preferences — the store belongs to the window, not to a page", () => {
  it("hands one bridge the same store however many pages ask", async () => {
    // The defect this is the negative control for: a store built per calling
    // component died with the page, so a choice made on the updates section was
    // gone by the time the notifications section asked for it — while the row said
    // it was held for the window.
    const bridge = refusingBridge();
    const firstPagesStore = consoleShellPreferences.acquire(bridge);
    await firstPagesStore.choose("updates.automatic", false);

    const secondPagesStore = consoleShellPreferences.acquire(bridge);

    expect(secondPagesStore).toBe(firstPagesStore);
    expect(effectivePreference(secondPagesStore.snapshot(), "updates.automatic")).toBe(false);
    expect(Object.hasOwn(secondPagesStore.snapshot().heldLocally, "updates.automatic")).toBe(true);
  });

  it("gives two bridges two stores, and disposes the one it superseded exactly once", async () => {
    // The fixture's scenario swap replaces the bridge. A store built against the old
    // one would keep answering with the old one's reading, so it is superseded
    // rather than reused — and it is dropped, so asking again mints a live store
    // rather than returning a terminal one whose replies write nothing.
    const firstBridge = refusingBridge();
    const secondBridge = refusingBridge();
    const firstStore = consoleShellPreferences.acquire(firstBridge);
    // Counted rather than read off the flag: `dispose` is idempotent, so a holder
    // that disposed the same store on every ask would leave `isDisposed` looking
    // exactly as it does here.
    const disposals = vi.spyOn(firstStore, "dispose");

    const secondStore = consoleShellPreferences.acquire(secondBridge);
    consoleShellPreferences.acquire(secondBridge);

    expect(secondStore).not.toBe(firstStore);
    expect(disposals).toHaveBeenCalledTimes(1);
    expect(firstStore.isDisposed).toBe(true);
    expect(secondStore.isDisposed).toBe(false);

    const rebuilt = consoleShellPreferences.acquire(firstBridge);
    expect(rebuilt).not.toBe(firstStore);
    expect(rebuilt.isDisposed).toBe(false);
    await rebuilt.choose("updates.automatic", false);
    expect(effectivePreference(rebuilt.snapshot(), "updates.automatic")).toBe(false);
  });

  it("negative control: a superseded store's own reply writes nothing", async () => {
    // Without this, the disposal above would be a flag nobody reads — and a reply
    // landing after the swap would publish the old bridge's answer over the new
    // bridge's store, which is the state a person cannot debug.
    const firstBridge = refusingBridge();
    const firstStore = consoleShellPreferences.acquire(firstBridge);
    consoleShellPreferences.acquire(refusingBridge());

    await firstStore.choose("updates.automatic", false);

    expect(firstStore.snapshot().heldLocally).toStrictEqual({});
    expect(effectivePreference(firstStore.snapshot(), "updates.automatic")).toBe(
      SHELL_PREFERENCE_DEFAULTS["updates.automatic"],
    );
  });
});

describe("shell preferences — the lookup a render body performs", () => {
  it("answers the live store for the bridge it is on", () => {
    const bridge = refusingBridge();
    const acquired = consoleShellPreferences.acquire(bridge);

    expect(consoleShellPreferences.storeIfCurrent(bridge)).toBe(acquired);
  });

  it("answers nothing for a bridge the holder is not on, and disposes nothing", () => {
    // The purity claim, which is the whole of the fix: this is the call a render
    // body makes, and a render body may run for a pass React replays or abandons.
    // The acquiring form disposed the committed store and installed a successor
    // right here, so an abandoned render left the mounted pages on a disposed store.
    const committedBridge = refusingBridge();
    const committed = consoleShellPreferences.acquire(committedBridge);
    const replacementBridge = refusingBridge();

    expect(consoleShellPreferences.storeIfCurrent(replacementBridge)).toBeUndefined();
    expect(committed.isDisposed).toBe(false);
    expect(consoleShellPreferences.storeIfCurrent(committedBridge)).toBe(committed);
  });

  it("negative control: acquiring the replacement is what disposes, so the two differ", () => {
    // Without this, the case above would pass over a holder that never disposed
    // anything at all — and the lookup would be pure because nothing was.
    const committedBridge = refusingBridge();
    const committed = consoleShellPreferences.acquire(committedBridge);

    consoleShellPreferences.acquire(refusingBridge());

    expect(committed.isDisposed).toBe(true);
  });
});
