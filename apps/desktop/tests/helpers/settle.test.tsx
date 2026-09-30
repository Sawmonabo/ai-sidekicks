// The shared settle waits on a boundary, not a counted number of microtask passes.
//
// The two cases are the ones a counted loop fails: a chain deeper than any single pass, and an
// arrival no number of microtask passes can reach. A regression to counting fails here rather than
// intermittently in whichever suite has the shortest chain.

import { useEffect, useState } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle } from "./settle.js";

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
    // A component whose read completes on a timer is unreachable by counting microtask passes at
    // any count; a settle that regressed to counting reports "outstanding" here.
    const { container } = render(<TaskArrival />);

    await settle();

    expect(textOf(container)).toBe("landed");
  });

  it("asks its caller for no bound at all", () => {
    // With no argument, no caller can state a depth that goes stale.
    expect(settle).toHaveLength(0);
  });
});

describe("the derived debounce wait", () => {
  it("carries past the refresh window rather than restating a literal", () => {
    expect(PAST_REFRESH_DEBOUNCE_MS).toBeGreaterThan(REFRESH_DEBOUNCE_MS);
    expect(PAST_REFRESH_DEBOUNCE_MS).toBe(REFRESH_DEBOUNCE_MS * 2);
  });
});
