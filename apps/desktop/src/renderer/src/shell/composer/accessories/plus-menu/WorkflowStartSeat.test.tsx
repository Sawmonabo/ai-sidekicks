// The seat defers the picker, and the picker still arrives.
//
// TWO CASES BECAUSE A LOADER HAS TWO WAYS TO BE WRONG, and one of them looks like
// success. A seat whose body is on the entry chunk renders the picker on the first frame
// and every assertion about the picker passes — which is exactly the state the boundary
// this file guards was introduced to leave behind. A seat whose loader never resolves
// renders the reserved region for ever and the first case alone would call that correct.
// So the deferral and the arrival are asserted separately, in that order.
//
// THE STATIC HALF IS NOT HERE. Whether the picker's directory is on the initial import
// graph is a fact about the module graph and not about a render, and
// `test/console/architecture/composer-workflow-picker-boundary.test.ts` measures it from
// both importers. What this file measures is the half that reaches a person: what the `+`
// menu holds before the chunk lands, and what it holds after.
//
// ORDER IS LOAD-BEARING WITHIN THIS FILE. The seat's `LoadedLazyBody` memoises its module
// promise for the life of the module registry, and Vitest gives each test FILE its own —
// so the first case below is the one cold mount this file gets, and a case added above it
// would warm the registration and turn the deferral assertion into a coin toss.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../../../console/bridge/index.js";
import { RAIL_SCENARIO, SESSION_ID } from "../rail.test-support.js";
import { WorkflowStartSeat } from "./WorkflowStartSeat.js";

afterEach(cleanup);

/**
 * Mount the seat over a real port.
 *
 * The zone's own fixture bridge rather than a stand-in, on two rules at once: a test
 * drives the real module, and a role that already has a home is taken from it — the
 * accessory rail's harness beside this directory owns the scenario every case in this
 * zone mounts against. What the picker's enumeration answers over that port is the
 * picker's own suite's subject; what this file needs is a port the body can be
 * constructed against at all.
 */
function mountSeat(): HTMLElement {
  const { container } = render(
    <WorkflowStartSeat
      growth={createFixtureBridge({ scenario: RAIL_SCENARIO }).growth}
      sessionId={SESSION_ID}
      channelId={undefined}
    />,
  );
  return container;
}

describe("the composer's workflow-picker seat", () => {
  it("holds the reserved region while the picker's chunk is still in flight", () => {
    const container = mountSeat();

    // The body is behind an `import()`, which cannot settle inside the synchronous commit
    // this mount performs — so what a person meets on the first frame is the seat's own
    // reserved region, announced rather than silent.
    expect(container.querySelector(".meridian-workflow-start-menu")).toBeNull();
    const reserved = container.querySelector(".meridian-nothing--not-loaded");
    expect(reserved).not.toBeNull();
    expect(reserved?.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).toContain("Reading the workflows this session can start.");
  });

  it("reveals the picker once that chunk has landed", async () => {
    const container = mountSeat();

    await waitFor(() => {
      expect(container.querySelector(".meridian-workflow-start-menu")).not.toBeNull();
    });
    // The body's own first line, so the assertion is about the picker having mounted and
    // not merely about a class name the reserved region could have carried.
    expect(container.textContent).toContain("Start a workflow");
  });
});
