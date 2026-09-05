// The shared settle, and the bound that stayed a caller's argument.
//
// Nine suites carried this loop with nine hard-coded bounds (3, 3, 3, 4, 4, 4, 6, 8)
// and no way to assert anything across them. What is shared is the mechanism — `act`
// around a resolved promise, so React flushes the effects each pass schedules — and
// what is not is the bound, which is the depth of one surface's own effect chain.
//
// So the property pinned here is that the bound IS the argument: a call asking for
// no pass flushes nothing, and one asking for a pass lands the arrival. A loop that
// ignored what it was handed — which is what nine hard-coded copies amounted to —
// fails the first case.

import { useEffect, useState } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { REFRESH_DEBOUNCE_MS } from "./constants.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "./settle.test-support.js";

/** A component with one arrival outstanding: the shape every read here has. */
function OneArrival(): React.JSX.Element {
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    void Promise.resolve().then(() => {
      setLanded(true);
    });
  }, []);
  return <output>{landed ? "landed" : "outstanding"}</output>;
}

function textOf(container: HTMLElement): string {
  return container.textContent ?? "";
}

describe("the shared microtask settle", () => {
  it("lands an outstanding arrival when asked for a pass", async () => {
    const { container } = render(<OneArrival />);

    await settle(1);

    expect(textOf(container)).toBe("landed");
  });

  it("flushes nothing when asked for no pass", async () => {
    // The negative control. A loop that ignored its argument — which is what each
    // of the nine hard-coded copies was — settles here and reports "landed", so
    // this case is the one that fails on the shape this module replaced.
    const { container } = render(<OneArrival />);

    await settle(0);

    expect(textOf(container)).toBe("outstanding");
  });
});

describe("the derived debounce wait", () => {
  it("carries past the refresh window rather than restating a literal", () => {
    expect(PAST_REFRESH_DEBOUNCE_MS).toBeGreaterThan(REFRESH_DEBOUNCE_MS);
    expect(PAST_REFRESH_DEBOUNCE_MS).toBe(REFRESH_DEBOUNCE_MS * 2);
  });
});
