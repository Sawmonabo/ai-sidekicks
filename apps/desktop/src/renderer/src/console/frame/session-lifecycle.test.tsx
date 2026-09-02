// One store per session, however often the frame renders.
//
// The shape this replaced built a `SessionStore` inside a render body and kept it in
// a `Map` held by a ref. Two things were wrong with it and only one is visible in a
// snapshot: a render pass React discards takes its store — and every event applied
// to it — with it, and the construction is a side effect performed in the render
// phase either way. So the cases here are about IDENTITY and about TIMING, and each
// has a control that fails the way a regression would.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SessionStore, SessionStoreRegistry } from "../store/index.js";
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

describe("useActiveSessionStore — the session store a render resolves", () => {
  it("answers every render of one session with the same store", () => {
    const observed: Observation[] = [];
    const observe = (observation: Observation): void => {
      observed.push(observation);
    };
    const { rerender } = render(<SessionProbe sessionId="session-1" onObserve={observe} />);
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
    const { rerender } = render(<SessionProbe sessionId="session-3" onObserve={observe} />);
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
