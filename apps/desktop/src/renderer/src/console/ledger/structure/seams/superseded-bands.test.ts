// Superseded bands, held to the off-by-one and the epoch blindness that still render.
//
// A band off by one dims the exact turn a person rewound to — which is the turn they
// are looking at — and an epoch-blind band dims another run's rows, because
// re-execution reuses ordinals. Neither throws, so each clean assertion here is
// paired with a negative control that fails when the rule is removed.
//
// SPLIT FROM `seams.test.ts`, which drives the seam classifier. The two share no
// table (`seams.ts` states why), so they are two subjects rather than one file.

import { type TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  generalRow,
  legacyStubRow,
  rollbackBoundaryRow,
  runRow,
} from "../timeline-rows.test-support.js";
import { SupersededIndex, deriveSupersededBands, supersededBandKey } from "./superseded-bands.js";

describe("superseded bands — the rewind floor is EXCEEDS and nothing else", () => {
  /** Three turns and a boundary that rewound to the second of them. */
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

  it("negative control: the row AT the cutoff is the retained floor and survives", () => {
    // Off by one here dims the exact turn a person rewound to — which is the turn
    // they are looking at.
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

  it("negative control: a boundary in one run never reaches another run's rows", () => {
    const index = new SupersededIndex([
      ...rewoundWindow(),
      runRow({ id: "b9", sequence: 6, type: "run.running", runId: "run-b", position: 9 }),
    ]);
    expect(index.isSuperseded("b9")).toBe(false);
  });

  it("never ranks a legacy stub or a session-scoped row", () => {
    // Structural, not filtered: neither arm carries a position at all.
    const index = new SupersededIndex([
      ...rewoundWindow(),
      legacyStubRow({ id: "stub", sequence: 7, type: "event.compacted", runId: "run-a" }),
      generalRow({ id: "g1", sequence: 8, type: "session.renamed", category: "session_lifecycle" }),
    ]);
    expect(index.isSuperseded("stub")).toBe(false);
    expect(index.isSuperseded("g1")).toBe(false);
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
    // `SupersededMarker` is defined as the FIRST accepted rollback that rewound
    // the surviving history containing the row, so a later, higher cutoff never
    // displaces an earlier, lower one.
    const bands = deriveSupersededBands([
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

  it("is idempotent over one window, because it derives a set and accumulates nothing", () => {
    const rows = rewoundWindow();
    const first = deriveSupersededBands(rows).flatMap((band) => band.rowIds);
    const second = deriveSupersededBands(rows).flatMap((band) => band.rowIds);
    expect(second).toStrictEqual(first);
  });

  it("computes its bands once and answers from them", () => {
    const index = new SupersededIndex(rewoundWindow());
    expect(index.bands()).toBe(index.bands());
  });

  it("keys every band by the header key the feed dispatches on", () => {
    const index = new SupersededIndex(rewoundWindow());
    const [band] = index.bands();
    if (band === undefined) {
      throw new Error("the rewound window derived no band");
    }
    expect(index.bandByHeaderKey().get(supersededBandKey(band))).toBe(band);
  });

  it("answers which band each superseded row belongs to, and no other row", () => {
    const index = new SupersededIndex(rewoundWindow());
    const [band] = index.bands();
    if (band === undefined) {
      throw new Error("the rewound window derived no band");
    }
    expect(index.bandKeyByRowId().get("a3")).toBe(supersededBandKey(band));
    // The retained floor and the turns before it are in no band at all, so the fold
    // can never take a row the rewind left standing.
    expect(index.bandKeyByRowId().has("a2")).toBe(false);
    expect(index.bandKeyByRowId().has("a1")).toBe(false);
  });

  it("keeps two rewinds of one epoch apart, and both apart from a bare run id", () => {
    // The key shares one map with the chapter header's, which IS a bare run id, so a
    // collision here would draw a rewind band where a chapter belongs.
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
    const keys = [...index.bandByHeaderKey().keys()];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("run-a");
    expect(keys.every((key) => key.startsWith("superseded "))).toBe(true);
  });
});
