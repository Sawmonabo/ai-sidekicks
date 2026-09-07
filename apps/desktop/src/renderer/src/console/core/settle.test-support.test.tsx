// The shared settle, and the bound that stopped being a caller's argument.
//
// Nine suites carried this loop with nine hard-coded bounds (3, 3, 3, 4, 4, 4, 6, 8)
// and no way to assert anything across them. Each number was the depth of one
// surface's own effect chain as its author found it, which is a fact that goes stale
// the moment a read grows a link — and goes stale SILENTLY, because a case that stops
// waiting long enough reports the absence of an answer still in flight.
//
// So the property pinned here is the one that replaced the argument: the settle is a
// BOUNDARY. The two cases are chosen to be the ones a counted loop fails — a chain
// deeper than any single pass, and an arrival that no number of microtask passes can
// reach at all — so a regression to counting fails here rather than intermittently in
// whichever suite was written over the shortest chain.

import { useEffect, useState } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { REFRESH_DEBOUNCE_MS } from "./constants.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "./settle.test-support.js";

/** How many microtask links the deep-chain case puts between mount and arrival. */
const CHAINED_MICROTASK_LINKS = 5;

/** A component whose arrival is several microtask links away from its mount. */
function ChainedArrival(): React.JSX.Element {
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    let chain = Promise.resolve();
    for (let link = 0; link < CHAINED_MICROTASK_LINKS; link += 1) {
      chain = chain.then(() => undefined);
    }
    void chain.then(() => {
      setLanded(true);
    });
  }, []);
  return <output>{landed ? "landed" : "outstanding"}</output>;
}

/** A component whose arrival is on a task of its own, which no microtask reaches. */
function TaskArrival(): React.JSX.Element {
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setLanded(true);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return <output>{landed ? "landed" : "outstanding"}</output>;
}

function textOf(container: HTMLElement): string {
  return container.textContent ?? "";
}

describe("the shared settle", () => {
  it("lands an arrival deeper than any pass a caller would have counted", async () => {
    const { container } = render(<ChainedArrival />);

    await settle();

    expect(textOf(container)).toBe("landed");
  });

  it("lands an arrival raised on a task, which no count of microtasks reaches", async () => {
    // The discriminating case. Every hard-coded bound this module replaced counted
    // microtask passes, and a surface whose read completes on a timer is not one
    // pass away from settling — it is unreachable that way at any count. A settle
    // that regressed to counting reports "outstanding" here.
    const { container } = render(<TaskArrival />);

    await settle();

    expect(textOf(container)).toBe("landed");
  });

  it("asks its caller for no bound at all", () => {
    // The shape claim, pinned where a reader can see it: the argument is gone, so no
    // caller can state a depth and no caller's stated depth can go stale.
    expect(settle).toHaveLength(0);
  });
});

describe("the derived debounce wait", () => {
  it("carries past the refresh window rather than restating a literal", () => {
    expect(PAST_REFRESH_DEBOUNCE_MS).toBeGreaterThan(REFRESH_DEBOUNCE_MS);
    expect(PAST_REFRESH_DEBOUNCE_MS).toBe(REFRESH_DEBOUNCE_MS * 2);
  });
});
