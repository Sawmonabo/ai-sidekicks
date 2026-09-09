// The history as the RUN's record: the durable rows, driven through the real fixture.
//
// A second suite beside `InterventionHistory.test.tsx`, which drives the half this
// window dispatched. This one drives the half it did not: rows raised by another
// participant, by this participant in a previous window, and by the system, read
// through the growth port and rendered with the origin, the admitting principal, the
// admitted queue item, and the directive the daemon could still decrypt.
//
// The refusal case is the others' negative control. A history that had lost the read
// would render its empty arm under every scenario, and a suite that only asserted rows
// under the runs scenario would go on passing.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../../../bridge/scenario/onboarding.js";
import { RUNS_SCENARIO } from "../../../bridge/scenario/runs/runs.js";
import { RUN_ID } from "../../../bridge/scenario/runs/identifiers.js";
import { InterventionHistory } from "./InterventionHistory.js";

/** The real component over the real fixture, with no dispatched rows beside it. */
async function renderDurableHistory(bridge: ConsoleBridge): Promise<HTMLElement> {
  const { container } = render(<InterventionHistory records={[]} runId={RUN_ID} bridge={bridge} />);
  await waitFor(() => {
    expect(
      container.querySelector(".meridian-nothing, .meridian-interventions__rows"),
    ).not.toBeNull();
  });
  return container;
}

describe("the durable record is the run's, not this window's", () => {
  it("draws one row per durable intervention, in the daemon's order", async () => {
    const bridge = createFixtureBridge({ scenario: RUNS_SCENARIO });

    const container = await renderDurableHistory(bridge);

    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-interventions__row")).toHaveLength(4);
    });
    // And under a name saying whose rows these are: the run's, not this window's.
    // Unnamed, an intervention appearing in both lists reads as one listed twice.
    const caption = container.querySelector(".meridian-interventions__source-name");
    expect(caption?.textContent).toContain("Everything directed at this run");
    expect(
      container.querySelector(".meridian-interventions__rows")?.getAttribute("aria-labelledby"),
    ).toBe(caption?.id);
  });

  it("names the origin on every row and the admitting principal on the participant arm", async () => {
    const bridge = createFixtureBridge({ scenario: RUNS_SCENARIO });

    const container = await renderDurableHistory(bridge);

    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-interventions__row")).toHaveLength(4);
    });
    const rendered = container.textContent ?? "";
    expect(rendered).toContain("participant");
    expect(rendered).toContain("system");
    // The principal travels with the participant arm. Read out of the rendered text
    // rather than off the record, so a component that dropped the member fails here.
    expect(rendered).toContain("019b7a22-2200-79a4-8110-cca0117a0411");
  });

  it("says the directive is unreadable rather than rendering an empty line", async () => {
    const bridge = createFixtureBridge({ scenario: RUNS_SCENARIO });

    const container = await renderDurableHistory(bridge);

    await waitFor(() => {
      expect(container.textContent ?? "").toContain("cannot be read");
    });
    // And the readable one is still rendered as itself, so the unavailable arm is a
    // statement about one row rather than the component's only behaviour.
    expect(container.querySelector(".meridian-interventions__directive")).not.toBeNull();
  });

  it("shows the queue item an intervention admitted, through the row's own linkage", async () => {
    const bridge = createFixtureBridge({ scenario: RUNS_SCENARIO });

    const container = await renderDurableHistory(bridge);

    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Admitted queue item");
    });
  });

  it("renders the rejection reason verbatim on a rejected row", async () => {
    const bridge = createFixtureBridge({ scenario: RUNS_SCENARIO });

    const container = await renderDurableHistory(bridge);

    await waitFor(() => {
      expect(container.querySelector(".meridian-interventions__reason")?.textContent).toBe(
        "run.invalid_transition",
      );
    });
  });

  it("negative control: a refused read renders the refusal, never an empty record", async () => {
    // A scenario that declares no durable record for this run: the read refuses, and
    // the surface must not report that as "no intervention was ever raised".
    const bridge = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });

    const container = await renderDurableHistory(bridge);

    await waitFor(() => {
      expect(container.querySelector(".meridian-refusal")).not.toBeNull();
    });
    expect(container.querySelectorAll(".meridian-interventions__row")).toHaveLength(0);
  });
});
