// The window's binder: minted beside the registry, attached, and torn down first.
//
// "The hook mints a registry" is only half a claim — the other half is that it
// mints the binder beside it, attaches it, and tears the two down in the order that
// cannot have one call into the other.

import { render } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BridgeComposition } from "@renderer/services/platform/bridge-context.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { type SessionDiagnostics } from "@renderer/services/session-events/session-diagnostics-handle.js";
import { SessionEventSubscriber } from "@renderer/services/session-events/session-event-subscriber.js";
import { SessionProbe } from "./session-store-hooks.test-support.js";

/** The diagnostics a composition was handed, as the page would hold them. */
interface DiagnosticsSlot {
  installed: SessionDiagnostics | undefined;
}

/**
 * A fixture bridge with a composition beside it that keeps the session diagnostics it is
 * handed, so a case reads what the hook gave over rather than a page property.
 */
function compositionHarness(): {
  readonly slot: DiagnosticsSlot;
  readonly wrapper: (props: { readonly children: ReactNode }) => React.JSX.Element;
} {
  const bridge = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
  const slot: DiagnosticsSlot = { installed: undefined };
  const composition: BridgeComposition = {
    createBridge: () => bridge,
    installBridgeHandles: () => () => undefined,
    installSessionDiagnostics: (diagnostics) => {
      slot.installed = diagnostics;
      return () => {
        slot.installed = undefined;
      };
    },
  };
  return {
    slot,
    wrapper: function CompositionHost(props: { readonly children: ReactNode }) {
      return (
        <PlatformBridgeProvider bridge={bridge} composition={composition}>
          {props.children}
        </PlatformBridgeProvider>
      );
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSessionStoreRegistry — the window's registry and the binder that feeds it", () => {
  it("mints a binder beside the registry and binds the open session", () => {
    const { slot, wrapper } = compositionHarness();
    render(<SessionProbe sessionId="session-bound" onObserve={() => undefined} />, { wrapper });

    // Read through what the composition was handed rather than through a returned
    // object, because the hook deliberately does not hand the binder out — this is
    // what the fixture composition puts on the page for the endurance tier, so the
    // case also proves the tier has something to read.
    const diagnostics = slot.installed;
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.openSessionIds()).toEqual(["session-bound"]);

    expect(diagnostics?.boundSessionIds()).toEqual(["session-bound"]);
  });

  it("disposes the binder in the same cleanup, before the registry", () => {
    // Spies over the REAL methods (`vi.spyOn` calls through), so the ordering is
    // read off the calls the hook actually made rather than off a substitute that
    // could be ordered any way at all.
    const disposeBinder = vi.spyOn(SessionEventSubscriber.prototype, "dispose");
    const disposeRegistry = vi.spyOn(SessionStoreRegistry.prototype, "disposeAll");
    const { slot, wrapper } = compositionHarness();
    const { unmount } = render(
      <SessionProbe sessionId="session-teardown" onObserve={() => undefined} />,
      { wrapper },
    );

    expect(disposeBinder).not.toHaveBeenCalled();
    unmount();

    expect(disposeBinder).toHaveBeenCalledTimes(1);
    expect(disposeRegistry).toHaveBeenCalledTimes(1);
    const binderCallOrder = disposeBinder.mock.invocationCallOrder[0];
    const registryCallOrder = disposeRegistry.mock.invocationCallOrder[0];
    expect(binderCallOrder).toBeDefined();
    expect(registryCallOrder).toBeDefined();
    // The binder holds the registry's change subscription, so a registry disposed
    // first would close every session back through a binder already being torn
    // down. The order is the assertion.
    expect(binderCallOrder ?? 0).toBeLessThan(registryCallOrder ?? 0);
    // Nothing is left installed once the window is gone.
    expect(slot.installed).toBeUndefined();
  });

  it("negative control: the ordering comparison notices the opposite order", () => {
    // Without this, `toBeLessThan` over two numbers read from the same counter
    // would pass on any pair the harness happened to produce — including one
    // recorded in the wrong order.
    const disposeBinder = vi.spyOn(SessionEventSubscriber.prototype, "dispose");
    const disposeRegistry = vi.spyOn(SessionStoreRegistry.prototype, "disposeAll");
    const registry = new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
    const binder = new SessionEventSubscriber({
      registry,
      bridge: createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO }),
    });

    registry.disposeAll();
    binder.dispose();

    const binderCallOrder = disposeBinder.mock.invocationCallOrder[0] ?? 0;
    const registryCallOrder = disposeRegistry.mock.invocationCallOrder[0] ?? 0;
    expect(binderCallOrder).toBeGreaterThan(registryCallOrder);
  });
});
