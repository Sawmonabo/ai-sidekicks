// The session the route names is opened, and one store answers it however often the frame
// renders; a second store would start without every event the first had applied.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  SessionProbe,
  fixtureBridgeWrapper,
  lastObservation,
  type Observation,
} from "./session-store-hooks.test-support.js";
import type { SessionStore } from "#renderer/store/session/session-store.js";

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
});
