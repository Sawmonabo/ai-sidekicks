// The React binding, held to the one property a `useMemo` could not give it.
//
// The store next door is proved against its own methods; what is proved here is
// WHEN they are called. The binding used to acquire the store from a `useMemo` over
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
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge, GrowthPort } from "../../bridge/index.js";
import { consoleShellPreferences, useShellPreferences } from "./shell-preferences.js";

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
