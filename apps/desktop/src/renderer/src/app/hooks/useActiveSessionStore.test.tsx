// One store per session, however often the frame renders, and none constructed in the render
// phase (a discarded pass would take its store and every applied event with it). The registry
// and subscriber wiring have their own `useSessionStoreRegistry.*.test.tsx` files.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  SessionProbe,
  fixtureBridgeWrapper,
  lastObservation,
  type Observation,
} from "./session-store-hooks.test-support.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";

/** The assertion: how many different stores answered these renders. */
function distinctStores(stores: readonly (SessionStore | undefined)[]): number {
  return new Set(stores.filter((store) => store !== undefined)).size;
}

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

    // The first render precedes every effect, so the answer is "not open yet"; a render that
    // opened the session itself would have hidden that.
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

    // Close then open is the one way past the registry's idempotent `open` to a second store for
    // one session; if the cases above could not tell that apart, they would assert nothing.
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
