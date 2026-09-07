// The fold's four claims: what folds, what does not, what the count counts, and what
// order the entries come out in.
//
// Driven through `RunListProjection` rather than through `foldParkAttention` alone
// wherever the claim is about ORDER or about the badge, because those are properties
// of the pair — the fold walks rows the projection has already sorted, and a suite
// that fed it a hand-built array would prove the fold and leave the seam unchecked.
// The two claims that are purely about the fold's own arithmetic take it directly.

import { describe, expect, it } from "vitest";

import { foldParkAttention, type WorkflowParkAttentionEntry } from "./park-attention-fold.js";
import { RunListProjection } from "./run-list-projection.js";
import { projectParkedPhases } from "./run-list-projection.js";
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

/** One phase parked with no key, which is a wait the engine could not correlate. */
function uncorrelatedPark(phaseId: string): WorkflowPhaseStateRow {
  return phase({
    phaseId,
    parkReason: "waiting-human",
    parkCause: "Waiting for sign-off.",
  });
}

/** The fold over a set of runs, taken through the projection that owns it. */
function foldOf(runs: readonly WorkflowRunSnapshot[]): readonly WorkflowParkAttentionEntry[] {
  return new RunListProjection(runs).parkAttention;
}

describe("the park attention fold — what folds", () => {
  it("renders concurrently parked runs sharing a key as ONE entry", () => {
    const entries = foldOf([
      run({ workflowRunId: "run-a", phaseStates: [correlatedPark("draft", "account-1")] }),
      run({ workflowRunId: "run-b", phaseStates: [correlatedPark("draft", "account-1")] }),
      run({ workflowRunId: "run-c", phaseStates: [correlatedPark("draft", "account-1")] }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toStrictEqual({
      kind: "folded",
      parkAttentionKey: "account-1",
      affectedRunCount: 3,
      parkReasons: ["provider-usage-limited"],
      // No park in this fold armed a resume, so every one of them ends when a person
      // ends it — which is what the amber says, and the fold agrees with each badge
      // under it rather than deciding separately.
      awaitsPerson: true,
    });
  });

  it("counts DISTINCT runs, so one run's two parked branches are one affected run", () => {
    // The defect this exists to prevent: a fan-out parks two phases against one
    // account, and an entry reporting "2 runs affected" is a figure an operator
    // cannot reconcile against the single row underneath it.
    const entries = foldOf([
      run({
        workflowRunId: "run-a",
        phaseStates: [correlatedPark("left", "account-1"), correlatedPark("right", "account-1")],
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "folded", affectedRunCount: 1 });
  });

  it("keeps two different keys as two entries", () => {
    const entries = foldOf([
      run({ workflowRunId: "run-a", phaseStates: [correlatedPark("draft", "account-1")] }),
      run({ workflowRunId: "run-b", phaseStates: [correlatedPark("draft", "account-2")] }),
    ]);

    expect(entries.map((entry) => entry.kind === "folded" && entry.parkAttentionKey)).toStrictEqual(
      ["account-1", "account-2"],
    );
  });

  it("carries every reason the fold spans, distinct and in first-encounter order", () => {
    const entries = foldOf([
      run({ workflowRunId: "run-a", phaseStates: [correlatedPark("draft", "account-1")] }),
      run({
        workflowRunId: "run-b",
        phaseStates: [
          correlatedPark("sign-off", "account-1", {
            parkReason: "waiting-human",
            parkCause: "Waiting for sign-off.",
          }),
        ],
      }),
      run({ workflowRunId: "run-c", phaseStates: [correlatedPark("draft", "account-1")] }),
    ]);

    expect(entries[0]).toMatchObject({
      parkReasons: ["provider-usage-limited", "waiting-human"],
      affectedRunCount: 3,
    });
  });
});

describe("the park attention fold — what does not fold", () => {
  it("gives an uncorrelated park its own entry rather than a no-key bucket", () => {
    // Fails open toward more entries: the engine declined to correlate these, and a
    // renderer that grouped them anyway would invent a correlation nobody stated.
    const entries = foldOf([
      run({ workflowRunId: "run-a", phaseStates: [uncorrelatedPark("sign-off")] }),
      run({ workflowRunId: "run-b", phaseStates: [uncorrelatedPark("sign-off")] }),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.kind)).toStrictEqual(["uncorrelated", "uncorrelated"]);
    expect(entries[0]).toMatchObject({ kind: "uncorrelated", workflowRunId: "run-a" });
    expect(entries[1]).toMatchObject({ kind: "uncorrelated", workflowRunId: "run-b" });
  });

  it("never folds a keyed park together with an unkeyed one", () => {
    const entries = foldOf([
      run({ workflowRunId: "run-a", phaseStates: [correlatedPark("draft", "account-1")] }),
      run({ workflowRunId: "run-b", phaseStates: [uncorrelatedPark("sign-off")] }),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "folded", affectedRunCount: 1 });
    expect(entries[1]).toMatchObject({ kind: "uncorrelated", workflowRunId: "run-b" });
  });

  it("is empty when nothing is parked", () => {
    const projection = new RunListProjection([run({ workflowRunId: "run-a" })]);

    expect(projection.parkAttention).toStrictEqual([]);
    expect(projection.parkAttentionCount).toBe(0);
  });
});

describe("the park attention fold — the badge count", () => {
  it("counts entries and not the runs they stand for", () => {
    // The claim the badge exists for. Three runs on one account are ONE thing to
    // look at; the parked-run count beside it is the other question and answers 3.
    const projection = new RunListProjection([
      run({ workflowRunId: "run-a", phaseStates: [correlatedPark("draft", "account-1")] }),
      run({ workflowRunId: "run-b", phaseStates: [correlatedPark("draft", "account-1")] }),
      run({ workflowRunId: "run-c", phaseStates: [correlatedPark("draft", "account-1")] }),
    ]);

    expect(projection.parkAttentionCount).toBe(1);
    expect(projection.parkedRunCount).toBe(3);
  });
});

describe("the park attention fold — the amber", () => {
  it("spends amber on a fold where ANY park needs a person", () => {
    // Fail-closed: an entry standing for two waits, one of which nobody will end on
    // its own, needs somebody. The armed park alone would have earned no colour.
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

  it("spends none where every park in the fold armed a readable resume", () => {
    const entries = foldOf([
      run({
        workflowRunId: "run-a",
        phaseStates: [
          correlatedPark("draft", "account-1", { autoResumeAt: "2026-09-01T11:00:00.000Z" }),
        ],
      }),
      run({
        workflowRunId: "run-b",
        phaseStates: [
          correlatedPark("draft", "account-1", { autoResumeAt: "2026-09-01T11:30:00.000Z" }),
        ],
      }),
    ]);

    expect(entries[0]).toMatchObject({ awaitsPerson: false });
  });

  it("treats an unreadable resume instant as a wait on a person", () => {
    // The projection classifies a present-but-malformed instant `unreadable`, which
    // `parkAwaitsPerson` folds in with `unscheduled` — nothing legible says this
    // resumes itself, so the fold must not report it as a machine waiting.
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

describe("the park attention fold — order", () => {
  it("places a fold where its FIRST park was met, in the list's own order", () => {
    // The rows arrive attention-first and newest-first inside a band, so an entry
    // folding several runs sits where the run an operator meets first sits.
    const entries = foldOf([
      run({
        workflowRunId: "run-old",
        startedAt: "2026-09-01T08:00:00.000Z",
        phaseStates: [correlatedPark("draft", "account-2")],
      }),
      run({
        workflowRunId: "run-new",
        startedAt: "2026-09-01T12:00:00.000Z",
        phaseStates: [correlatedPark("draft", "account-1")],
      }),
      run({
        workflowRunId: "run-mid",
        startedAt: "2026-09-01T10:00:00.000Z",
        phaseStates: [correlatedPark("draft", "account-1")],
      }),
    ]);

    // `account-1` first because the newest run carries it, and it holds two runs.
    expect(entries.map((entry) => entry.kind === "folded" && entry.parkAttentionKey)).toStrictEqual(
      ["account-1", "account-2"],
    );
    expect(entries[0]).toMatchObject({ affectedRunCount: 2 });
  });

  it("negative control: a fold is settled AFTER the whole walk, not at its first park", () => {
    // Without the settle-at-the-end rule the first entry would carry the count as it
    // stood when its slot was taken — one — while the rows below it showed three.
    const entries = foldOf([
      run({ workflowRunId: "run-a", phaseStates: [correlatedPark("draft", "account-1")] }),
      run({ workflowRunId: "run-b", phaseStates: [correlatedPark("draft", "account-1")] }),
      run({ workflowRunId: "run-c", phaseStates: [correlatedPark("draft", "account-1")] }),
    ]);

    expect(entries[0]).toMatchObject({ affectedRunCount: 3 });
  });
});

describe("the park attention fold — taken directly", () => {
  it("reads a run's identity off the caller and its parks off the projection", () => {
    // The one case that drives `foldParkAttention` alone: it takes parked phases and
    // a run id rather than snapshots, so a caller holding neither builds neither.
    const parkedPhases = projectParkedPhases([correlatedPark("draft", "account-1")]);

    expect(foldParkAttention([{ workflowRunId: "run-a", parkedPhases }])).toStrictEqual([
      {
        kind: "folded",
        parkAttentionKey: "account-1",
        affectedRunCount: 1,
        parkReasons: ["provider-usage-limited"],
        awaitsPerson: true,
      },
    ]);
  });

  it("is empty for a run with no parked phases", () => {
    expect(foldParkAttention([{ workflowRunId: "run-a", parkedPhases: [] }])).toStrictEqual([]);
  });
});
