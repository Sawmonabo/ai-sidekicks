// What THIS WINDOW dispatched: the attempts that failed, and the settlements that
// carry more than the daemon's own row does.
//
// The half of the history the durable read does not cover, and the split is the same
// one the surface makes. A refused control is a ROW rather than an omission, because
// interventions require durable audit records even when they fail; a degraded
// settlement is never a success; and a rewind that touched the working tree discloses
// its two path enumerations here and nowhere else. The daemon's own rows — the
// `origin` discriminator, the admitting principal, the queue-item linkage, the
// directive body, and what the surface renders when that read refuses — are
// `InterventionHistory.durable.test.tsx`'s, and the one case below is this side's
// negative control for them. Which row a failed COPY belongs to is the one action
// these rows offer, and `InterventionHistory.copy.test.tsx` drives it.

import { act, fireEvent } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import type { RollbackCompositeRejectionGuard } from "@ai-sidekicks/contracts";

import { refuse } from "../../../core/index.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { resolveFileRestoreDisclosure } from "../controls/file-restore-mount.test-support.js";
import {
  INTERVENTION_ID,
  RESTORED_PATH,
  renderHistory,
  restoredRollbackRecord,
} from "./intervention-history.test-support.js";
import type { RunControlRecord } from "../controls/run-control-surface.js";
import { OTHER_RUN_ID, RUN_ID } from "../runs-pane.test-support.js";

// The working-tree half of a settled rollback arrives on its own chunk, so this file
// warms it ONCE before anything renders — through the mount's own wait home, which is
// where `apps/desktop/AGENTS.md` §Tests puts it. After this the mount renders the settled
// body directly, so `renderHistory` stays synchronous and every case reads the
// disclosure it means to. Asked for the whole file rather than in the three cases that
// touch it: a warm memo costs a resolved promise, and a case added later that forgets
// would assert an absence the fetch produced.
beforeAll(async () => {
  await resolveFileRestoreDisclosure();
});

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

describe("failed attempts are part of the record", () => {
  it("renders a refused control as a row carrying its code verbatim", () => {
    const container = renderHistory([refusedRecord("one", RUN_ID)]);
    expect(container.querySelectorAll(".meridian-interventions__row")).toHaveLength(1);
    expect(container.textContent).toContain("run.invalid_transition");
    expect(container.textContent).toContain("the run has already completed");
  });

  it("puts the rows under a name saying they are this window's, not the run's", () => {
    // The history draws two lists and the same intervention can appear in both, from
    // two sides. Unnamed, that reads as one intervention listed twice — so the caption
    // is on screen, and the list takes it as its accessible name rather than carrying
    // a second label of its own.
    const container = renderHistory([refusedRecord("one", RUN_ID)]);
    const caption = container.querySelector(".meridian-interventions__source-name");
    expect(caption?.textContent).toContain("Sent from this window");
    expect(
      container.querySelector(".meridian-interventions__rows")?.getAttribute("aria-labelledby"),
    ).toBe(caption?.id);
  });

  it("negative control: a row for another run is not this run's history", () => {
    // Without this the case above would pass over a component that rendered every
    // record it was handed, which would attribute one run's interventions to another.
    const container = renderHistory([refusedRecord("two", OTHER_RUN_ID)]);
    expect(container.querySelectorAll(".meridian-interventions__row")).toHaveLength(0);
  });
});

describe("the dispatched half infers nothing the durable read carries", () => {
  it("never infers an origin the read did not carry", async () => {
    // The discriminator is resolved by the daemon and never inferred. Under a refused
    // read there is no arm to render, so neither word appears at all — which is the
    // negative control for the durable suite, where both do.
    const container = renderHistory([refusedRecord("three", RUN_ID)]);
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(container.textContent).not.toContain("admitting principal");
    expect(container.querySelector(".meridian-interventions__directive")).toBeNull();
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
    expect(link?.getAttribute("aria-label")).toBe(`Copy path ${RESTORED_PATH}`);
  });

  it("renders no working-tree section for a disposition that mutated no file", () => {
    // The mount is on the reading's own "this arm carries enumerations" answer and
    // never on a disposition name, and `boundary-diverged` carries none.
    const container = renderHistory([degradedRollbackRecord("one")]);
    expect(container.querySelector(".meridian-restore-disclosure")).toBeNull();
  });
});

/**
 * A rejected rollback, with the daemon's typed guard where it raised one.
 *
 * The cause is deliberately opaque prose that names no guard: `rejectionReason` is a
 * free-form wire string with no registered vocabulary, so a remedy read out of it was
 * a match against a value set no contract publishes. `rejectionGuard` is the closed
 * four-value discriminator the contract does publish, and it is what these cases
 * drive.
 */
function rejectedRollbackRecord(
  recordId: string,
  rejectionGuard?: RollbackCompositeRejectionGuard,
): RunControlRecord {
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
        state: "rejected",
        runVersion: 12,
        rejectionReason: OPAQUE_REJECTION_CAUSE,
        ...(rejectionGuard === undefined ? {} : { rejectionGuard }),
      },
    },
  };
}

/** A machine-readable cause carrying none of the four guard names. */
const OPAQUE_REJECTION_CAUSE = "rollback.refused_precondition";

describe("the composite's guard prose comes from the typed guard", () => {
  it("names the check and its remedy however the cause is worded", () => {
    // The defect: the remedy was inferred from `rejectionReason`, so a daemon that
    // supplied an exact typed answer beside a cause whose wording carries no guard
    // name got no remedy at all.
    const container = renderHistory([rejectedRollbackRecord("one", "no-pending-send")]);

    expect(container.textContent).toContain("An earlier send is still pending on this run");
    expect(container.textContent).toContain("Cancel the queued items");
  });

  it("renders the daemon's own cause beside the remedy, never instead of it", () => {
    const container = renderHistory([rejectedRollbackRecord("two", "no-active-turn")]);

    expect(container.textContent).toContain(OPAQUE_REJECTION_CAUSE);
    expect(container.textContent).toContain("Pause or stop the run first");
  });

  it("negative control: a rejection carrying no guard gets the daemon's words alone", () => {
    // The four guards belong to the atomic edit-and-resend, and the wire says so by
    // populating the member. A rejection from any other refusal family carries none,
    // and inventing one would tell its author to drain a queue that has nothing in it.
    const container = renderHistory([rejectedRollbackRecord("three")]);

    expect(container.textContent).toContain(OPAQUE_REJECTION_CAUSE);
    expect(container.textContent).not.toContain("An earlier send is still pending on this run");
    expect(container.textContent).not.toContain("Cancel the queued items");
  });
});
