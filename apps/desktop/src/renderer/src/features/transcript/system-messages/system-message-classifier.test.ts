// The epoch rule, held to the reads that fail silently: a boundary read off the wrong member
// still draws a seam, so each clean assertion is paired with a negative control.

import { AGENT_PROVIDER_BINDING_CHANGED_EVENT, type TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { generalRow, rollbackBoundaryRow, runRow } from "../timeline-rows.test-support.js";
import { SystemMessageClassifier, type SystemMessageReading } from "./system-message-classifier.js";

function classifyOne(row: TimelineRow): SystemMessageReading {
  const seam = new SystemMessageClassifier().classify(row);
  if (seam === undefined) {
    throw new Error(`expected ${row.type} to classify as a seam`);
  }
  return seam;
}

describe("seams — one row's classification", () => {
  it("reads the rollback boundary's cutoff through the arm's own typed payload", () => {
    const seam = classifyOne(
      rollbackBoundaryRow({
        id: "rb",
        sequence: 9,
        runId: "run-a",
        position: 6,
        targetPosition: 2,
      }),
    );
    expect(seam.kind).toBe("rollback");
    expect(seam.boundaryPosition).toBe(2);
  });

  it("reads a compaction's boundary off the row's own run-scoped position", () => {
    // `usage.context_compacted` names no boundary member in any registered payload; the carrier
    // is the run arm's `position`, the comparand a rollback cutoff ranks against.
    const seam = classifyOne(
      runRow({
        id: "c1",
        sequence: 3,
        type: "usage.context_compacted",
        category: "usage_telemetry",
        runId: "run-a",
        position: 7,
      }),
    );
    expect(seam.kind).toBe("compaction");
    expect(seam.boundaryPosition).toBe(7);
  });

  it("negative control: a payload member of that name is not what is read", () => {
    // Position and payload member are deliberately different numbers: a payload read answers
    // 99, and a boundary hard-coded to the position would answer 3 either way.
    const seam = classifyOne(
      runRow({
        id: "c1b",
        sequence: 3,
        type: "usage.context_compacted",
        category: "usage_telemetry",
        runId: "run-a",
        position: 3,
        payload: { boundaryPosition: 99 },
      }),
    );
    expect(seam.boundaryPosition).toBe(3);
  });

  it("carries a switch's declared losses verbatim", () => {
    const seam = classifyOne(
      runRow({
        id: "s1",
        sequence: 5,
        type: AGENT_PROVIDER_BINDING_CHANGED_EVENT,
        runId: "run-a",
        position: 5,
        payload: {
          continuity: "brief",
          declaredLosses: ["turn_content_truncated", "a_kind_this_console_has_never_heard_of"],
        },
      }),
    );
    expect(seam.continuity).toBe("brief");
    // Verbatim, unknown member included, so a newly added kind of loss is still reported.
    expect(seam.declaredLosses).toStrictEqual([
      "turn_content_truncated",
      "a_kind_this_console_has_never_heard_of",
    ]);
  });

  it("negative control: an ordinary row is not a seam", () => {
    const index = new SystemMessageClassifier();
    expect(
      index.classify(
        runRow({ id: "r1", sequence: 1, type: "run.running", runId: "run-a", position: 1 }),
      ),
    ).toBeUndefined();
    expect(
      index.classify(
        generalRow({
          id: "g1",
          sequence: 2,
          type: "session.renamed",
          category: "session_lifecycle",
        }),
      ),
    ).toBeUndefined();
  });

  it("collects a window's seams in log order", () => {
    const seams = new SystemMessageClassifier().seams([
      runRow({ id: "r1", sequence: 1, type: "run.running", runId: "run-a", position: 1 }),
      runRow({
        id: "c1",
        sequence: 2,
        type: "usage.context_compacted",
        category: "usage_telemetry",
        runId: "run-a",
        position: 2,
      }),
      rollbackBoundaryRow({
        id: "rb",
        sequence: 3,
        runId: "run-a",
        position: 3,
        targetPosition: 1,
      }),
    ]);
    expect(seams.map((seam) => seam.rowId)).toStrictEqual(["c1", "rb"]);
    expect(seams.map((seam) => seam.kind)).toStrictEqual(["compaction", "rollback"]);
  });
});
