// The history keeps the attempts that failed, and says what it cannot see.
//
// Two claims, and the second is the one that keeps this surface honest: a refused
// control is a ROW rather than an omission, because interventions require durable
// audit records even when they fail; and the surface states plainly that the
// durable record — with the `origin` discriminator and the admitting principal —
// is not something it can read, rather than inferring either.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixture } from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { refuse } from "../../../core/index.js";
import { InterventionHistory } from "./InterventionHistory.js";
import type { RunControlRecord } from "../controls/run-control-surface.js";
import { OTHER_RUN_ID, RUN_ID } from "../runs-pane.test-support.js";

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
  const { container } = render(
    // A real fixture bridge rather than a stub: the list holds the path action a
    // settled rollback's enumerations offer, and a hand-built object would let a
    // change to that seam's shape pass here and fail in the window.
    <InterventionHistory records={records} runId={RUN_ID} bridge={createFixture().bridge} />,
  );
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
    // The discriminator is resolved and never inferred, per this component's own
    // header. The honest form of that here is that neither word appears at all.
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

/** A settled rollback that restored files, with both enumerations non-empty. */
function restoredRollbackRecord(recordId: string): RunControlRecord {
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
        state: "applied",
        runVersion: 14,
        result: {
          disposition: "files-restored",
          overwrittenIgnoredPaths: ["/Users/dev/code/one/.env.local"],
          divergentGitlinks: ["/Users/dev/code/one/vendor/sdk"],
        },
      },
    },
  };
}

describe("a rewind that mutated the working tree is disclosed here", () => {
  it("renders both never-silent enumerations for a restore", () => {
    // The three dispositions that carry enumerations ride this list, so this is the
    // surface that owes a person the two path lists. Before this mount the runs pane
    // drew its own shorter copy and no path in it was reachable.
    const container = renderHistory([restoredRollbackRecord("one")]);
    expect(container.querySelector(".meridian-restore-disclosure")).not.toBeNull();
    expect(container.textContent).toContain("Overwritten ignored paths");
    expect(container.textContent).toContain("Divergent gitlinks");
  });

  it("makes every enumerated path a control that names what it does", async () => {
    const container = renderHistory([restoredRollbackRecord("one")]);
    const disclosures = [...container.querySelectorAll("details")];
    const overwritten = disclosures[0];
    if (overwritten === undefined) {
      throw new Error("the restore disclosure rendered no enumeration to open");
    }
    overwritten.open = true;
    fireEvent(overwritten, new Event("toggle"));
    const link = container.querySelector<HTMLButtonElement>(
      ".meridian-restore-disclosure__path-link",
    );
    expect(link).not.toBeNull();
    // The verb AND the path: the path alone says what the control is about and
    // never what activating it does.
    expect(link?.getAttribute("aria-label")).toBe("Copy path /Users/dev/code/one/.env.local");
  });

  it("renders no working-tree section for a disposition that mutated no file", () => {
    // The mount is on the reading's own "this arm carries enumerations" answer and
    // never on a disposition name, and `boundary-diverged` carries none.
    const container = renderHistory([degradedRollbackRecord("one")]);
    expect(container.querySelector(".meridian-restore-disclosure")).toBeNull();
  });
});
