// The window's binder: minted beside the registry, attached, and torn down first.
//
// "The hook mints a registry" is only half a claim — the other half is that it
// mints the binder beside it, attaches it, and tears the two down in the order that
// cannot have one call into the other.
//
// What that attached binder BINDS depends on the bridge, so both arms are cases and
// each is the other's control: the fixture serves the growth port's session read, so
// a store can reach a base state and the window binds; a bridge that refuses it
// hands the registry the refusal itself, no store can be initialised, and a bound
// stream would be retained forever and projected never.

import { createTier1Bridge } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../bridge/index.js";
import { createLiveBridge } from "../bridge/live-bridge.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { SessionStoreRegistry } from "../store/index.js";
import {
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  SessionEventBinder,
  type ConsoleSessionDiagnostics,
} from "./session-event-binder.js";
import {
  SessionProbe,
  fixtureBridgeWrapper,
  lastObservation,
  type Observation,
} from "./session-lifecycle.test-support.js";

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
  it("mints a binder beside the registry and binds the open session, the bridge serving the read", () => {
    const observed: Observation[] = [];
    render(
      <SessionProbe
        sessionId="session-bound"
        onObserve={(observation) => {
          observed.push(observation);
        }}
      />,
      { wrapper: fixtureBridgeWrapper() },
    );

    // Read through the page handle rather than through a returned object, because
    // the hook deliberately does not hand the binder out — this is the same slot
    // the endurance tier reads, so the case also proves the tier has something to
    // read.
    const diagnostics = readInstalledDiagnostics();
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.openSessionIds()).toEqual(["session-bound"]);

    // The fixture bridge serves the growth port's session read, so the registry
    // this hook builds can give a store a base state and the window binds. This is
    // the reading that was zero in every build before the read had a producer —
    // the whole store layer dormant, and the endurance tier measuring an idle loop.
    const { registry } = lastObservation(observed);
    expect(registry.canInitialiseSessionStores).toBe(true);
    expect(registry.readRefusal).toBeUndefined();
    expect(diagnostics?.boundSessionIds()).toEqual(["session-bound"]);
  });

  it("hands the registry the refusal itself when the bridge does not serve the read", () => {
    // The other arm, over the REAL live bridge rather than a registry constructed
    // by hand: the composition root has to resolve the read off what the bridge
    // says it serves, and the live bridge serves nothing. Binding here would call
    // `daemon.subscribe` on a Tier-1 bridge, which throws — so "bind and find out"
    // is not a fallback, it is a crash inside a mount effect.
    const observed: Observation[] = [];
    const bridge = createLiveBridge(createTier1Bridge());
    render(
      <SidekicksBridgeProvider bridge={bridge}>
        <SessionProbe
          sessionId="session-unreadable"
          onObserve={(observation) => {
            observed.push(observation);
          }}
        />
      </SidekicksBridgeProvider>,
    );

    const { registry } = lastObservation(observed);
    expect(registry.canInitialiseSessionStores).toBe(false);
    // The refusal names the operation and who owes the wire, which a reason-less
    // sentinel could not: that is the whole reason it replaced one.
    expect(registry.readRefusal?.origin).toBe("growth-port");
    expect(registry.readRefusal?.code).toBe("wire-unregistered");
    expect(readInstalledDiagnostics()?.boundSessionIds()).toEqual([]);
    expect(readInstalledDiagnostics()?.appliedEventCountFor("session-unreadable")).toBe(0);
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
