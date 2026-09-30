// The window's event subscriber: minted beside the registry, attached, and disposed before it so
// neither calls into the other mid-teardown.

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

/** A session id the daemon admits, so the binder opens a stream for it. */
const BOUND_SESSION_ID = "019b7a44-4400-75e5-8510-ada11a5a66a5";

/** The diagnostics a composition was handed, as the page would hold them. */
interface DiagnosticsHolder {
  installed: SessionDiagnostics | undefined;
}

/**
 * A fixture bridge with a composition beside it that keeps the session diagnostics it is
 * handed, so a case reads what the hook gave over rather than a page property.
 */
function compositionHarness(): {
  readonly diagnosticsHolder: DiagnosticsHolder;
  readonly wrapper: (props: { readonly children: ReactNode }) => React.JSX.Element;
} {
  const { bridge, scenarioEngine } = createFixtureBridge({
    scenario: CONCURRENT_STREAMING_SCENARIO,
  });
  const diagnosticsHolder: DiagnosticsHolder = { installed: undefined };
  const composition: BridgeComposition = {
    createBridge: () => ({
      bridge,
      clock: scenarioEngine.clock,
      disposal: scenarioEngine,
      installHandles: () => () => undefined,
    }),
    installSessionDiagnostics: (diagnostics) => {
      diagnosticsHolder.installed = diagnostics;
      return () => {
        diagnosticsHolder.installed = undefined;
      };
    },
  };
  return {
    diagnosticsHolder,
    wrapper: function CompositionHost(props: { readonly children: ReactNode }) {
      return (
        <PlatformBridgeProvider
          bridge={bridge}
          clock={scenarioEngine.clock}
          composition={composition}
        >
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
    const { diagnosticsHolder, wrapper } = compositionHarness();
    render(<SessionProbe sessionId={BOUND_SESSION_ID} onObserve={() => undefined} />, {
      wrapper,
    });

    // Read through what the composition was handed, since the hook does not return the
    // subscriber; this is also what the fixture composition puts on the page for the endurance
    // tier.
    const diagnostics = diagnosticsHolder.installed;
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.openSessionIds()).toEqual([BOUND_SESSION_ID]);

    expect(diagnostics?.boundSessionIds()).toEqual([BOUND_SESSION_ID]);
  });

  it("disposes the binder in the same cleanup, before the registry", () => {
    // `vi.spyOn` calls through, so the order is read off the hook's real calls.
    const disposeBinder = vi.spyOn(SessionEventSubscriber.prototype, "dispose");
    const disposeRegistry = vi.spyOn(SessionStoreRegistry.prototype, "disposeAll");
    const { diagnosticsHolder, wrapper } = compositionHarness();
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
    // The subscriber holds the registry's change subscription, so disposing the registry first
    // would call back into a subscriber already tearing down.
    expect(binderCallOrder ?? 0).toBeLessThan(registryCallOrder ?? 0);
    expect(diagnosticsHolder.installed).toBeUndefined();
  });

  it("negative control: the ordering comparison notices the opposite order", () => {
    // Without this, the `toBeLessThan` comparison could pass on an order recorded backwards.
    const disposeBinder = vi.spyOn(SessionEventSubscriber.prototype, "dispose");
    const disposeRegistry = vi.spyOn(SessionStoreRegistry.prototype, "disposeAll");
    const registry = new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
    const binder = new SessionEventSubscriber({
      registry,
      bridge: createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO }).bridge,
    });

    registry.disposeAll();
    binder.dispose();

    const binderCallOrder = disposeBinder.mock.invocationCallOrder[0] ?? 0;
    const registryCallOrder = disposeRegistry.mock.invocationCallOrder[0] ?? 0;
    expect(binderCallOrder).toBeGreaterThan(registryCallOrder);
  });
});
