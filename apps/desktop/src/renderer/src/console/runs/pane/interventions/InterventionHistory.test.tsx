// The history keeps the attempts that failed, and says what it cannot see.
//
// Two claims, and the second is the one that keeps this surface honest: a refused
// control is a ROW rather than an omission, because interventions require durable
// audit records even when they fail; and the surface states plainly that the
// durable record — with the `origin` discriminator and the admitting principal —
// is not something it can read, rather than inferring either.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RollbackCompositeRejectionGuard } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { createFixture } from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { refuse } from "../../../core/index.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
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

function renderHistory(
  records: readonly RunControlRecord[],
  bridge: ConsoleBridge = createFixture().bridge,
): HTMLElement {
  const { container } = render(
    // A real fixture bridge rather than a stub: the list holds the path action a
    // settled rollback's enumerations offer, and a hand-built object would let a
    // change to that seam's shape pass here and fail in the window.
    <InterventionHistory records={records} runId={RUN_ID} bridge={bridge} />,
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

/** The path the single-record restore cases open and copy. */
const RESTORED_PATH = "/Users/dev/code/one/.env.local";

/**
 * A settled rollback that restored files, with both enumerations non-empty.
 *
 * The overwritten path is a parameter because the keying cases need two records whose
 * enumerations are distinguishable — a control is found by its accessible name, and
 * two rows offering the same path would leave the case unable to say which row it
 * pressed.
 */
function restoredRollbackRecord(
  recordId: string,
  overwrittenPath: string = RESTORED_PATH,
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
        state: "applied",
        runVersion: 14,
        result: {
          disposition: "files-restored",
          overwrittenIgnoredPaths: [overwrittenPath],
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

/** The two records the keying cases press, each offering its own path. */
const FIRST_ROW_PATH = "/Users/dev/code/one/first.env";
const SECOND_ROW_PATH = "/Users/dev/code/one/second.env";

/**
 * The shipped fixture with its clipboard refusing, and nothing else replaced.
 *
 * Composed over the real bridge rather than hand-built for the reason `renderHistory`
 * states: the list reaches this seam through the path action, and a stub object would
 * let a change to that seam's shape pass here and fail in the window.
 */
function bridgeRefusingClipboard(): ConsoleBridge {
  const { bridge } = createFixture();
  return {
    ...bridge,
    sidekicks: {
      ...bridge.sidekicks,
      native: {
        ...bridge.sidekicks.native,
        copyToClipboard: async (): Promise<void> => {
          throw new Error("the clipboard is unavailable");
        },
      },
    },
  } as ConsoleBridge;
}

/** Open every enumeration, then press the control offering exactly this path. */
async function copyPathThrough(container: HTMLElement, path: string): Promise<void> {
  for (const detail of container.querySelectorAll("details")) {
    detail.open = true;
    fireEvent(detail, new Event("toggle"));
  }
  const control = container.querySelector<HTMLButtonElement>(`[aria-label="Copy path ${path}"]`);
  if (control === null) {
    throw new Error(`no path control offered ${path}, so there is nothing to press`);
  }
  await act(async () => {
    fireEvent.click(control);
    // A boundary and not a counted microtask: the rejection travels through the
    // normalizer and a state publish, and a chain one link deeper would leave every
    // case below asserting about a refusal that had not landed yet.
    await crossMacrotaskBoundary();
  });
}

/** Which rows are showing an inline refusal, by their position in the list. */
function rowsShowingRefusal(container: HTMLElement): readonly number[] {
  return [...container.querySelectorAll(".meridian-interventions__row")].flatMap((row, position) =>
    row.querySelector(".meridian-refusal--inline") === null ? [] : [position],
  );
}

describe("a copy refusal belongs to the row that raised it", () => {
  it("shows the host's refusal under that row and under no other", async () => {
    // The defect. One history-level refusal was handed to every row, so a single
    // failed copy drew the same failure beneath every rollback's paths — telling a
    // person that actions they never took had failed.
    const container = renderHistory(
      [
        restoredRollbackRecord("one", FIRST_ROW_PATH),
        restoredRollbackRecord("two", SECOND_ROW_PATH),
      ],
      bridgeRefusingClipboard(),
    );
    expect(container.querySelectorAll(".meridian-interventions__row")).toHaveLength(2);

    await copyPathThrough(container, SECOND_ROW_PATH);

    expect(rowsShowingRefusal(container)).toStrictEqual([1]);
  });

  it("moves with the next press rather than accumulating", async () => {
    // The refusal is the answer to the LAST action, so pressing the other row's
    // control moves it. A key that only ever added would leave the first row
    // reporting a failure the daemon has been asked nothing about since.
    const container = renderHistory(
      [
        restoredRollbackRecord("one", FIRST_ROW_PATH),
        restoredRollbackRecord("two", SECOND_ROW_PATH),
      ],
      bridgeRefusingClipboard(),
    );

    await copyPathThrough(container, SECOND_ROW_PATH);
    await copyPathThrough(container, FIRST_ROW_PATH);

    expect(rowsShowingRefusal(container)).toStrictEqual([0]);
  });

  it("negative control: no row shows one before anything was pressed", async () => {
    // Without this the cases above would be satisfied by a component that never
    // rendered a refusal at all, which is a different bug with the same reading.
    const container = renderHistory(
      [
        restoredRollbackRecord("one", FIRST_ROW_PATH),
        restoredRollbackRecord("two", SECOND_ROW_PATH),
      ],
      bridgeRefusingClipboard(),
    );

    expect(rowsShowingRefusal(container)).toStrictEqual([]);

    await copyPathThrough(container, FIRST_ROW_PATH);

    expect(rowsShowingRefusal(container)).toStrictEqual([0]);
  });
});
