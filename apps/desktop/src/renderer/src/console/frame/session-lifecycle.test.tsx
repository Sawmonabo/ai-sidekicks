// One store per session, one binder per window, however often the frame renders.
//
// The shape this replaced built a `SessionStore` inside a render body and kept it in
// a `Map` held by a ref. Two things were wrong with it and only one is visible in a
// snapshot: a render pass React discards takes its store — and every event applied
// to it — with it, and the construction is a side effect performed in the render
// phase either way. So the cases here are about IDENTITY and about TIMING, and each
// has a control that fails the way a regression would.
//
// The last cases are about a third thing the earlier shape did not have at all:
// the window's binder. "The hook mints a registry" is only half a claim — the
// other half is that it mints the binder beside it, attaches it, and tears the two
// down in the order that cannot have one call into the other. What that attached
// binder BINDS is its own claim, and it now depends on the bridge: the fixture
// serves the growth port's session read, so a store can reach a base state and the
// window binds; a bridge that refuses it hands the registry the refusal itself, no
// store can be initialised, and a bound stream would be retained forever and
// projected never. Both arms are cases, and each is the other's control.

import { createTier1Bridge } from "@ai-sidekicks/contracts";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  type ConsoleBridge,
} from "../bridge/index.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { createLiveBridge } from "../bridge/live-bridge.js";
import { SessionStoreRegistry, type SessionStore } from "../store/index.js";
import {
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  SessionEventBinder,
  type ConsoleSessionDiagnostics,
} from "./session-event-binder.js";
import { useActiveSessionStore, useSessionStoreRegistry } from "./session-lifecycle.js";

interface Observation {
  readonly registry: SessionStoreRegistry;
  readonly store: SessionStore | undefined;
}

interface SessionProbeProps {
  readonly sessionId: string;
  readonly onObserve: (observation: Observation) => void;
}

/** A component that does exactly what the frame does, and reports what it saw. */
function SessionProbe(props: SessionProbeProps): null {
  const registry = useSessionStoreRegistry();
  const store = useActiveSessionStore(registry, props.sessionId);
  props.onObserve({ registry, store });
  return null;
}

/**
 * The provider the frame renders inside, around one fixture bridge.
 *
 * Built once per case and closed over, because the provider resolves on bridge
 * IDENTITY: a wrapper that made a new fixture on every render would restart the
 * scenario engine mid-pass and reset the frozen clock underneath it.
 */
function fixtureBridgeWrapper(): (props: { readonly children: ReactNode }) => React.JSX.Element {
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  return function FixtureBridgeHost(props: { readonly children: ReactNode }): React.JSX.Element {
    return <SidekicksBridgeProvider bridge={bridge}>{props.children}</SidekicksBridgeProvider>;
  };
}

/** The assertion: how many different stores answered these renders. */
function distinctStores(stores: readonly (SessionStore | undefined)[]): number {
  return new Set(stores.filter((store) => store !== undefined)).size;
}

function lastObservation(observed: readonly Observation[]): Observation {
  const observation = observed.at(-1);
  if (observation === undefined) {
    throw new Error("the probe never rendered");
  }
  return observation;
}

/** The page slot a fixture build hangs the window's session diagnostics on. */
function readInstalledDiagnostics(): ConsoleSessionDiagnostics | undefined {
  return (globalThis as Record<string, unknown>)[SESSION_DIAGNOSTICS_FIXTURE_GLOBAL] as
    | ConsoleSessionDiagnostics
    | undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useActiveSessionStore — the session store a render resolves", () => {
  it("answers every render of one session with the same store", () => {
    const observed: Observation[] = [];
    const observe = (observation: Observation): void => {
      observed.push(observation);
    };
    const wrapper = fixtureBridgeWrapper();
    const { rerender } = render(<SessionProbe sessionId="session-1" onObserve={observe} />, {
      wrapper,
    });
    rerender(<SessionProbe sessionId="session-1" onObserve={observe} />);
    rerender(<SessionProbe sessionId="session-1" onObserve={observe} />);

    expect(observed.length).toBeGreaterThan(3);
    expect(distinctStores(observed.map((observation) => observation.store))).toBe(1);
    expect(lastObservation(observed).registry.openCount).toBe(1);
  });

  it("resolves nothing on the first pass, because the open is an effect and not a render", () => {
    const observed: Observation[] = [];
    render(
      <SessionProbe
        sessionId="session-render-phase"
        onObserve={(observation) => {
          observed.push(observation);
        }}
      />,
      { wrapper: fixtureBridgeWrapper() },
    );

    // The first render happens before any effect has run, so the honest answer
    // there is "not open yet" — which is precisely what a render that opened the
    // session itself would have hidden.
    expect(observed[0]?.store).toBeUndefined();
    expect(lastObservation(observed).store).toBeDefined();
  });

  it("keeps one registry across re-renders rather than one per pass", () => {
    const observed: Observation[] = [];
    const observe = (observation: Observation): void => {
      observed.push(observation);
    };
    const wrapper = fixtureBridgeWrapper();
    const { rerender } = render(<SessionProbe sessionId="session-3" onObserve={observe} />, {
      wrapper,
    });
    rerender(<SessionProbe sessionId="session-3" onObserve={observe} />);

    expect(new Set(observed.map((observation) => observation.registry)).size).toBe(1);
  });

  it("negative control: the same comparison reports two when a session is genuinely reopened", () => {
    const observed: Observation[] = [];
    render(
      <SessionProbe
        sessionId="session-2"
        onObserve={(observation) => {
          observed.push(observation);
        }}
      />,
      { wrapper: fixtureBridgeWrapper() },
    );
    const { registry } = lastObservation(observed);
    const before = lastObservation(observed).store;

    // A close followed by an open is the one way to get a second store for one
    // session id past the registry's idempotent `open`. If the cases above could
    // not tell that apart from the single-store answer, they would be asserting
    // nothing.
    act(() => {
      registry.close("session-2");
      registry.open("session-2");
    });
    const after = lastObservation(observed).store;

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(distinctStores([before, after])).toBe(2);
  });
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
