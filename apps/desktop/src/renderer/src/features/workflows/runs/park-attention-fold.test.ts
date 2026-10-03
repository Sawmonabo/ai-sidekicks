// The fold fails closed: an entry says a person is needed unless every park in it armed a
// readable resume. Taken through `RunListProjection`, which owns the fold.

import { describe, expect, it } from "vitest";

import { type WorkflowParkAttentionEntry } from "./park-attention-fold.js";
import { RunListProjection } from "./run-list-projection.js";
import type { WorkflowPhaseStateRow, WorkflowRunSnapshot } from "./run-list-rows.js";
import { phase, run } from "./run-list-projection.test-support.js";

/** One phase parked against a named provider account, as the engine stamps it. */
function correlatedPark(
  phaseId: string,
  parkAttentionKey: string,
  overrides: Partial<WorkflowPhaseStateRow> = {},
): WorkflowPhaseStateRow {
  return phase({
    phaseId,
    parkReason: "provider-usage-limited",
    parkCause: "The account's window is spent.",
    parkAttentionKey,
    ...overrides,
  });
}

/** The fold over a set of runs, taken through the projection that owns it. */
function foldOf(runs: readonly WorkflowRunSnapshot[]): readonly WorkflowParkAttentionEntry[] {
  return new RunListProjection(runs).parkAttention;
}

describe("the park attention fold — the amber", () => {
  it("spends amber on a fold where ANY park needs a person", () => {
    // Fail-closed: the armed park alone would have earned no color.
    const entries = foldOf([
      run({
        workflowRunId: "run-a",
        phaseStates: [
          correlatedPark("draft", "account-1", { autoResumeAt: "2026-09-01T11:00:00.000Z" }),
        ],
      }),
      run({ workflowRunId: "run-b", phaseStates: [correlatedPark("draft", "account-1")] }),
    ]);

    expect(entries[0]).toMatchObject({ awaitsPerson: true });
  });

  it("treats an unreadable resume instant as a wait on a person", () => {
    // `parkAwaitsPerson` folds `unreadable` in with `unscheduled`: nothing legible says it resumes
    // itself.
    const entries = foldOf([
      run({
        workflowRunId: "run-a",
        phaseStates: [
          correlatedPark("draft", "account-1", { autoResumeAt: "2026-02-30T10:00:00Z" }),
        ],
      }),
    ]);

    expect(entries[0]).toMatchObject({ awaitsPerson: true });
  });
});
