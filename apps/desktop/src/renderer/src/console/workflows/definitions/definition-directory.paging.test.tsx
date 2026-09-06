// The pages beyond the first: the cursor is kept, the next page appends, and a
// refusal partway through withdraws nothing already served.
//
// These cases cannot use a scenario the way the settlement suite next door does. The
// engine matches a scripted reply on the call name alone, so one scenario serves
// exactly one page and a second is unscriptable there. They answer from the real port
// with one method replaced instead, the shape `seats/session-directory.test.tsx`
// already uses to count reads — the value returned is still the registered one, so a
// page this fixture serves is a page the wire could send.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { growthUnavailable } from "../../bridge/index.js";
import { PROBE_SESSION_ID, SECOND_PAGE_CURSOR, settle } from "../workflows-probe.test-support.js";
import type { WorkflowDefinitionDirectory } from "./definition-directory.js";
import {
  definitionIds,
  definitionWithId,
  latest,
  lastState,
  observeDirectory,
  pagedGrowthPort,
  twoPagePort,
} from "./definition-directory.test-support.js";

/** Press the continuation the surface would offer, and let its page settle. */
async function continueReading(observed: readonly WorkflowDefinitionDirectory[]): Promise<void> {
  await act(async () => {
    latest(observed).continueReading();
    await Promise.resolve();
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
    const observed = observeDirectory(twoPagePort(), PROBE_SESSION_ID);
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
    const observed = observeDirectory(twoPagePort(), PROBE_SESSION_ID);
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
    const observed = observeDirectory(twoPagePort(), PROBE_SESSION_ID);
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
    // case above — and a surface would render a control that fetched one page forever.
    const observed = observeDirectory(
      pagedGrowthPort(() => ({
        status: "served",
        value: { definitions: [definitionWithId("only")] },
      })),
      PROBE_SESSION_ID,
    );

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.continuation).toStrictEqual({ status: "exhausted" });
    }
  });

  it("keeps the pages already held when a continuation is refused", async () => {
    const observed = observeDirectory(
      pagedGrowthPort((cursor) =>
        cursor === undefined
          ? {
              status: "served",
              value: {
                definitions: [definitionWithId("first"), definitionWithId("second")],
                nextCursor: SECOND_PAGE_CURSOR,
              },
            }
          : growthUnavailable("workflowDefinitionList"),
      ),
      PROBE_SESSION_ID,
    );
    await settle();

    await continueReading(observed);

    const settled = lastState(observed);
    // The whole directory is NOT unavailable: the rows on screen were served and are
    // still true, and withdrawing them would be the console withdrawing a list the
    // daemon never withdrew.
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(definitionIds(settled)).toStrictEqual(["first", "second"]);
      expect(settled.continuation.status).toBe("unavailable");
      if (settled.continuation.status === "unavailable") {
        expect(settled.continuation.refusal.code).toBe("wire-unregistered");
        // The cursor survives the refusal, so the same ask is what a person retries.
        expect(settled.continuation.cursor).toBe(SECOND_PAGE_CURSOR);
      }
    }
  });

  it("never shows one definition twice when two pages overlap", async () => {
    // The wire guarantees no disjointness a console may rely on: a definition authored
    // between two reads shifts the window. A row rendered twice is also two React
    // children carrying one key.
    const observed = observeDirectory(twoPagePort(["second", "third"]), PROBE_SESSION_ID);
    await settle();

    await continueReading(observed);

    expect(definitionIds(lastState(observed))).toStrictEqual(["first", "second", "third"]);
  });
});
