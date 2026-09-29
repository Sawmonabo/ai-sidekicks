// The window's binder: minted beside the registry, attached, and torn down first.
//
// "The hook mints a registry" is only half a claim — the other half is that it
// mints the binder beside it, attaches it, and tears the two down in the order that
// cannot have one call into the other.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { FLAGSHIP_SCENARIO } from "@renderer/console/bridge/scenario/flagship/flagship.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import {
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  type ConsoleSessionDiagnostics,
} from "@renderer/services/session-events/session-diagnostics-handle.js";
import { SessionEventBinder } from "@renderer/services/session-events/session-event-subscriber.js";
import { SessionProbe, fixtureBridgeWrapper } from "./session-store-hooks.test-support.js";

/** The page slot a fixture build hangs the window's session diagnostics on. */
function readInstalledDiagnostics(): ConsoleSessionDiagnostics | undefined {
  return (globalThis as Record<string, unknown>)[SESSION_DIAGNOSTICS_FIXTURE_GLOBAL] as
    | ConsoleSessionDiagnostics
    | undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSessionStoreRegistry — the window's registry and the binder that feeds it", () => {
  it("mints a binder beside the registry and binds the open session", () => {
    render(<SessionProbe sessionId="session-bound" onObserve={() => undefined} />, {
      wrapper: fixtureBridgeWrapper(),
    });

    // Read through the page handle rather than through a returned object, because
    // the hook deliberately does not hand the binder out — this is the same slot
    // the endurance tier reads, so the case also proves the tier has something to
    // read.
    const diagnostics = readInstalledDiagnostics();
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.openSessionIds()).toEqual(["session-bound"]);

    expect(diagnostics?.boundSessionIds()).toEqual(["session-bound"]);
  });

  it("disposes the binder in the same cleanup, before the registry", () => {
    // Spies over the REAL methods (`vi.spyOn` calls through), so the ordering is
    // read off the calls the hook actually made rather than off a substitute that
    // could be ordered any way at all.
    const disposeBinder = vi.spyOn(SessionEventBinder.prototype, "dispose");
    const disposeRegistry = vi.spyOn(SessionStoreRegistry.prototype, "disposeAll");
    const { unmount } = render(
      <SessionProbe sessionId="session-teardown" onObserve={() => undefined} />,
      { wrapper: fixtureBridgeWrapper() },
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
    // Nothing is left hanging off the page once the window is gone.
    expect(readInstalledDiagnostics()).toBeUndefined();
  });

  it("negative control: the ordering comparison notices the opposite order", () => {
    // Without this, `toBeLessThan` over two numbers read from the same counter
    // would pass on any pair the harness happened to produce — including one
    // recorded in the wrong order.
    const disposeBinder = vi.spyOn(SessionEventBinder.prototype, "dispose");
    const disposeRegistry = vi.spyOn(SessionStoreRegistry.prototype, "disposeAll");
    const registry = new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
    const binder = new SessionEventBinder({
      registry,
      bridge: createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }),
    });

    registry.disposeAll();
    binder.dispose();

    const binderCallOrder = disposeBinder.mock.invocationCallOrder[0] ?? 0;
    const registryCallOrder = disposeRegistry.mock.invocationCallOrder[0] ?? 0;
    expect(binderCallOrder).toBeGreaterThan(registryCallOrder);
  });
});
