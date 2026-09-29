// The pages beyond the first: the cursor is kept and the next page appends, in order and
// without repeating a definition the list already holds.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import {
  PROBE_SESSION_ID,
  SECOND_PAGE_CURSOR,
  settle,
} from "../../workflows-probe.test-support.js";
import type { WorkflowDefinitionDirectory } from "./useWorkflowDefinitionDirectory.js";
import {
  definitionIds,
  definitionWithId,
  latest,
  lastState,
  observeDirectory,
  twoPageCall,
} from "./useWorkflowDefinitionDirectory.test-support.js";

/** Press the continuation the definitions list would offer, and let its page settle. */
async function continueReading(observed: readonly WorkflowDefinitionDirectory[]): Promise<void> {
  await act(async () => {
    latest(observed).continueReading();
    await crossMacrotaskBoundary();
  });
}

describe("useWorkflowDefinitionDirectory — the pages beyond the first", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the daemon's cursor and appends the page it reaches, in order", async () => {
    // The negative control for the whole continuation: over the hook that discarded
    // `nextCursor` this list stopped at two rows with nothing on screen saying there
    // were more — the definitions past the first page were unreachable, not unshown.
    const observed = observeDirectory(twoPageCall(), PROBE_SESSION_ID);
    await settle();
    expect(definitionIds(lastState(observed))).toStrictEqual(["first", "second"]);

    await continueReading(observed);

    expect(definitionIds(lastState(observed))).toStrictEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("marks the continuation in flight, distinctly from the first read", async () => {
    // A wait ON pages already held is a different fact from a wait FOR the first page:
    // the rows stay on screen through one and there are none to show through the other.
    const observed = observeDirectory(twoPageCall(), PROBE_SESSION_ID);
    await settle();

    act(() => {
      latest(observed).continueReading();
    });

    const inFlight = lastState(observed);
    expect(inFlight.status).toBe("served");
    if (inFlight.status === "served") {
      expect(inFlight.continuation).toStrictEqual({
        status: "reading",
        cursor: SECOND_PAGE_CURSOR,
      });
      // The rows held are not withdrawn while the next page arrives.
      expect(definitionIds(inFlight)).toStrictEqual(["first", "second"]);
    }
    await settle();
  });

  it("holds no cursor once the daemon serves a page without one", async () => {
    const observed = observeDirectory(twoPageCall(), PROBE_SESSION_ID);
    await settle();

    await continueReading(observed);

    const settled = lastState(observed);
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.continuation).toStrictEqual({ status: "exhausted" });
    }
  });

  it("negative control: a single-page answer offers no continuation at all", async () => {
    // Without this, a hook that reported `available` unconditionally would pass every
    // case above — and the definitions list would render a control that fetched one page
    // forever.
    const observed = observeDirectory(
      async () => ({ definitions: [definitionWithId("only")] }),
      PROBE_SESSION_ID,
    );

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.continuation).toStrictEqual({ status: "exhausted" });
    }
  });

  it("never shows one definition twice when two pages overlap", async () => {
    // The wire guarantees no disjointness a console may rely on: a definition authored
    // between two reads shifts the window. A row rendered twice is also two React
    // children carrying one key.
    const observed = observeDirectory(twoPageCall(["second", "third"]), PROBE_SESSION_ID);
    await settle();

    await continueReading(observed);

    expect(definitionIds(lastState(observed))).toStrictEqual(["first", "second", "third"]);
  });
});
