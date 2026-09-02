// The history keeps the attempts that failed, and says what it cannot see.
//
// Two claims, and the second is the one that keeps this surface honest: a refused
// control is a ROW rather than an omission, because interventions require durable
// audit records even when they fail; and the surface states plainly that the
// durable record — with the `origin` discriminator and the admitting principal —
// is not something it can read, rather than inferring either.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { InterventionHistory } from "./InterventionHistory.js";
import type { RunControlRecord } from "./run-control-surface.js";

const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const OTHER_RUN_ID = "c4e1b2d3-5f60-4071-9b82-0d3e4f506172";
const INTERVENTION_ID = "d5f2c3e4-6071-4182-ac93-1e4f50617283";

function refusedRecord(recordId: string, runId: string): RunControlRecord {
  return {
    recordId,
    runId,
    control: "cancel",
    outcome: {
      kind: "refused",
      control: "cancel",
      refusal: refuse("run-controls", "run.invalid_transition", "the run has already completed"),
    },
  };
}

function degradedRollbackRecord(recordId: string): RunControlRecord {
  return {
    recordId,
    runId: RUN_ID,
    control: "rollback",
    outcome: {
      kind: "settled",
      control: "rollback",
      response: {
        interventionId: INTERVENTION_ID as never,
        interventionType: "rollback",
        state: "degraded",
        runVersion: 12,
        result: {
          disposition: "boundary-diverged",
          confirmedPosition: 9,
          newestBoundaryPosition: null,
        },
      },
    },
  };
}

function renderHistory(records: readonly RunControlRecord[]): HTMLElement {
  const { container } = render(<InterventionHistory records={records} runId={RUN_ID} />);
  return container;
}

describe("failed attempts are part of the record", () => {
  it("renders a refused control as a row carrying its code verbatim", () => {
    const container = renderHistory([refusedRecord("one", RUN_ID)]);
    expect(container.querySelectorAll(".meridian-interventions__row")).toHaveLength(1);
    expect(container.textContent).toContain("run.invalid_transition");
    expect(container.textContent).toContain("the run has already completed");
  });

  it("negative control: a row for another run is not this run's history", () => {
    // Without this the case above would pass over a component that rendered every
    // record it was handed, which would attribute one run's interventions to another.
    const container = renderHistory([refusedRecord("two", OTHER_RUN_ID)]);
    expect(container.querySelectorAll(".meridian-interventions__row")).toHaveLength(0);
  });
});

describe("what the surface cannot read, it says", () => {
  it("names the durable record rather than presenting an empty list as complete", () => {
    const container = renderHistory([]);
    expect(container.textContent).toContain("durable record");
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("never renders an origin or an admitting principal, which no wire supplies", () => {
    // §7.5: the discriminator is RESOLVED, never inferred. The honest form of that
    // here is that neither word appears at all.
    const container = renderHistory([refusedRecord("three", RUN_ID)]);
    expect(container.textContent).not.toContain("participant arm");
    expect(container.textContent).not.toContain("admitting principal");
  });
});

describe("a degraded settlement is never a success", () => {
  it("renders the disposition and both daemon-supplied positions", () => {
    const container = renderHistory([degradedRollbackRecord("four")]);
    expect(container.textContent).toContain("boundary-diverged");
    expect(container.textContent).toContain("degraded");
    expect(container.textContent).toContain("9");
    // The wire's own null, stated rather than replaced with a number.
    expect(container.textContent).toContain("carries no position");
  });

  it("says the run is not resumable and names the standing refusal", () => {
    const container = renderHistory([degradedRollbackRecord("five")]);
    expect(container.textContent).toContain("run.compaction_boundary_diverged");
  });

  it("negative control: an applied settlement carries neither claim", () => {
    const container = renderHistory([
      {
        recordId: "six",
        runId: RUN_ID,
        control: "rollback",
        outcome: {
          kind: "settled",
          control: "rollback",
          response: {
            interventionId: INTERVENTION_ID as never,
            interventionType: "rollback",
            state: "applied",
            runVersion: 12,
            result: { disposition: "conversation-only" },
          },
        },
      },
    ]);
    expect(container.textContent).toContain("conversation-only");
    expect(container.textContent).not.toContain("run.compaction_boundary_diverged");
  });
});
