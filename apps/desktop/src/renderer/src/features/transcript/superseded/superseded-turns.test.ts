// An off-by-one band dims the turn the person rewound to, and an epoch-blind band dims another
// run's rows (re-execution reuses ordinals). Neither throws, so each band is asserted from
// both sides.

import { type TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { rollbackBoundaryRow, runRow } from "../timeline-rows.test-support.js";
import { SupersededIndex, deriveSupersededTurns, supersededTurnsKey } from "./superseded-turns.js";

describe("superseded turns — the rewind floor is EXCEEDS and nothing else", () => {
  function rewoundWindow(): readonly TimelineRow[] {
    return [
      runRow({ id: "a1", sequence: 1, type: "run.running", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.running", runId: "run-a", position: 2 }),
      runRow({ id: "a3", sequence: 3, type: "run.running", runId: "run-a", position: 3 }),
      rollbackBoundaryRow({
        id: "rb",
        sequence: 4,
        runId: "run-a",
        position: 4,
        targetPosition: 2,
      }),
    ];
  }

  it("marks the row past the cutoff", () => {
    const index = new SupersededIndex(rewoundWindow());
    expect(index.isSuperseded("a3")).toBe(true);
  });

  it("the row AT the cutoff is the retained floor and survives", () => {
    // Off by one here dims the exact turn the person rewound to.
    const index = new SupersededIndex(rewoundWindow());
    expect(index.isSuperseded("a2")).toBe(false);
    expect(index.isSuperseded("a1")).toBe(false);
  });

  it("scopes marks to the epoch, because re-execution reuses ordinals", () => {
    const index = new SupersededIndex([
      ...rewoundWindow(),
      // Same run, same ordinal, second epoch: a fresh attempt at position 3.
      runRow({
        id: "a3-again",
        sequence: 5,
        type: "run.running",
        runId: "run-a",
        position: 3,
        epoch: 1,
      }),
    ]);
    expect(index.isSuperseded("a3")).toBe(true);
    expect(index.isSuperseded("a3-again")).toBe(false);
  });

  it("a boundary in one run never reaches another run's rows", () => {
    const index = new SupersededIndex([
      ...rewoundWindow(),
      runRow({ id: "b9", sequence: 6, type: "run.running", runId: "run-b", position: 9 }),
    ]);
    expect(index.isSuperseded("b9")).toBe(false);
  });

  it("marks a row that arrived already carrying its own cutoff, with no boundary in the window", () => {
    const index = new SupersededIndex([
      runRow({
        id: "pre",
        sequence: 1,
        type: "run.running",
        runId: "run-a",
        position: 3,
        supersededTargetPosition: 1,
      }),
    ]);
    expect(index.isSuperseded("pre")).toBe(true);
  });

  it("takes the LOWEST applicable cutoff when a row is reached by two", () => {
    // The first accepted rollback wins: a later, higher cutoff never displaces an earlier one.
    const bands = deriveSupersededTurns([
      runRow({
        id: "a5",
        sequence: 1,
        type: "run.running",
        runId: "run-a",
        position: 5,
        supersededTargetPosition: 4,
      }),
      rollbackBoundaryRow({
        id: "rb",
        sequence: 2,
        runId: "run-a",
        position: 6,
        targetPosition: 2,
      }),
    ]);
    const bandForRow = bands.find((band) => band.rowIds.includes("a5"));
    expect(bandForRow?.targetPosition).toBe(2);
  });

  it("answers which band each superseded row belongs to, and no other row", () => {
    const index = new SupersededIndex(rewoundWindow());
    const [band] = index.supersededTurns();
    if (band === undefined) {
      throw new Error("the rewound window derived no band");
    }
    expect(index.supersededTurnsKeyByRowId().get("a3")).toBe(supersededTurnsKey(band));
    // The retained floor and earlier turns are in no band, so the fold never takes them.
    expect(index.supersededTurnsKeyByRowId().has("a2")).toBe(false);
    expect(index.supersededTurnsKeyByRowId().has("a1")).toBe(false);
  });

  it("keeps two rewinds of one epoch apart, and both apart from a bare run id", () => {
    // The key shares one map with run group header keys (bare run ids); a collision would draw a
    // rewind band where a run group belongs.
    const index = new SupersededIndex([
      runRow({ id: "a2", sequence: 1, type: "run.running", runId: "run-a", position: 2 }),
      runRow({ id: "a4", sequence: 2, type: "run.running", runId: "run-a", position: 4 }),
      rollbackBoundaryRow({
        id: "rb-3",
        sequence: 3,
        runId: "run-a",
        position: 5,
        targetPosition: 3,
      }),
      rollbackBoundaryRow({
        id: "rb-1",
        sequence: 4,
        runId: "run-a",
        position: 6,
        targetPosition: 1,
      }),
    ]);
    const keys = [...index.supersededTurnsByHeaderKey().keys()];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("run-a");
    expect(keys.every((key) => key.startsWith("superseded "))).toBe(true);
  });
});
